import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { open, type Entry, type ZipFile } from 'yauzl'

export interface ZipExtractionLimits {
  /** Maximum number of entries. Guards against pathological archives. */
  maxEntries?: number
  /** Maximum total declared uncompressed size in bytes. */
  maxTotalBytes?: number
}

export interface ZipExtractionResult {
  entries: number
  files: number
  totalUncompressedBytes: number
}

const defaultMaxEntries = 200_000
const defaultMaxTotalBytes = 32 * 1024 * 1024 * 1024

const windowsReservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function isSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

function hasUnsupportedType(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  const type = unixMode & 0o170000
  return type !== 0 && type !== 0o100000 && type !== 0o040000
}

/**
 * Normalizes an archive entry name into safe relative path segments. Rejects
 * absolute paths, drive letters, NTFS alternate data streams, traversal and
 * Windows reserved device names. ZIP entries are written with forward slashes,
 * but backslashes are normalized because some Windows-created archives use
 * them.
 */
export function safeZipEntrySegments(fileName: string): string[] {
  if (!fileName || fileName.includes('\0')) {
    throw new Error('The archive contains an entry with an invalid name.')
  }
  if (fileName.length > 1024) {
    throw new Error('The archive contains an entry name that is too long.')
  }
  const normalized = fileName.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`The archive entry "${fileName}" uses an absolute path.`)
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.includes('..')) {
    throw new Error(`The archive entry "${fileName}" tries to escape the destination folder.`)
  }
  for (const segment of segments) {
    if (segment.includes(':')) {
      throw new Error(`The archive entry "${fileName}" contains a colon, which is not allowed on Windows.`)
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(`The archive entry "${fileName}" ends a path segment with a dot or space.`)
    }
    if (windowsReservedName.test(segment)) {
      throw new Error(`The archive entry "${fileName}" uses a reserved Windows device name.`)
    }
  }
  return segments
}

function entryTarget(destination: string, segments: string[]): string {
  const root = resolve(destination)
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('The archive entry resolves outside the destination folder.')
  }
  return target
}

/**
 * Extracts a ZIP archive without trusting its entry names. Symlinks, special
 * files, encrypted entries and unsupported compression methods are rejected,
 * paths are confined to the destination and duplicate files are not
 * overwritten. The archive itself has already passed a publisher checksum
 * before this function is called; these checks protect against a malicious or
 * malformed archive layout.
 */
export async function extractZipSafely(
  zipPath: string,
  destination: string,
  limits: ZipExtractionLimits = {}
): Promise<ZipExtractionResult> {
  const maxEntries = limits.maxEntries ?? defaultMaxEntries
  const maxTotalBytes = limits.maxTotalBytes ?? defaultMaxTotalBytes
  const root = resolve(destination)
  mkdirSync(root, { recursive: true })

  const zip = await new Promise<ZipFile>((resolvePromise, reject) => {
    open(
      zipPath,
      {
        lazyEntries: true,
        autoClose: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: false
      },
      (error, file) => {
        if (error || !file) reject(error ?? new Error('The archive could not be opened.'))
        else resolvePromise(file)
      }
    )
  })

  let entries = 0
  let files = 0
  let totalUncompressedBytes = 0

  try {
    for await (const entry of zip.eachEntry()) {
      entries += 1
      if (entries > maxEntries) {
        throw new Error(`The archive contains more than ${maxEntries} entries and was rejected.`)
      }
      if (entry.isEncrypted()) {
        throw new Error('Encrypted archives are not supported.')
      }
      if (!entry.canDecodeFileData()) {
        throw new Error(`"${entry.fileName}" uses an unsupported compression method.`)
      }
      if (isSymlink(entry) || hasUnsupportedType(entry)) {
        throw new Error(`"${entry.fileName}" is a link or special file, which DevForge does not extract.`)
      }

      const segments = safeZipEntrySegments(entry.fileName)
      if (segments.length === 0) continue

      totalUncompressedBytes += entry.uncompressedSize
      if (totalUncompressedBytes > maxTotalBytes) {
        throw new Error('The archive expands beyond the supported size limit and was rejected.')
      }

      const target = entryTarget(root, segments)
      const isDirectory = entry.fileName.endsWith('/') || entry.fileName.endsWith('\\')
      if (isDirectory) {
        mkdirSync(target, { recursive: true })
        continue
      }

      mkdirSync(dirname(target), { recursive: true })
      const stream = await new Promise<Readable>((resolvePromise, reject) => {
        zip.openReadStream(entry, (error, entryStream) => {
          if (error || !entryStream) reject(error ?? new Error(`"${entry.fileName}" could not be read.`))
          else resolvePromise(entryStream)
        })
      })
      await pipeline(stream, createWriteStream(target, { flags: 'wx' }))
      files += 1
    }
  } finally {
    if (zip.isOpen) zip.close()
  }

  return { entries, files, totalUncompressedBytes }
}
