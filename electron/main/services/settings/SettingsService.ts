import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AppSettings, DatabaseInfo } from '@shared/types'
import type { AppDatabase } from '../database/Database'
import type { Logger } from '../logging/Logger'
import type { RegistryService } from '../registry/RegistryService'
import { AppError } from '../errors'

const settingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  startupPage: z.string().min(1),
  installDir: z.string().min(3),
  installScope: z.enum(['user', 'system']),
  defaultMethod: z.enum(['auto', 'winget', 'archive', 'official-installer']),
  downloadDir: z.string().min(3),
  concurrentDownloads: z.number().int().min(1).max(3),
  autoVerify: z.boolean(),
  confirmInstall: z.boolean(),
  envScope: z.enum(['user', 'system']),
  pathStrategy: z.enum(['append', 'prepend']),
  backupBeforeChange: z.boolean(),
  notifyOnComplete: z.boolean(),
  notifyOnFailure: z.boolean(),
  notifyOnUpdates: z.boolean(),
  checkUpstreamUpdates: z.boolean(),
  proxyUrl: z.string().max(500),
  proxyBypass: z.string().max(1000),
  keepInTray: z.boolean(),
  resumeQueueOnStartup: z.boolean(),
  language: z.literal('en')
})

export interface SettingsServiceOptions {
  db: AppDatabase
  logger: Logger
  userDataDir: string
  registry: RegistryService
}

function isWritableDirectory(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true })
    const probe = join(path, `.devforge-write-test-${process.pid}`)
    writeFileSync(probe, 'ok', 'utf8')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

function computeDefaultToolsDir(): string {
  const preferred = 'C:\\DevForge\\Tools'
  if (isWritableDirectory(preferred)) return preferred
  const local = process.env.LOCALAPPDATA
  if (local) {
    const fallback = join(local, 'DevForge', 'Tools')
    if (isWritableDirectory(fallback)) return fallback
  }
  return join(process.env.USERPROFILE ?? preferred, 'DevForge', 'Tools')
}

export class SettingsService {
  private cached: AppSettings | null = null
  private readonly listeners = new Set<(settings: AppSettings) => void>()

  constructor(private readonly options: SettingsServiceOptions) {}

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(settings: AppSettings): void {
    for (const listener of this.listeners) {
      try {
        listener(settings)
      } catch (error) {
        this.options.logger.warn('Settings listener failed', { error: String(error) })
      }
    }
  }

  getDefaults(): AppSettings {
    return {
      theme: 'dark',
      startupPage: '/',
      installDir: computeDefaultToolsDir(),
      installScope: 'user',
      defaultMethod: 'auto',
      downloadDir: join(this.options.userDataDir, 'downloads'),
      concurrentDownloads: 1,
      autoVerify: true,
      confirmInstall: true,
      envScope: 'user',
      pathStrategy: 'append',
      backupBeforeChange: true,
      notifyOnComplete: true,
      notifyOnFailure: true,
      notifyOnUpdates: true,
      checkUpstreamUpdates: true,
      proxyUrl: '',
      proxyBypass: '',
      keepInTray: false,
      resumeQueueOnStartup: true,
      language: 'en'
    }
  }

  get(): AppSettings {
    if (this.cached) return { ...this.cached }
    const defaults = this.getDefaults()
    const stored = this.options.db.getSettings()
    const merged: Record<string, unknown> = { ...defaults }
    for (const [key, value] of Object.entries(stored)) {
      if (!(key in defaults)) continue
      try {
        merged[key] = JSON.parse(value)
      } catch {
        // Ignore corrupt values and keep the default.
      }
    }
    const parsed = settingsSchema.safeParse(merged)
    this.cached = parsed.success ? parsed.data : defaults
    if (!parsed.success) {
      this.options.logger.warn('Stored settings were invalid; defaults restored', {
        issues: parsed.error.issues
      })
    }
    this.ensureDirectories(this.cached)
    return { ...this.cached }
  }

  private ensureDirectories(settings: AppSettings): void {
    for (const path of [settings.installDir, settings.downloadDir]) {
      try {
        mkdirSync(path, { recursive: true })
      } catch (error) {
        this.options.logger.warn('Could not create directory', { path, error: String(error) })
      }
    }
  }

