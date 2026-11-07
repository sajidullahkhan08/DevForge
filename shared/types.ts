import type {
  DependencyDefinition,
  DetectionSpec,
  EnvironmentSpec,
  InstallationMethod,
  PackageCategory,
  PackageDefinition,
  ProfileComponentDefinition,
  RegistryVersion,
  VerificationSpec
} from './registry'
import type {
  DiscoveryRefreshResult,
  DiscoverySearchResponse,
  PrepareDiscoveryResponse
} from './discovery'
import type { CanonicalIdentity } from './identity'
import type { VersionResolution } from './releases'

export type {
  DependencyDefinition,
  DetectionSpec,
  EnvironmentSpec,
  InstallationMethod,
  PackageCategory,
  PackageDefinition,
  ProfileComponentDefinition,
  RegistryVersion,
  VerificationSpec
}

export type EnvScope = 'user' | 'system'
export type ThemePreference = 'dark' | 'light' | 'system'

export interface InstallRequest {
  packageId: string
  version?: string
}

export interface InstalledSummary {
  id: number
  packageId: string
  version: string
  method: InstallationMethod
  source: 'devforge' | 'external'
  installDir: string | null
  status: 'installed' | 'failed' | 'removed' | 'unknown'
  verificationStatus: 'verified' | 'failed' | 'pending' | 'unknown'
  detectedVersion: string | null
  availableVersion: string | null
  envStatus: 'configured' | 'not-configured' | 'unknown'
  isActive: boolean
  installedAt: string
  updatedAt: string
}

export interface CatalogueItem {
  package: PackageDefinition
  /** Canonical identity independent of the package source, when known. */
  identity: CanonicalIdentity | null
  defaultVersion: string | null
  latestVersion: string | null
  installed: InstalledSummary | null
  installations: InstalledSummary[]
  updateAvailable: boolean
  availableVersion: string | null
}

export type PlanAction = 'install' | 'upgrade' | 'configure' | 'skip' | 'project-recipe' | 'unsupported'

export interface PlanStep {
  order: number
  packageId: string
  name: string
  version: string | null
  action: PlanAction
  method: InstallationMethod
  isDependency: boolean
  dependencyKind: 'required' | 'optional' | null
  reason: string | null
  requiresAdmin: boolean
  requiresRestart: boolean
  estimatedSizeBytes: number | null
  environmentChanges: string[]
  verificationChecks: string[]
  warnings: string[]
  alreadyInstalledVersion: string | null
}

export interface InstallationPlan {
  id: string
  createdAt: string
  requests: InstallRequest[]
  steps: PlanStep[]
  warnings: string[]
  errors: string[]
  diskFreeBytes: number | null
  totalEstimatedSizeBytes: number
  requiresAdmin: boolean
  requiresRestart: boolean
  serializedReason: string
}

export type QueueStage =
  | 'checking'
  | 'resolving'
  | 'downloading'
  | 'verifying-download'
  | 'installing'
  | 'configuring'
  | 'verifying'
  | 'completed'

export type StageStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped'

export interface QueueStageState {
  stage: QueueStage
  label: string
  status: StageStatus
  detail: string | null
  startedAt: string | null
  finishedAt: string | null
  progress: number | null
}

export type QueueStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'requires-restart'

export type InstallationOutcomeKind = 'installed' | 'upgraded' | 'already-installed' | 'configured-only'
export type ConfigurationOutcomeKind = 'applied' | 'already-configured' | 'not-required' | 'failed'
export type VerificationOutcomeKind = 'passed' | 'failed' | 'skipped' | 'not-run'
export type OperationOutcomeKind = 'completed' | 'completed-no-changes' | 'partial' | 'requires-restart'

export interface OperationSummary {
  installation: InstallationOutcomeKind
  configuration: ConfigurationOutcomeKind
  verification: VerificationOutcomeKind
  outcome: OperationOutcomeKind
  summary: string
}

export interface QueueError {
  code: string
  message: string
  hint: string | null
  details: string | null
}

