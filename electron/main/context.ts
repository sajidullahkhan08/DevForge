import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { app, Notification, session, shell, type BrowserWindow } from 'electron'
import type { AppNotification, AppSettings, QueueSnapshot, SystemInfo } from '@shared/types'
import { ipcChannels } from '@shared/ipc'
import { AppDatabase } from './services/database/Database'
import { Logger } from './services/logging/Logger'
import { ProcessExecutor } from './services/process/ProcessExecutor'
import { PowerShellService, powershellScripts } from './services/system/PowerShellService'
import { RegistryService } from './services/registry/RegistryService'
import { SettingsService } from './services/settings/SettingsService'
import { EnvironmentManager } from './services/environment/EnvironmentManager'
import { DownloadManager } from './services/download/DownloadManager'
import { SoftwareDetector, VerificationEngine } from './services/detection/SoftwareDetector'
import { PlannerService } from './services/planner/PlannerService'
import { InstallationEngine } from './services/install/InstallationEngine'
import { InstallationQueue } from './services/install/InstallationQueue'
import { QueueStateStore } from './services/install/QueueStateStore'
import { CatalogueService } from './services/catalogue/CatalogueService'
import { ProfileService } from './services/profiles/ProfileService'
import { ProjectService } from './services/projects/ProjectService'
import { DashboardService } from './services/dashboard/DashboardService'
import { DiscoveryStore } from './services/discovery/DiscoveryStore'
import { DiscoveryService } from './services/discovery/DiscoveryService'
import { IdentityRegistry } from './services/identities/IdentityRegistry'
import { FetchHttpClient } from './services/releases/http'
import { ReleaseResolver } from './services/releases/ReleaseResolver'
import { AppError } from './services/errors'

function proxyEnvironment(settings: AppSettings): Record<string, string> {
  const proxy = settings.proxyUrl.trim()
  if (!proxy) return {}
  const environment: Record<string, string> = {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy
  }
  const bypass = settings.proxyBypass.trim()
  if (bypass) {
    environment.NO_PROXY = bypass
    environment.no_proxy = bypass
  }
  return environment
}

export class AppContext {
  readonly userDataDir: string
  readonly db: AppDatabase
  readonly logger: Logger
  readonly executor: ProcessExecutor
  readonly ps: PowerShellService
  readonly registry: RegistryService
  readonly settings: SettingsService
  readonly env: EnvironmentManager
  readonly downloader: DownloadManager
  readonly detector: SoftwareDetector
  readonly verification: VerificationEngine
  readonly planner: PlannerService
  readonly engine: InstallationEngine
  readonly queue: InstallationQueue
  readonly queueStore: QueueStateStore
  readonly catalogue: CatalogueService
  readonly profiles: ProfileService
  readonly projects: ProjectService
  readonly dashboard: DashboardService
  readonly discoveryStore: DiscoveryStore
  readonly identities: IdentityRegistry
  readonly releases: ReleaseResolver
  readonly discovery: DiscoveryService
  private window: BrowserWindow | null = null
  private backgroundStarted = false
  private readonly queueListeners = new Set<(snapshot: QueueSnapshot) => void>()
  private readonly activeNotifications = new Set<Notification>()

  constructor() {
    this.userDataDir = app.getPath('userData')
    this.db = new AppDatabase(join(this.userDataDir, 'devforge.db'))
    this.logger = new Logger(join(this.userDataDir, 'logs'))
    this.executor = new ProcessExecutor()
    this.ps = new PowerShellService(this.executor)
    this.discoveryStore = new DiscoveryStore(
      join(this.userDataDir, 'discovered-packages.json'),
      this.logger
    )

    const registryRoot = app.isPackaged
      ? join(process.resourcesPath, 'packages')
      : join(app.getAppPath(), 'packages')
    this.registry = new RegistryService(registryRoot, this.db, this.logger)
    const discovered = this.discoveryStore.load()
    const discoveredCount = this.registry.loadDynamicPackages(discovered.packages)
    this.logger.info('Discovered packages loaded', { packages: discoveredCount })
    this.identities = new IdentityRegistry(registryRoot, this.registry, this.logger)
    this.logger.info('Canonical identities loaded', { identities: this.identities.list().length })
    this.releases = new ReleaseResolver(
      new FetchHttpClient(() => this.settings.get().proxyUrl),
      this.logger,
      discovered.releases
    )
    this.settings = new SettingsService({
      db: this.db,
      logger: this.logger,
      userDataDir: this.userDataDir,
      registry: this.registry
    })
    this.env = new EnvironmentManager(
      this.db,
      this.ps,
      this.executor,
      this.logger,
      () => this.settings.get(),
      () => this.settings.toolsDir()
    )
    this.downloader = new DownloadManager(
      () => this.settings.downloadDir(),
      this.db,
      this.logger,
      () => this.settings.get().proxyUrl
    )
    this.executor.setBaseEnvironmentProvider(() => proxyEnvironment(this.settings.get()))
    this.detector = new SoftwareDetector(
      this.db,
      this.executor,
      this.env,
      this.ps,
      this.logger,
      () => this.settings.toolsDir()
    )
    this.verification = new VerificationEngine(this.db, this.executor, this.env, this.ps, this.logger)
    this.planner = new PlannerService(
      this.registry,
      this.db,
      this.ps,
      this.env,
      this.logger,
      () => this.settings.toolsDir()
    )
    this.engine = new InstallationEngine(
      this.registry,
      this.db,
      this.settings,
      this.env,
      this.executor,
      this.ps,
      this.downloader,
      this.detector,
      this.verification,
      this.logger,
      this.identities,
      this.releases
    )
    this.queueStore = new QueueStateStore(join(this.userDataDir, 'queue-state.json'), this.logger)
    this.queue = new InstallationQueue(
      this.planner,
      this.engine,
      this.db,
      this.settings,
      this.logger,
      (snapshot) => {
        this.send(ipcChannels.events.queueUpdate, snapshot)
        for (const listener of this.queueListeners) {
          try {
            listener(snapshot)
          } catch (error) {
            this.logger.warn('Queue listener failed', { error: String(error) })
          }
        }
      },
      (notification) => this.showNotification(notification),
      this.queueStore
    )
    this.catalogue = new CatalogueService(this.registry, this.db, this.identities)
    this.profiles = new ProfileService(this.db, this.registry, this.logger)
    this.projects = new ProjectService(
      this.db,
      this.registry,
      this.logger,
      () => this.settings.toolsDir()
    )
    this.discovery = new DiscoveryService(
      this.registry,
      this.db,
      this.logger,
      this.discoveryStore,
      this.identities,
      this.releases,
      this.executor,
      discovered.refreshedAt
    )
    this.dashboard = new DashboardService(
      this.db,
      this.env,
      this.queue,
      this.catalogue,
      this.profiles,
      this.engine
    )
  }