  private validateDirectory(field: 'installDir' | 'downloadDir', value: string): void {
    if (!/^[a-zA-Z]:\\/.test(value)) {
      throw new AppError('VALIDATION', `${field === 'installDir' ? 'Install' : 'Download'} directory must be an absolute Windows path such as C:\\DevForge\\Tools.`)
    }
    if (/[<>"|?*]/.test(value)) {
      throw new AppError('VALIDATION', 'The directory path contains characters Windows does not allow.')
    }
    const root = resolve(value)
    if (/^[a-zA-Z]:\\?$/.test(root)) {
      throw new AppError('VALIDATION', 'Choose a folder rather than an entire drive root.')
    }
    const protectedRoots = [
      process.env.SystemRoot ?? 'C:\\Windows',
      process.env.ProgramFiles ?? 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    ].map((path) => path.toLowerCase())
    if (protectedRoots.some((protectedRoot) => root.toLowerCase() === protectedRoot.toLowerCase())) {
      throw new AppError('VALIDATION', 'Choose a dedicated DevForge folder, not a Windows system folder.')
    }
    if (!isWritableDirectory(root)) {
      throw new AppError('PERMISSION_DENIED', `DevForge cannot write to "${root}".`, {
        hint: 'Choose a different folder or run DevForge with permission to write there.'
      })
    }
  }

  private validateProxy(value: string): void {
    if (!value) return
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new AppError('VALIDATION', 'The proxy address must be a full URL such as http://proxy.example.com:8080.')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError('VALIDATION', 'Only HTTP and HTTPS proxies are supported.')
    }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const current = this.get()
    const next = { ...current, ...patch }
    const parsed = settingsSchema.safeParse(next)
    if (!parsed.success) {
      throw new AppError('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid settings value.')
    }
    if (patch.installDir && patch.installDir !== current.installDir) {
      this.validateDirectory('installDir', parsed.data.installDir)
    }
    if (patch.downloadDir && patch.downloadDir !== current.downloadDir) {
      this.validateDirectory('downloadDir', parsed.data.downloadDir)
    }
    this.validateProxy(parsed.data.proxyUrl)
    this.ensureDirectories(parsed.data)
    this.options.db.saveSettings(parsed.data)
    this.cached = parsed.data
    this.options.logger.info('Settings updated', { keys: Object.keys(patch) })
    this.emit({ ...parsed.data })
    return { ...parsed.data }
  }

  reset(): AppSettings {
    this.options.db.clearSettings()
    this.cached = null
    const settings = this.get()
    this.emit(settings)
    return settings
  }

  toolsDir(): string {
    return this.get().installDir
  }

  downloadDir(): string {
    return this.get().downloadDir
  }

  databaseInfo(): DatabaseInfo {
    const filePath = this.options.db.filePath
    let sizeBytes = 0
    try {
      sizeBytes = statSync(filePath).size
    } catch {
      sizeBytes = 0
    }
    return {
      path: filePath,
      sizeBytes,
      counts: this.options.db.counts()
    }
  }

  private directorySize(directory: string): number {
    if (!existsSync(directory)) return 0
    let total = 0
    const stack = [directory]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) continue
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const fullPath = join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(fullPath)
        } else if (entry.isFile()) {
          try {
            total += statSync(fullPath).size
          } catch {
            // Skip unreadable files.
          }
        }
      }
    }
    return total
  }

  clearDownloads(): { freedBytes: number } {
    const directory = this.get().downloadDir
    const freedBytes = this.directorySize(directory)
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        try {
          rmSync(join(directory, entry.name), { recursive: true, force: true })
        } catch (error) {
          this.options.logger.warn('Could not delete download', {
            path: entry.name,
            error: String(error)
          })
        }
      }
    }
    this.options.db.clearDownloads()
    this.options.logger.info('Download cache cleared', { freedBytes })
    return { freedBytes }
  }

  diagnostics(): { path: string } {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const directory = join(this.options.userDataDir, 'diagnostics', `devforge-${stamp}`)
    mkdirSync(directory, { recursive: true })
    const report = {
      generatedAt: new Date().toISOString(),
      appVersion: process.env.npm_package_version ?? '1.0.0',
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      settings: this.get(),
      database: this.databaseInfo(),
      registryIssues: this.options.registry.getIssues(),
      registry: {
        packages: this.options.registry.listPackages().map((pkg) => ({
          id: pkg.id,
          name: pkg.name,
          method: pkg.installationMethod,
          versions: pkg.versions.map((version) => version.version)
        })),
        profiles: this.options.registry.listProfiles().map((profile) => profile.id)
      }
    }
    writeFileSync(join(directory, 'system-report.json'), JSON.stringify(report, null, 2), 'utf8')
    try {
      const logDir = join(this.options.userDataDir, 'logs')
      if (existsSync(logDir)) {
        cpSync(logDir, join(directory, 'logs'), { recursive: true })
      }
    } catch (error) {
      this.options.logger.warn('Could not include logs in diagnostics', { error: String(error) })
    }
    return { path: directory }
  }

  readDiagnosticsReport(path: string): string {
    return readFileSync(path, 'utf8')
  }
}
