import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { ProxyAgent, type Dispatcher } from 'undici'
import type { AppDatabase } from '../database/Database'
import { AppError } from '../errors'
import type { Logger } from '../logging/Logger'

export interface DownloadRequest {
  packageId: string
  version: string
  url: string
  checksum: string
  algorithm: 'sha256' | 'sha512'
  sizeBytes?: number | null
  fileName?: string
  signal?: AbortSignal
  onProgress?: (progress: { receivedBytes: number; totalBytes: number | null; percent: number | null }) => void
}

export interface DownloadResult {
  filePath: string
  sizeBytes: number
  reused: boolean
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'download'
}

export function inferFileName(url: string): string {
  try {
    const parsed = new URL(url)
    const name = basename(parsed.pathname)
    if (name && name !== '/' && name !== '\\') return safeSegment(decodeURIComponent(name))
  } catch {
    // Fall through to the generic name.
  }
  return 'download.bin'
}

function hashFile(filePath: string, algorithm: 'sha256' | 'sha512'): string {
  const hash = createHash(algorithm)
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
}

/**
 * Downloads release artifacts over HTTPS only, streams them to a temporary
 * .part file while hashing, verifies the published checksum before the file
 * is ever executed, and keeps a verified cache in the DevForge download
 * directory.
 */
export class DownloadManager {
  private dispatcher: { proxy: string; agent: Dispatcher } | null = null

  constructor(
    private readonly getDownloadDir: () => string,
    private readonly db: AppDatabase,
    private readonly logger: Logger,
    private readonly getProxyUrl: () => string = () => ''
  ) {}

  private proxyDispatcher(): Dispatcher | undefined {
    const proxy = this.getProxyUrl().trim()
    if (!proxy) return undefined
    if (this.dispatcher?.proxy === proxy) return this.dispatcher.agent
    if (this.dispatcher) void this.dispatcher.agent.close().catch(() => undefined)
    const agent = new ProxyAgent(proxy)
    this.dispatcher = { proxy, agent }
    return agent
  }

  private verifyFile(filePath: string, request: DownloadRequest): void {
    const actual = hashFile(filePath, request.algorithm)
    if (actual.toLowerCase() !== request.checksum.toLowerCase()) {
      rmSync(filePath, { force: true })
      throw new AppError(
        'CHECKSUM_MISMATCH',
        `The downloaded file for ${request.packageId} failed checksum verification and was deleted.`,
        {
          hint: 'The download may be corrupted or was modified in transit. Try again from a trusted network.',
          details: `Expected ${request.algorithm}:${request.checksum}\nActual ${request.algorithm}:${actual}`
        }
      )
    }
  }

  async download(request: DownloadRequest): Promise<DownloadResult> {
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      throw new AppError('VALIDATION', 'The download URL is not valid.')
    }
    if (parsed.protocol !== 'https:') {
      throw new AppError('VALIDATION', 'DevForge only downloads software over HTTPS.')
    }
    if (!/^[a-fA-F0-9]{64,128}$/.test(request.checksum)) {
      throw new AppError('VALIDATION', 'Refusing to download a package without a valid checksum.')
    }

    const directory = join(this.getDownloadDir(), safeSegment(request.packageId), safeSegment(request.version))
    mkdirSync(directory, { recursive: true })
    const fileName = request.fileName ?? inferFileName(request.url)
    const target = join(directory, fileName)
    const part = `${target}.part`