  async applyNetworkSettings(): Promise<void> {
    const settings = this.settings.get()
    try {
      if (settings.proxyUrl.trim()) {
        await session.defaultSession.setProxy({
          proxyRules: settings.proxyUrl.trim(),
          proxyBypassRules: settings.proxyBypass.trim() || '<-loopback>'
        })
      } else {
        await session.defaultSession.setProxy({ mode: 'system' })
      }
    } catch (error) {
      this.logger.warn('Could not apply the proxy configuration', { error: String(error) })
    }
  }

  initialize(): void {
    this.db.markInterruptedTransactions()
    this.registry.syncDatabase()
    this.settings.get()
    void this.applyNetworkSettings()
    this.logger.info('DevForge started', {
      packages: this.registry.listPackages().length,
      discovered: this.registry.listDynamicPackages().length,
      profiles: this.registry.listProfiles().length,
      issues: this.registry.getIssues().length
    })
  }

  setWindow(window: BrowserWindow): void {
    this.window = window
  }

  onQueueSnapshot(listener: (snapshot: QueueSnapshot) => void): () => void {
    this.queueListeners.add(listener)
    return () => this.queueListeners.delete(listener)
  }

  focusWindow(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  private send(channel: string, payload: unknown): void {
    if (!this.window || this.window.isDestroyed()) return
    try {
      this.window.webContents.send(channel, payload)
    } catch (error) {
      this.logger.warn('Could not send renderer event', { channel, error: String(error) })
    }
  }

  emitActivity(): void {
    this.send(ipcChannels.events.activity, this.db.listActivity(20))
  }

  emitVerification(run: unknown): void {
    this.send(ipcChannels.events.verification, run)
  }

  showNotification(notification: AppNotification): void {
    this.send(ipcChannels.events.notification, notification)
    try {
      if (Notification.isSupported()) {
        const native = new Notification({
          title: notification.title,
          body: notification.body,
          silent: false
        })
        native.on('click', () => this.focusWindow())
        native.on('close', () => this.activeNotifications.delete(native))
        this.activeNotifications.add(native)
        native.show()
      }
    } catch (error) {
      this.logger.warn('Could not show a Windows notification', { error: String(error) })
    }
  }

  async startBackgroundTasks(): Promise<void> {
    if (this.backgroundStarted) return
    this.backgroundStarted = true
    try {
      const result = await this.detector.refreshInstalledPackages(this.registry.listPackages())
      this.logger.info('Startup detection complete', {
        detections: result.detections.filter((detection) => detection.installed).length,
        installations: result.installations.length
      })
      this.emitActivity()
    } catch (error) {
      this.logger.warn('Startup detection failed', { error: String(error) })
    }
    try {
      const refresh = await this.discovery.refreshManagedPackages()
      if (refresh.updated.length > 0) {
        this.logger.info('Discovered package metadata updated on startup', {
          updated: refresh.updated
        })
        this.emitActivity()
      }
    } catch (error) {
      this.logger.warn('Discovered package metadata refresh failed', { error: String(error) })
    }
    await this.restoreQueue()
  }

  private async restoreQueue(): Promise<void> {
    if (!this.settings.get().resumeQueueOnStartup) {
      this.queueStore.clear()
      return
    }
    const saved = this.queueStore.load()
    if (!saved) return
    try {
      await this.queue.restore(saved.requests, saved.autoStart)
      this.logger.info('Pending installation queue restored', {
        requests: saved.requests.length,
        autoStart: saved.autoStart
      })
      this.emitActivity()
    } catch (error) {
      this.logger.warn('Could not restore the pending installation queue', {
        error: String(error)
      })
      this.queueStore.clear()
    }
  }

  async refreshInstalled(): Promise<ReturnType<AppDatabase['listInstallations']>> {
    await this.detector.refreshInstalledPackages(this.registry.listPackages())
    this.emitActivity()
    return this.listInstalled()
  }

  listInstalled() {
    return this.db.listInstallations().filter((record) => record.status !== 'removed')
  }

  private allowedRoots(): string[] {
    return [
      this.settings.toolsDir(),
      this.userDataDir,
      this.settings.downloadDir(),
      this.logger.directory
    ]
      .filter(Boolean)
      .map((root) => resolve(root).toLowerCase())
  }

  private assertAllowedPath(path: string): string {
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
      throw new AppError('VALIDATION', 'The requested path is not valid.')
    }
    const target = resolve(path)
    const lower = target.toLowerCase()
    const allowed = this.allowedRoots().some(
      (root) => lower === root || lower.startsWith(`${root}\\`)
    )
    if (!allowed) {
      throw new AppError('PERMISSION_DENIED', 'DevForge only opens files inside its own managed folders.')
    }
    return target
  }