export interface QueueItem {
  id: string
  packageId: string
  name: string
  version: string | null
  method: InstallationMethod
  isDependency: boolean
  reason: string | null
  status: QueueStatus
  stages: QueueStageState[]
  progress: number | null
  message: string | null
  error: QueueError | null
  transactionId: string | null
  summary: OperationSummary | null
  addedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface QueueSnapshot {
  items: QueueItem[]
  running: boolean
  paused: boolean
  pendingCount: number
}

export interface EnvVariable {
  name: string
  value: string
  scope: EnvScope
  kind: 'variable' | 'path'
  managedByDevForge: boolean
  originalValue: string | null
  updatedAt: string | null
  status: 'valid' | 'invalid' | 'missing'
  entryCount: number | null
  managedEntries: string[] | null
}

export interface PathEntry {
  index: number
  raw: string
  resolved: string
  exists: boolean
  duplicate: boolean
  managed: boolean
}

export type EnvironmentMutation =
  | { action: 'set-variable'; scope: EnvScope; name: string; value: string }
  | { action: 'remove-variable'; scope: EnvScope; name: string }
  | { action: 'add-path'; scope: EnvScope; entries: string[]; strategy?: 'append' | 'prepend' }
  | { action: 'remove-path'; scope: EnvScope; entries: string[] }
  | { action: 'dedupe-path'; scope: EnvScope }

export interface EnvChange {
  scope: EnvScope
  name: string
  kind: 'variable' | 'path'
  operation: 'create' | 'update' | 'append-path' | 'remove-path' | 'dedupe-path' | 'remove-variable' | 'noop'
  before: string | null
  after: string | null
  addedEntries: string[]
  removedEntries: string[]
  reason: string | null
}

export type EnvPreviewOutcome = 'pending' | 'applied' | 'already-satisfied' | 'nothing-to-do'

export interface EnvPreview {
  changes: EnvChange[]
  warnings: string[]
  errors: string[]
  requiresAdmin: boolean
  canApply: boolean
  appliedBackupIds: number[]
  outcome: EnvPreviewOutcome
}

export interface EnvBackup {
  id: number
  scope: EnvScope
  name: string
  kind: 'variable' | 'path'
  changeType: string
  previousValue: string | null
  newValue: string | null
  createdAt: string
  restoredAt: string | null
  transactionId: string | null
  packageName: string | null
}

export interface HealthCheck {
  id: string
  label: string
  status: 'ok' | 'warning' | 'error' | 'info'
  detail: string
  packageId: string | null
  fixHint: string | null
}

export interface ActivityEntry {
  id: number
  type:
    | 'install'
    | 'configure'
    | 'verify'
    | 'detect'
    | 'update'
    | 'uninstall'
    | 'error'
    | 'system'
  level: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string | null
  packageId: string | null
  createdAt: string
}

export type UpdateSource = 'registry' | 'winget' | 'upstream'

export interface UpdateInfo {
  packageId: string
  name: string
  currentVersion: string
  availableVersion: string
  method: InstallationMethod
  installable: boolean
  source: UpdateSource
  /** Release channel reported by the authoritative source, when known. */
  channel: string | null
  /** Human-readable provenance for the available version. */
  provenance: string | null
  /** Why an upstream update cannot be installed through DevForge yet. */
  reason: string | null
}

export interface DashboardStats {
  installedCount: number
  updatesCount: number
  activeProfiles: number
  recentInstalls: number
  pendingOperations: number
}

export interface DashboardData {
  stats: DashboardStats
  installations: InstalledSummary[]
  health: HealthCheck[]
  activity: ActivityEntry[]
  queue: QueueSnapshot
  updates: UpdateInfo[]
  categoryBreakdown: { category: PackageCategory; count: number }[]
}

export interface SystemInfo {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: string
  arch: string
  windowsVersion: string
  hostname: string
  username: string
  isElevated: boolean
  wingetVersion: string | null
  powershellVersion: string | null
  toolsDir: string
  downloadDir: string
  databasePath: string
  logsDir: string
  freeDiskBytes: number | null
  totalMemoryBytes: number
  firstRun: boolean
}

export interface VerificationCheck {
  id: string
  label: string
  command: string
  passed: boolean
  output: string
  expected: string | null
  error: string | null
  optional: boolean
}

export interface VerificationRun {
  id: number
  packageId: string
  version: string | null
  status: 'passed' | 'failed'
  startedAt: string
  finishedAt: string
  checks: VerificationCheck[]
}

export interface LogEntry {
  id: number
  transactionId: string
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  stage: string
  message: string
  command: string | null
  args: string[] | null
  exitCode: number | null
  stdout: string | null
  stderr: string | null
}

export interface TransactionRecord {
  id: string
  packageId: string
  packageName: string
  version: string | null
  method: InstallationMethod
  status: string
  startedAt: string
  finishedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  logCount: number
}

export interface TransactionDetail extends TransactionRecord {
  logs: LogEntry[]
  envChanges: EnvBackup[]
  verification: VerificationRun | null
}

export interface ProfileComponent {
  packageId: string
  optional: boolean
  preferredVersion: string | null
}

export interface EnvironmentProfile {
  id: string
  name: string
  description: string
  audience: string
  icon: string
  isBuiltin: boolean
  notes: string[]
  components: ProfileComponent[]
  createdAt: string | null
  updatedAt: string | null
}

export interface ProfileInput {
  name: string
  description: string
  audience: string
  icon: string
  components: { packageId: string; optional?: boolean; preferredVersion?: string | null }[]
}

/**
 * Portable, human-readable description of an environment. It pins the exact
 * versions that were installed when it was exported, so another machine can
 * reproduce the same setup instead of silently drifting to newer releases.
 */
export interface EnvironmentManifestComponent {
  packageId: string
  name: string
  /** Exact version to install, or null when the package has no version. */
  version: string | null
  optional: boolean
  /** Version observed on the exporting machine, when it was installed. */
  installedVersion: string | null
}

export interface EnvironmentManifest {
  schemaVersion: 2
  kind: 'devforge-environment'
  name: string
  description: string
  audience: string
  icon: string
  exportedAt: string
  appVersion: string
  platform: string
  components: EnvironmentManifestComponent[]
  warnings: string[]
}

export interface ProfileExportResult {
  canceled: boolean
  path: string | null
}

export interface ProfileImportResult {
  canceled: boolean
  path: string | null
  profile: EnvironmentProfile | null
  warnings: string[]
}

export interface ProjectConfig {
  schemaVersion: 1
  name?: string
  packages: Record<string, string>
}

export interface ProjectInstallationOption {
  packageId: string
  name: string
  version: string
  installDir: string
  active: boolean
}

export interface ProjectInspection {
  path: string
  name: string
  configPath: string
  configExists: boolean
  config: ProjectConfig | null
  options: ProjectInstallationOption[]
  warnings: string[]
}

export interface ProjectGenerateRequest {
  path: string
  packages: Record<string, string>
}

export interface ProjectGenerateResult {
  path: string
  configPath: string
  scriptPath: string
  command: string
  warnings: string[]
}

export interface ProjectRemoveResult {
  path: string
  removed: string[]
}

export interface DoctorAction {
  id: string
  label: string
  description: string
  scope: EnvScope
  mutations: EnvironmentMutation[]
}

export interface EnvironmentDoctorReport {
  actions: DoctorAction[]
  warnings: string[]
}

export interface PackageImportResult {
  canceled: boolean
  path: string | null
  package: PackageDefinition | null
  warnings: string[]
}

export interface AppSettings {
  theme: ThemePreference
  startupPage: string
  installDir: string
  installScope: EnvScope
  defaultMethod: 'auto' | 'winget' | 'archive' | 'official-installer'
  downloadDir: string
  concurrentDownloads: number
  autoVerify: boolean
  confirmInstall: boolean
  envScope: EnvScope
  pathStrategy: 'append' | 'prepend'
  backupBeforeChange: boolean
  notifyOnComplete: boolean
  notifyOnFailure: boolean
  notifyOnUpdates: boolean
  checkUpstreamUpdates: boolean
  proxyUrl: string
  proxyBypass: string
  keepInTray: boolean
  resumeQueueOnStartup: boolean
  language: 'en'
}

export interface DatabaseInfo {
  path: string
  sizeBytes: number
  counts: Record<string, number>
}

export interface UninstallResult {
  success: boolean
  output: string
  environmentRestored: boolean
  message: string
}

export interface SwitchVersionResult {
  success: boolean
  message: string
  envPreview: EnvPreview | null
}

export interface AppNotification {
  kind: 'success' | 'error' | 'info' | 'warning'
  title: string
  body: string
  packageId?: string
}

export interface DevForgeApi {
  app: {
    getInfo(): Promise<SystemInfo>
    getDashboard(): Promise<DashboardData>
  }
  registry: {
    list(): Promise<CatalogueItem[]>
    get(packageId: string): Promise<CatalogueItem | null>
    importPackage(): Promise<PackageImportResult>
  }
  discovery: {
    search(query: string): Promise<DiscoverySearchResponse>
    prepare(resultId: string): Promise<PrepareDiscoveryResponse>
    refreshManaged(force?: boolean): Promise<DiscoveryRefreshResult>
  }
  plans: {
    preview(requests: InstallRequest[]): Promise<InstallationPlan>
  }
  queue: {
    get(): Promise<QueueSnapshot>
    enqueue(requests: InstallRequest[]): Promise<{ plan: InstallationPlan; queue: QueueSnapshot }>
    start(): Promise<QueueSnapshot>
    pause(): Promise<QueueSnapshot>
    resume(): Promise<QueueSnapshot>
    cancel(itemId: string): Promise<QueueSnapshot>
    retry(itemId: string, options?: { recoverDirectory?: boolean }): Promise<QueueSnapshot>
    remove(itemId: string): Promise<QueueSnapshot>
    move(itemId: string, direction: 'up' | 'down'): Promise<QueueSnapshot>
    clearCompleted(): Promise<QueueSnapshot>
  }
  installations: {
    list(): Promise<InstalledSummary[]>
    refresh(): Promise<InstalledSummary[]>
    verify(packageId: string): Promise<VerificationRun>
    repair(packageId: string): Promise<EnvPreview>
    uninstall(packageId: string, options?: { removeDirectory?: boolean }): Promise<UninstallResult>
    openDirectory(packageId: string): Promise<void>
    checkUpdates(): Promise<UpdateInfo[]>
  }
  versions: {
    switch(packageId: string, version: string): Promise<SwitchVersionResult>
  }
  profiles: {
    list(): Promise<EnvironmentProfile[]>
    create(input: ProfileInput): Promise<EnvironmentProfile>
    update(profileId: string, input: ProfileInput): Promise<EnvironmentProfile>
    remove(profileId: string): Promise<void>
    duplicate(profileId: string): Promise<EnvironmentProfile>
    exportManifest(profileId: string): Promise<ProfileExportResult>
    importManifest(): Promise<ProfileImportResult>
  }
  projects: {
    choose(): Promise<string | null>
    inspect(path: string): Promise<ProjectInspection>
    generate(request: ProjectGenerateRequest): Promise<ProjectGenerateResult>
    remove(path: string): Promise<ProjectRemoveResult>
  }
  environment: {
    list(): Promise<EnvVariable[]>
    pathEntries(scope: EnvScope, name?: string): Promise<PathEntry[]>
    preview(mutations: EnvironmentMutation[]): Promise<EnvPreview>
    apply(mutations: EnvironmentMutation[]): Promise<EnvPreview>
    backups(): Promise<EnvBackup[]>
    restore(backupId: number): Promise<{ success: boolean; preview: EnvPreview; message: string }>
    validate(): Promise<HealthCheck[]>
    refreshEnvironment(): Promise<{ refreshed: boolean; message: string }>
    doctor(): Promise<EnvironmentDoctorReport>
  }
  history: {
    list(limit?: number): Promise<TransactionRecord[]>
    get(transactionId: string): Promise<TransactionDetail | null>
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
    diagnostics(): Promise<{ path: string }>
    clearDownloads(): Promise<{ freedBytes: number }>
    reset(): Promise<AppSettings>
    databaseInfo(): Promise<DatabaseInfo>
  }
  system: {
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<void>
    showInFolder(path: string): Promise<void>
  }
  events: {
    onQueueUpdate(callback: (snapshot: QueueSnapshot) => void): () => void
    onActivity(callback: (entries: ActivityEntry[]) => void): () => void
    onVerification(callback: (run: VerificationRun) => void): () => void
    onNotification(callback: (notification: AppNotification) => void): () => void
  }
}

export const emptyQueueSnapshot: QueueSnapshot = {
  items: [],
  running: false,
  paused: false,
  pendingCount: 0
}