    if (existsSync(target)) {
      try {
        this.verifyFile(target, request)
        const size = statSync(target).size
        this.logger.info('Using verified cached download', { packageId: request.packageId, target })
        return { filePath: target, sizeBytes: size, reused: true }
      } catch (error) {
        this.logger.warn('Cached download failed verification and was removed', {
          packageId: request.packageId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    rmSync(part, { force: true })

    this.logger.info('Downloading package', {
      packageId: request.packageId,
      version: request.version,
      url: request.url
    })

    let response: Response
    try {
      response = await fetch(parsed, {
        redirect: 'follow',
        signal: request.signal,
        dispatcher: this.proxyDispatcher(),
        headers: {
          'User-Agent': 'DevForge/1.0 (+https://devforge.local)',
          Accept: 'application/octet-stream, application/zip, */*'
        }
      })
    } catch (error) {
      if (request.signal?.aborted) {
        throw new AppError('CANCELLED', 'The download was cancelled.')
      }
      throw new AppError('DOWNLOAD_FAILED', `Could not download ${request.packageId}.`, {
        hint: 'Check your internet connection and try again.',
        details: error instanceof Error ? error.message : String(error)
      })
    }

    if (!response.ok || !response.body) {
      throw new AppError('DOWNLOAD_FAILED', `The download server returned HTTP ${response.status}.`, {
        hint: 'The vendor download may be temporarily unavailable. Try again later.',
        details: `${request.url} -> ${response.url}`
      })
    }
    if (!response.url.startsWith('https://')) {
      throw new AppError('DOWNLOAD_FAILED', 'The download was redirected to an insecure address and was rejected.')
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0') || null
    const totalBytes = contentLength ?? request.sizeBytes ?? null

    const hash = createHash(request.algorithm)
    const stream = createWriteStream(part, { flags: 'w' })
    let receivedBytes = 0
    let lastReport = 0

    try {
      const reader = (response.body as unknown as NodeReadableStream<Uint8Array>).getReader()
      for (;;) {
        if (request.signal?.aborted) {
          await reader.cancel().catch(() => undefined)
          throw new AppError('CANCELLED', 'The download was cancelled.')
        }
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const buffer = Buffer.from(value)
        hash.update(buffer)
        receivedBytes += buffer.byteLength
        if (!stream.write(buffer)) {
          await new Promise<void>((resolve) => stream.once('drain', () => resolve()))
        }
        const nowMs = Date.now()
        if (nowMs - lastReport > 120) {
          lastReport = nowMs
          request.onProgress?.({
            receivedBytes,
            totalBytes,
            percent: totalBytes && totalBytes > 0 ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : null
          })
        }
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => (error ? reject(error) : resolve()))
      })
    } catch (error) {
      stream.destroy()
      rmSync(part, { force: true })
      if (error instanceof AppError) throw error
      if (request.signal?.aborted) {
        throw new AppError('CANCELLED', 'The download was cancelled.')
      }
      throw new AppError('DOWNLOAD_FAILED', `The download for ${request.packageId} was interrupted.`, {
        hint: 'Try again. Partial downloads are deleted automatically.',
        details: error instanceof Error ? error.message : String(error)
      })
    }

    const actual = hash.digest('hex')
    if (actual.toLowerCase() !== request.checksum.toLowerCase()) {
      rmSync(part, { force: true })
      throw new AppError(
        'CHECKSUM_MISMATCH',
        `The downloaded file for ${request.packageId} failed checksum verification and was deleted.`,
        {
          hint: 'The download may be corrupted or was modified in transit. Try again from a trusted network.',
          details: `Expected ${request.algorithm}:${request.checksum}\nActual ${request.algorithm}:${actual}`
        }
      )
    }

    rmSync(target, { force: true })
    try {
      const { renameSync } = await import('node:fs')
      renameSync(part, target)
    } catch {
      // Fall back to copy through read/write when rename fails across volumes.
      const { copyFileSync } = await import('node:fs')
      copyFileSync(part, target)
      rmSync(part, { force: true })
    }

    const size = statSync(target).size
    if (request.sizeBytes && Math.abs(size - request.sizeBytes) > Math.max(4096, request.sizeBytes * 0.01)) {
      this.logger.warn('Downloaded size differs from the registry metadata', {
        packageId: request.packageId,
        expected: request.sizeBytes,
        actual: size
      })
    }

    this.db.saveDownload({
      packageId: request.packageId,
      version: request.version,
      url: request.url,
      filePath: target,
      sizeBytes: size,
      checksum: request.checksum,
      status: 'verified'
    })

    request.onProgress?.({ receivedBytes: size, totalBytes: size, percent: 100 })
    this.logger.info('Download verified', {
      packageId: request.packageId,
      sizeBytes: size,
      algorithm: request.algorithm
    })
    return { filePath: target, sizeBytes: size, reused: false }
  }
}