  async openExternal(url: string): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new AppError('VALIDATION', 'The URL is not valid.')
    }
    if (parsed.protocol !== 'https:') {
      throw new AppError('VALIDATION', 'Only HTTPS links can be opened.')
    }
    await shell.openExternal(parsed.toString())
  }

  async openPath(path: string): Promise<void> {
    const target = this.assertAllowedPath(path)
    if (!existsSync(target)) {
      throw new AppError('NOT_FOUND', 'That folder no longer exists.')
    }
    const error = await shell.openPath(target)
    if (error) {
      throw new AppError('INTERNAL', 'Windows could not open that folder.', { details: error })
    }
  }

  async showInFolder(path: string): Promise<void> {
    const target = this.assertAllowedPath(path)
    if (!existsSync(target)) {
      throw new AppError('NOT_FOUND', 'That file or folder no longer exists.')
    }
    shell.showItemInFolder(target)
  }

  async openInstallationDirectory(packageId: string): Promise<void> {
    const records = this.db
      .listInstallationsForPackage(packageId)
      .filter((record) => record.status === 'installed')
    const record = records.find((candidate) => candidate.isActive) ?? records[0]
    if (!record?.installDir) {
      throw new AppError(
        'NOT_FOUND',
        'DevForge does not know where this package is installed.',
        { hint: 'The package may be managed by another installer. Check its documentation for the install folder.' }
      )
    }
    if (!existsSync(record.installDir)) {
      throw new AppError('NOT_FOUND', 'The recorded installation folder no longer exists.')
    }
    const error = await shell.openPath(record.installDir)
    if (error) {
      throw new AppError('INTERNAL', 'Windows could not open that folder.', { details: error })
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    const settings = this.settings.get()
    const [elevated, wingetVersion, powershellVersion, caption, freeDisk] = await Promise.all([
      this.env.isElevated(),
      this.env.getWingetVersion(),
      this.ps.run(powershellScripts.powershellVersion, undefined, 15000).then((result) => result.stdout.trim()).catch(() => null),
      this.ps.run(powershellScripts.windowsCaption, undefined, 20000).then((result) => result.stdout.trim()).catch(() => ''),
      this.ps
        .runJson<string | number>(powershellScripts.diskFree, { path: settings.installDir }, 15000)
        .then((value) => {
          const parsed = typeof value === 'number' ? value : Number(String(value).trim())
          return Number.isFinite(parsed) ? parsed : null
        })
        .catch(() => null)
    ])

    let firstRun = true
    try {
      firstRun = Object.keys(this.db.getSettings()).length === 0
    } catch {
      firstRun = false
    }

    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      chromeVersion: process.versions.chrome ?? '',
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      windowsVersion: caption ?? '',
      hostname: os.hostname(),
      username: os.userInfo().username,
      isElevated: elevated,
      wingetVersion,
      powershellVersion,
      toolsDir: settings.installDir,
      downloadDir: settings.downloadDir,
      databasePath: this.db.filePath,
      logsDir: this.logger.directory,
      freeDiskBytes: freeDisk,
      totalMemoryBytes: os.totalmem(),
      firstRun
    }
  }

  async databaseFileSize(): Promise<number> {
    try {
      return statSync(this.db.filePath).size
    } catch {
      return 0
    }
  }

  shutdown(): void {
    try {
      this.queue.shutdown()
    } catch {
      // Queue may already be idle.
    }
    this.db.close()
    this.logger.info('DevForge stopped')
  }
}

export function defaultDatabaseDirectory(userDataDir: string): string {
  return dirname(join(userDataDir, 'devforge.db'))
}
