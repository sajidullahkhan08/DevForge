import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { extractZipSafely } from './ZipExtractor'
import type { PackageDefinition } from '@shared/registry'
import type {
  ConfigurationOutcomeKind,
  EnvPreview,
  InstallationOutcomeKind,
  OperationOutcomeKind,
  OperationSummary,
  PlanStep,
  QueueError,
  QueueStage,
  StageStatus,
  SwitchVersionResult,
  UninstallResult,
  UpdateInfo,
  VerificationOutcomeKind,
  VerificationRun
} from '@shared/types'
import { compareVersions, highestVersion, isSameVersion } from '@shared/version'
import { recommendedRelease } from '@shared/releases'
import type { AppDatabase } from '../database/Database'
import { DownloadManager } from '../download/DownloadManager'
import type { EnvironmentManager } from '../environment/EnvironmentManager'
import { buildTemplateContext, isValidAbsoluteWindowsPath, resolveTemplate, sanitizeDirectoryName } from '../environment/TemplateResolver'
import { AppError, mapWinGetExitCode, toUserFacingError } from '../errors'
import type { Logger } from '../logging/Logger'
import type { ProcessExecutor } from '../process/ProcessExecutor'
import type { RegistryService } from '../registry/RegistryService'
import type { SettingsService } from '../settings/SettingsService'
import type { PowerShellService } from '../system/PowerShellService'
import { powershellScripts } from '../system/PowerShellService'
import type { SoftwareDetector } from '../detection/SoftwareDetector'
import type { VerificationEngine } from '../detection/SoftwareDetector'
import type { IdentityRegistry } from '../identities/IdentityRegistry'
import type { ReleaseResolver } from '../releases/ReleaseResolver'
export interface StageHooks {
  stage(stage: QueueStage, status: StageStatus, detail?: string | null, progress?: number | null): void
}

export interface InstallOutcome {
  status: 'completed' | 'partial' | 'requires-restart'
  installDir: string | null
  detectedVersion: string | null
  verification: VerificationRun | null
  envConfigured: boolean
  summary: OperationSummary
  error: QueueError | null
  message: string | null
}

export interface InstallOptions {
  /** Allow moving an existing, DevForge-managed folder aside before installing a fresh copy. */
  recoverDirectory?: boolean
}

export interface PackageMarker {
  managedBy: 'devforge'
  packageId: string
  version: string
  method: string
  installedAt: string
}

export interface DirectoryInspection {
  exists: boolean
  empty: boolean
  marker: PackageMarker | null
  managedByDatabase: boolean
  missingExecutables: string[]
}

export const packageMarkerFile = '.devforge-package.json'

export function readPackageMarker(directory: string): PackageMarker | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, packageMarkerFile), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as Partial<PackageMarker>
    if (
      candidate.managedBy !== 'devforge' ||
      typeof candidate.packageId !== 'string' ||
      typeof candidate.version !== 'string' ||
      typeof candidate.method !== 'string' ||
      typeof candidate.installedAt !== 'string'
    ) {
      return null
    }
    return candidate as PackageMarker
  } catch {
    return null
  }
}

export function inspectDirectoryContents(
  pkg: PackageDefinition,
  installDir: string
): Omit<DirectoryInspection, 'managedByDatabase'> {
  const exists = existsSync(installDir)
  let entries: string[] = []
  if (exists) {
    try {
      entries = readdirSync(installDir)
    } catch {
      entries = []
    }
  }
  return {
    exists,
    empty: exists && entries.length === 0,
    marker: exists ? readPackageMarker(installDir) : null,
    missingExecutables: exists
      ? pkg.expectedExecutables.filter((relative) => !existsSync(join(installDir, relative)))
      : [...pkg.expectedExecutables]
  }
}

function inspectInstallDirectoryContents(
  pkg: PackageDefinition,
  installDir: string,
  managedByDatabase: boolean
): DirectoryInspection {
  return { ...inspectDirectoryContents(pkg, installDir), managedByDatabase }
}

export interface ExistingDirectoryDecision {
  reuse: boolean
  replace: boolean
  notes: string[]
  conflict: { message: string; hint: string; details?: string } | null
}

/**
 * Classifies an archive package's target folder without touching it. Valid
 * installations are reused, DevForge-owned incomplete folders can only be
 * replaced after explicit confirmation, and folders owned by another package
 * or by the user are never overwritten.
 */
export function decideExistingDirectory(
  pkg: PackageDefinition,
  version: string,
  installDir: string,
  inspection: DirectoryInspection,
  recoverDirectory: boolean
): ExistingDirectoryDecision {
  const markerMatchesPackage = inspection.marker?.packageId === pkg.id
  const markerMatchesVersion = markerMatchesPackage && inspection.marker?.version === version

  if (inspection.exists && !inspection.empty && inspection.missingExecutables.length === 0) {
    if (inspection.marker && !markerMatchesPackage) {
      return {
        reuse: false,
        replace: false,
        notes: [],
        conflict: {
          message: `${installDir} belongs to another DevForge package (${inspection.marker.packageId}) and will not be overwritten.`,
          hint: 'Choose a different installation directory in Settings, or install another version of the package.'
        }
      }
    }
    if (!inspection.marker || markerMatchesVersion) {
      return { reuse: true, replace: false, notes: [], conflict: null }
    }
    return {
      reuse: false,
      replace: true,
      notes: [`Replaced the existing DevForge installation ${inspection.marker.version}.`],
      conflict: null
    }
  }

  if (inspection.exists && !inspection.empty) {
    const managed = markerMatchesPackage || inspection.managedByDatabase
    if (!managed) {
      return {
        reuse: false,
        replace: false,
        notes: [],
        conflict: {
          message: `${installDir} already exists and contains files DevForge did not create. It will not be overwritten.`,
          hint: 'Choose a different installation directory in Settings or install another version. If this folder is a leftover DevForge installation, remove it manually and retry.',
          details: `Missing expected files: ${inspection.missingExecutables.join(', ')}`
        }
      }
    }
    if (!recoverDirectory) {
      return {
        reuse: false,
        replace: false,
        notes: [],
        conflict: {
          message: `${installDir} contains an incomplete DevForge installation from a previous attempt.`,
          hint: 'Retry with folder recovery. DevForge will move the existing folder aside (it is not deleted) and install a fresh copy.',
          details: `Missing expected files: ${inspection.missingExecutables.join(', ')}`
        }
      }
    }
    return {
      reuse: false,
      replace: true,
      notes: ['Recovered an incomplete DevForge installation. The previous folder was moved aside, not deleted.'],
      conflict: null
    }
  }

  return { reuse: false, replace: false, notes: [], conflict: null }
}

function summarizeOperation(
  pkg: PackageDefinition,
  version: string | null,
  installation: InstallationOutcomeKind,
  configuration: ConfigurationOutcomeKind,
  verification: VerificationOutcomeKind,
  restartRequired: boolean,
  notes: string[]
): OperationSummary {
  const parts: string[] = []
  switch (installation) {
    case 'installed':
      parts.push(`Installed ${pkg.name}${version ? ` ${version}` : ''}.`)
      break
    case 'upgraded':
      parts.push(`Updated ${pkg.name}${version ? ` to ${version}` : ''}.`)
      break
    case 'already-installed':
      parts.push(`${pkg.name}${version ? ` ${version}` : ''} was already installed.`)
      break
    case 'configured-only':
      parts.push(`Reused the existing ${pkg.name}${version ? ` ${version}` : ''} installation.`)
      break
  }
  switch (configuration) {
    case 'applied':
      parts.push('Environment configured.')
      break
    case 'already-configured':
      parts.push('Environment was already configured.')
      break
    case 'not-required':
      parts.push('No environment changes were required.')
      break
    case 'failed':
      parts.push('Environment configuration did not finish.')
      break
  }
  switch (verification) {
    case 'passed':
      parts.push('Verification passed.')
      break
    case 'failed':
      parts.push('Verification failed.')
      break
    case 'skipped':
      parts.push('Verification was skipped.')
      break
    case 'not-run':
      break
  }
  if (restartRequired) parts.push('A Windows restart is required.')
  parts.push(...notes)

  const outcome: OperationOutcomeKind =
    configuration === 'failed' || verification === 'failed'
      ? 'partial'
      : restartRequired
        ? 'requires-restart'
        : installation === 'configured-only' && configuration !== 'applied'
          ? 'completed-no-changes'
          : 'completed'

  return {
    installation,
    configuration,
    verification,
    outcome,
    summary: parts.join(' ')
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = cursor++
      if (current >= items.length) return
      results[current] = await worker(items[current])
    }
  })
  await Promise.all(runners)
  return results
}

const stageOrder: QueueStage[] = [
  'checking',
  'resolving',
  'downloading',
  'verifying-download',
  'installing',
  'configuring',
  'verifying',
  'completed'
]

export function createStageState(): { stage: QueueStage; label: string; status: StageStatus; detail: null }[] {
  const labels: Record<QueueStage, string> = {
    checking: 'Checking system compatibility',
    resolving: 'Resolving dependencies',
    downloading: 'Downloading package',
    'verifying-download': 'Verifying download',
    installing: 'Installing',
    configuring: 'Configuring environment',
    verifying: 'Verifying installation',
    completed: 'Completed'
  }
  return stageOrder.map((stage) => ({ stage, label: labels[stage], status: 'pending' as StageStatus, detail: null }))
}

export class InstallationEngine {
  constructor(
    private readonly registry: RegistryService,
    private readonly db: AppDatabase,
    private readonly settings: SettingsService,
    private readonly env: EnvironmentManager,
    private readonly executor: ProcessExecutor,
    private readonly ps: PowerShellService,
    private readonly downloader: DownloadManager,
    private readonly detector: SoftwareDetector,
    private readonly verification: VerificationEngine,
    private readonly logger: Logger,
    private readonly identities: IdentityRegistry,
    private readonly releases: ReleaseResolver
  ) {}

  private log(
    transactionId: string,
    stage: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    extra: { command?: string | null; args?: string[] | null; exitCode?: number | null; stdout?: string | null; stderr?: string | null } = {}
  ): void {
    this.db.addLog({ transactionId, stage, level, message, ...extra })
  }

  private getPackage(packageId: string): PackageDefinition {
    const pkg = this.registry.getPackage(packageId)
    if (!pkg) throw new AppError('NOT_FOUND', `The package "${packageId}" is not in the registry.`)
    return pkg
  }

  private getInstallDirectory(
    pkg: PackageDefinition,
    version: string,
    fallbackInstallDir?: string | null
  ): string {
    const template = pkg.installDirectoryTemplate
    if (!template) {
      if (fallbackInstallDir) return fallbackInstallDir
      return join(
        this.settings.toolsDir(),
        sanitizeDirectoryName(pkg.name),
        sanitizeDirectoryName(version)
      )
    }
    const context = buildTemplateContext({
      installDir: fallbackInstallDir ?? null,
      toolsDir: this.settings.toolsDir(),
      version,
      packageName: pkg.name
    })
    const resolved = resolveTemplate(template, context)
    if (!isValidAbsoluteWindowsPath(resolved)) {
      throw new AppError('VALIDATION', `The installation directory for ${pkg.name} is not valid.`)
    }
    return resolved
  }

  private inspectInstallDirectory(pkg: PackageDefinition, installDir: string): DirectoryInspection {
    const normalizedTarget = resolve(installDir).toLowerCase()
    const managedByDatabase = this.db
      .listInstallationsForPackage(pkg.id)
      .some((record) => record.installDir !== null && resolve(record.installDir).toLowerCase() === normalizedTarget)
    return inspectInstallDirectoryContents(pkg, installDir, managedByDatabase)
  }

  private writePackageMarker(installDir: string, pkg: PackageDefinition, version: string): void {
    const marker: PackageMarker = {
      managedBy: 'devforge',
      packageId: pkg.id,
      version,
      method: pkg.installationMethod,
      installedAt: new Date().toISOString()
    }
    try {
      writeFileSync(join(installDir, packageMarkerFile), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.logger.warn('Could not write the DevForge package marker', {
        packageId: pkg.id,
        installDir,
        error: String(error)
      })
    }
  }

  /** Moves an existing folder aside instead of deleting it so no files can be lost. */
  private quarantineDirectory(installDir: string): string {
    const backupDir = `${installDir}.devforge-backup-${Date.now().toString(36)}`
    renameSync(installDir, backupDir)
    return backupDir
  }

  private async runStage(
    stage: QueueStage,
    hooks: StageHooks,
    task: () => Promise<string | null | void>
  ): Promise<void> {
    hooks.stage(stage, 'in-progress', null, null)
    try {
      const detail = await task()
      hooks.stage(stage, 'completed', detail ?? null, null)
    } catch (error) {
      const friendly = toUserFacingError(error)
      hooks.stage(stage, 'failed', friendly.message, null)
      throw error
    }
  }

  private async runInstaller(
    command: string,
    args: string[],
    options: { timeoutMs: number; stage: string; transactionId: string; signal: AbortSignal }
  ): Promise<{ exitCode: number; output: string; restartRequired: boolean }> {
    this.log(options.transactionId, options.stage, 'info', `Running ${command}`, { command, args })
    let result
    try {
      result = await this.executor.run(command, args, {
        env: await this.env.getMergedProcessEnv(),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        maxOutputBytes: 2 * 1024 * 1024
      })
    } catch (error) {
      if (this.executor.isCancellation(error)) {
        throw new AppError('CANCELLED', 'The operation was cancelled.', {
          hint: 'Windows may need a moment to finish shutting down the installer process. Check Installed Software afterwards.'
        })
      }
      throw error
    }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    this.log(options.transactionId, options.stage, 'info', `Installer finished with exit code ${result.exitCode}`, {
      command,
      args,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-12000),
      stderr: result.stderr.slice(-12000)
    })

    const mapped = mapWinGetExitCode(result.exitCode, output)
    if (mapped) {
      if (mapped.code === 'INSTALLER_RESTART') {
        this.log(options.transactionId, options.stage, 'warn', 'Installer requested a Windows restart')
        return { exitCode: result.exitCode, output, restartRequired: true }
      }
      throw mapped
    }
    return { exitCode: result.exitCode, output, restartRequired: false }
  }

  private async installWithWinget(
    pkg: PackageDefinition,
    step: PlanStep,
    transactionId: string,
    signal: AbortSignal,
    hooks: StageHooks
  ): Promise<{ installDir: string | null; restartRequired: boolean; alreadyInstalled: boolean }> {
    const versionDefinition = pkg.versions.find((candidate) => candidate.version === step.version)
    const packageId = versionDefinition?.packageManagerId ?? pkg.packageManagerId
    if (!packageId) {
      throw new AppError('VALIDATION', `${pkg.name} does not define a WinGet package id.`)
    }
    const winget = await this.env.getWingetVersion()
    if (!winget) {
      throw new AppError('WINGET_MISSING', 'WinGet is not available on this computer.', {
        hint: 'Install or repair App Installer from the Microsoft Store, then restart DevForge.'
      })
    }

    hooks.stage('downloading', 'skipped', 'WinGet downloads and installs the package itself.', null)
    hooks.stage('verifying-download', 'skipped', 'WinGet verifies installer signatures.', null)

    let restartRequired = false
    let alreadyInstalled = false
    await this.runStage('installing', hooks, async () => {
      const args = [
        'install',
        '--id',
        packageId,
        '--exact',
        '--source',
        'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
        '--silent'
      ]
      if (step.version && pkg.origin !== 'winget') {
        args.push('--version', step.version)
      }
      if (pkg.scope === 'system' || pkg.requiresAdmin) {
        args.push('--scope', 'machine')
      }
      const result = await this.runInstaller('winget', args, {
        timeoutMs: 30 * 60 * 1000,
        stage: 'installing',
        transactionId,
        signal
      })
      restartRequired = result.restartRequired
      alreadyInstalled = /already installed|No newer package versions|No available upgrade/i.test(result.output)
      return alreadyInstalled
        ? `WinGet reports ${pkg.name} is already installed.`
        : restartRequired
          ? 'Installer completed. Restart Windows to finish.'
          : 'WinGet finished installing the package.'
    })

    return { installDir: null, restartRequired, alreadyInstalled }
  }

  private async installFromArchive(
    pkg: PackageDefinition,
    step: PlanStep,
    transactionId: string,
    signal: AbortSignal,
    hooks: StageHooks,
    options: InstallOptions = {}
  ): Promise<{ installDir: string; restartRequired: boolean; alreadyInstalled: boolean; notes: string[] }> {
    const versionDefinition = pkg.versions.find((candidate) => candidate.version === step.version)
    if (!versionDefinition?.download) {
      throw new AppError('VALIDATION', `${pkg.name} does not define a download for version ${step.version}.`)
    }
    const download = versionDefinition.download
    const version = step.version ?? versionDefinition.version
    const installDir = this.getInstallDirectory(pkg, version)
    const inspection = this.inspectInstallDirectory(pkg, installDir)
    const decision = decideExistingDirectory(pkg, version, installDir, inspection, options.recoverDirectory ?? false)
    const notes: string[] = []
    let replaceExisting = decision.replace

    if (decision.conflict) {
      throw new AppError('DIRECTORY_CONFLICT', decision.conflict.message, {
        hint: decision.conflict.hint,
        details: decision.conflict.details ?? null
      })
    }
    notes.push(...decision.notes)

    if (decision.reuse) {
      if (!inspection.marker) {
        this.writePackageMarker(installDir, pkg, version)
      }
      hooks.stage('downloading', 'skipped', 'Existing files are valid; no download is required.', null)
      hooks.stage('verifying-download', 'skipped', 'No download was required.', null)
      await this.runStage('installing', hooks, async () => {
        return `Validated and reused the existing installation at ${installDir}.`
      })
      this.log(transactionId, 'installing', 'info', `Reused existing installation at ${installDir}`)
      return { installDir, restartRequired: false, alreadyInstalled: true, notes }
    }

    let filePath = ''
    await this.runStage('downloading', hooks, async () => {
      hooks.stage('downloading', 'in-progress', `Downloading ${pkg.name} ${version}`, 0)
      const result = await this.downloader.download({
        packageId: pkg.id,
        version,
        url: download.url,
        checksum: download.checksum,
        algorithm: download.checksumAlgorithm,
        sizeBytes: download.sizeBytes,
        signal,
        onProgress: (progress) => {
          hooks.stage(
            'downloading',
            'in-progress',
            progress.totalBytes
              ? `${Math.round(progress.receivedBytes / 1024 / 1024)} MB of ${Math.round(progress.totalBytes / 1024 / 1024)} MB`
              : `${Math.round(progress.receivedBytes / 1024 / 1024)} MB downloaded`,
            progress.percent
          )
        }
      })
      filePath = result.filePath
      this.log(transactionId, 'downloading', 'info', 'Download completed', {
        stdout: `Saved to ${result.filePath}`
      })
      return result.reused ? 'Using a previously verified download.' : 'Download finished.'
    })

    await this.runStage('verifying-download', hooks, async () => {
      return `${download.checksumAlgorithm.toUpperCase()} checksum verified.`
    })

    await this.runStage('installing', hooks, async () => {
      const staging = join(this.settings.toolsDir(), '.staging', transactionId)
      mkdirSync(staging, { recursive: true })
      try {
        await extractZipSafely(filePath, staging)
      } catch (error) {
        rmSync(staging, { recursive: true, force: true })
        throw new AppError('INSTALLER_FAILED', `The archive for ${pkg.name} could not be extracted.`, {
          hint: 'The download is verified, so this usually means the archive layout or format is unsupported.',
          details: error instanceof Error ? error.message : String(error)
        })
      }

      const entries = readdirSync(staging)
      let source = staging
      if (download.stripRootFolder && entries.length === 1) {
        const candidate = join(staging, entries[0])
        if (statSync(candidate).isDirectory()) source = candidate
      }

      const missing = pkg.expectedExecutables.filter((relative) => !existsSync(join(source, relative)))
      if (missing.length > 0) {
        rmSync(staging, { recursive: true, force: true })
        throw new AppError(
          'INSTALLER_FAILED',
          `The extracted ${pkg.name} package is missing expected files.`,
          {
            hint: 'The vendor archive layout may have changed. Check for an updated DevForge package definition.',
            details: `Missing: ${missing.join(', ')}`
          }
        )
      }

      mkdirSync(dirname(installDir), { recursive: true })
      if (existsSync(installDir)) {
        if (replaceExisting || inspection.marker || inspection.managedByDatabase) {
          const backupDir = this.quarantineDirectory(installDir)
          notes.push(`The previous folder was moved to ${backupDir}.`)
          this.log(transactionId, 'installing', 'warn', `Moved the previous installation folder to ${backupDir}`)
        } else {
          rmSync(installDir, { recursive: true, force: true })
        }
      }
      try {
        renameSync(source, installDir)
      } catch {
        cpSync(source, installDir, { recursive: true })
      }
      rmSync(staging, { recursive: true, force: true })
      this.writePackageMarker(installDir, pkg, version)

      this.log(transactionId, 'installing', 'info', `Extracted ${pkg.name} to ${installDir}`)
      return `Installed to ${installDir}`
    })

    return { installDir, restartRequired: false, alreadyInstalled: false, notes }
  }

  private async installWithOfficialInstaller(
    pkg: PackageDefinition,
    step: PlanStep,
    transactionId: string,
    signal: AbortSignal,
    hooks: StageHooks
  ): Promise<{ installDir: string | null; restartRequired: boolean }> {
    const versionDefinition = pkg.versions.find((candidate) => candidate.version === step.version)
    if (!versionDefinition?.download) {
      throw new AppError('VALIDATION', `${pkg.name} does not define an installer download.`)
    }
    const download = versionDefinition.download
    let filePath = ''
    await this.runStage('downloading', hooks, async () => {
      hooks.stage('downloading', 'in-progress', `Downloading ${pkg.name} ${step.version}`, 0)
      const result = await this.downloader.download({
        packageId: pkg.id,
        version: step.version ?? versionDefinition.version,
        url: download.url,
        checksum: download.checksum,
        algorithm: download.checksumAlgorithm,
        sizeBytes: download.sizeBytes,
        signal,
        onProgress: (progress) => {
          hooks.stage(
            'downloading',
            'in-progress',
            progress.percent !== null ? `${progress.percent}% downloaded` : 'Downloading installer',
            progress.percent
          )
        }
      })
      filePath = result.filePath
      return result.reused ? 'Using a previously verified download.' : 'Download finished.'
    })

    await this.runStage('verifying-download', hooks, async () => {
      const messages = [`${download.checksumAlgorithm.toUpperCase()} checksum verified.`]
      if (download.signature) {
        const signature = await this.ps.runJson<{
          status: string
          subject: string
          thumbprint: string
        }>(powershellScripts.authenticodeSignature, { path: filePath }, 30000)
        if (!signature || signature.status.trim() !== 'Valid') {
          throw new AppError(
            'VERIFICATION_FAILED',
            `${pkg.name} did not pass Authenticode signature verification.`,
            {
              hint: 'Delete the cached installer and try again, or install this package from its official website.',
              details: signature ? `Signature status: ${signature.status}` : 'No signature information was returned.'
            }
          )
        }
        const expectedPublisher = download.signature.publisher.toLowerCase()
        if (!signature.subject.toLowerCase().includes(expectedPublisher)) {
          throw new AppError(
            'VERIFICATION_FAILED',
            `The installer for ${pkg.name} was signed by an unexpected publisher.`,
            {
              hint: 'DevForge did not run the installer. Review the package definition or contact the package author.',
              details: `Expected "${download.signature.publisher}", received "${signature.subject}".`
            }
          )
        }
        if (
          download.signature.thumbprint &&
          signature.thumbprint.toLowerCase() !== download.signature.thumbprint.toLowerCase()
        ) {
          throw new AppError(
            'VERIFICATION_FAILED',
            `The installer certificate for ${pkg.name} does not match the pinned thumbprint.`,
            {
              hint: 'DevForge did not run the installer. The publisher may have rotated certificates; update the package definition after verifying the new signer.',
              details: `Expected ${download.signature.thumbprint}, received ${signature.thumbprint}.`
            }
          )
        }
        messages.push(`Authenticode signer verified (${download.signature.publisher}).`)
      }
      return messages.join(' ')
    })

    let restartRequired = false
    await this.runStage('installing', hooks, async () => {
      const result = await this.runInstaller(filePath, versionDefinition.installArgs ?? [], {
        timeoutMs: 30 * 60 * 1000,
        stage: 'installing',
        transactionId,
        signal
      })
      restartRequired = result.restartRequired
      return restartRequired ? 'Installer completed. Restart Windows to finish.' : 'Installer finished.'
    })

    let installDir: string | null = null
    try {
      installDir = pkg.installDirectoryTemplate ? this.getInstallDirectory(pkg, step.version ?? versionDefinition.version) : null
    } catch {
      installDir = null
    }
    return { installDir, restartRequired }
  }

  private async configureEnvironment(
    pkg: PackageDefinition,
    step: PlanStep,
    transactionId: string,
    installDir: string | null,
    detectedVersion: string | null,
    installationId: number,
    hooks: StageHooks
  ): Promise<{
    outcome: ConfigurationOutcomeKind
    envConfigured: boolean
    error: QueueError | null
    changeCount: number
    warning: string | null
  }> {
    if (pkg.environment.length === 0) {
      hooks.stage('configuring', 'skipped', 'No environment changes are required.', null)
      return { outcome: 'not-required', envConfigured: true, error: null, changeCount: 0, warning: null }
    }

    const state: { outcome: ConfigurationOutcomeKind } = { outcome: 'failed' }
    let changeCount = 0
    let warning: string | null = null
    try {
      await this.runStage('configuring', hooks, async () => {
        const preview = await this.env.applyPackageEnvironment(pkg, installDir, {
          transactionId,
          packageId: pkg.id,
          version: step.version
        })
        changeCount = preview.changes.length
        if (preview.outcome === 'nothing-to-do' && preview.warnings.length > 0) {
          throw new AppError('ENVIRONMENT_FAILED', `The environment templates for ${pkg.name} could not be resolved.`, {
            hint: 'Check the DevForge logs for the unresolved template values.',
            details: preview.warnings.join('\n')
          })
        }
        if (preview.warnings.length > 0) {
          warning = preview.warnings[0]
          this.log(transactionId, 'configuring', 'warn', 'Environment note', {
            stdout: preview.warnings.join('\n')
          })
        }
        this.db.updateInstallationAfterInstall(installationId, {
          installDir,
          detectedVersion,
          envStatus: 'configured'
        })
        if (preview.outcome === 'applied') {
          state.outcome = 'applied'
          return `${preview.changes.length} environment change${preview.changes.length === 1 ? '' : 's'} applied.`
        }
        state.outcome = 'already-configured'
        return 'Environment was already configured. No changes were required.'
      })
      return {
        outcome: state.outcome,
        envConfigured: state.outcome === 'applied' || state.outcome === 'already-configured',
        error: null,
        changeCount,
        warning
      }
    } catch (error) {
      const friendly = toUserFacingError(error)
      this.db.updateInstallationAfterInstall(installationId, {
        installDir,
        detectedVersion,
        envStatus: 'not-configured',
        status: 'installed'
      })
      return {
        outcome: 'failed',
        envConfigured: false,
        error: {
          ...friendly,
          message: `${pkg.name} was installed, but its environment configuration did not finish.`,
          hint:
            friendly.hint ??
            'Open Environment Variables to review PATH, or retry the configuration from Installed Software.'
        },
        changeCount,
        warning
      }
    }
  }

  private async verifyPackage(
    pkg: PackageDefinition,
    step: PlanStep,
    transactionId: string,
    installDir: string | null,
    hooks: StageHooks
  ): Promise<{ outcome: VerificationOutcomeKind; run: VerificationRun | null; error: QueueError | null }> {
    const autoVerify = this.settings.get().autoVerify
    if (!autoVerify) {
      hooks.stage('verifying', 'skipped', 'Automatic verification is disabled in Settings.', null)
      return { outcome: 'skipped', run: null, error: null }
    }
    if (pkg.verification.length === 0) {
      hooks.stage('verifying', 'skipped', 'No verification checks are defined for this package.', null)
      return { outcome: 'skipped', run: null, error: null }
    }

    let run: VerificationRun | null = null
    try {
      await this.runStage('verifying', hooks, async () => {
        run = await this.verification.verify(pkg, {
          version: step.version,
          installDir,
          transactionId
        })
        if (run.status === 'failed') {
          const failed = run.checks.filter((check) => !check.passed && !check.optional)
          throw new AppError('VERIFICATION_FAILED', `${pkg.name} was installed, but verification failed.`, {
            hint: 'Open a new terminal and try again. If the problem persists, use Repair Configuration or inspect the installation logs.',
            details: failed.map((check) => `${check.label}: ${check.error ?? check.output}`).join('\n')
          })
        }
        return 'All verification checks passed.'
      })
      return { outcome: 'passed', run, error: null }
    } catch (error) {
      const friendly = toUserFacingError(error)
      return {
        outcome: 'failed',
        run,
        error: {
          ...friendly,
          hint: friendly.hint ?? 'Review the verification output, then retry verification from Installed Software.'
        }
      }
    }
  }

  private combineErrors(errors: (QueueError | null)[]): QueueError | null {
    const list = errors.filter((error): error is QueueError => error !== null)
    if (list.length === 0) return null
    if (list.length === 1) return list[0]
    const hints = list.map((error) => error.hint).filter((hint): hint is string => Boolean(hint))
    const details = list.map((error) => error.details).filter((detail): detail is string => Boolean(detail))
    return {
      code: list[0].code,
      message: list.map((error) => error.message).join(' '),
      hint: hints.length > 0 ? hints.join(' ') : null,
      details: details.length > 0 ? details.join('\n\n') : null
    }
  }

  private async configureInstalledPackage(
    pkg: PackageDefinition,
    step: PlanStep,
    transactionId: string,
    signal: AbortSignal,
    hooks: StageHooks
  ): Promise<InstallOutcome> {
    const records = this.db
      .listInstallationsForPackage(pkg.id)
      .filter((record) => record.status === 'installed')
    const target =
      records.find(
        (record) =>
          record.isActive && isSameVersion(record.detectedVersion ?? record.version, step.version ?? '')
      ) ?? records.find((record) => isSameVersion(record.detectedVersion ?? record.version, step.version ?? ''))
    if (!target) {
      throw new AppError(
        'NOT_FOUND',
        `${pkg.name} ${step.version ?? ''} is no longer recorded as installed.`,
        { hint: 'Refresh Installed Software, then try again.' }
      )
    }
    if (signal.aborted) throw new AppError('CANCELLED', 'The configuration was cancelled before it started.')

    const detectedVersion = target.detectedVersion ?? target.version
    const installDir = target.installDir
    this.log(transactionId, 'checking', 'info', `Configuring existing ${pkg.name} ${target.version} installation`)
    hooks.stage('checking', 'completed', `Existing ${pkg.name} ${target.version} installation found.`, null)
    hooks.stage('resolving', 'skipped', 'No dependencies need to be installed.', null)
    hooks.stage('downloading', 'skipped', 'The existing installation is reused; no download is required.', null)
    hooks.stage('verifying-download', 'skipped', 'No download was required.', null)
    hooks.stage('installing', 'skipped', 'Installed files are already present and were not reinstalled.', null)

    const configuration = await this.configureEnvironment(
      pkg,
      step,
      transactionId,
      installDir,
      detectedVersion,
      target.id,
      hooks
    )
    const verification = await this.verifyPackage(pkg, step, transactionId, installDir, hooks)

    this.db.updateInstallationAfterInstall(target.id, {
      installDir,
      detectedVersion,
      envStatus: configuration.envConfigured ? 'configured' : 'not-configured',
      verificationStatus: verification.run
        ? verification.run.status === 'passed'
          ? 'verified'
          : 'failed'
        : this.settings.get().autoVerify && pkg.verification.length > 0
          ? 'pending'
          : 'unknown',
      status: 'installed',
      isActive: true
    })

    const summary = summarizeOperation(
      pkg,
      step.version,
      'configured-only',
      configuration.outcome,
      verification.outcome,
      false,
      []
    )
    const error = this.combineErrors([configuration.error, verification.error])
    this.db.addActivity({
      type: 'configure',
      level: summary.outcome === 'partial' ? 'warning' : 'success',
      title:
        summary.outcome === 'partial'
          ? `Configuration incomplete for ${pkg.name}`
          : `Configured ${pkg.name}`,
      message: summary.summary,
      packageId: pkg.id
    })
    hooks.stage(
      'completed',
      'completed',
      summary.outcome === 'partial' ? 'Configuration finished with errors.' : 'Configuration complete.',
      null
    )

    return {
      status: summary.outcome === 'partial' ? 'partial' : 'completed',
      installDir,
      detectedVersion,
      verification: verification.run,
      envConfigured: configuration.envConfigured,
      summary,
      error,
      message: summary.summary
    }
  }

  async install(
    step: PlanStep,
    transactionId: string,
    signal: AbortSignal,
    hooks: StageHooks,
    options: InstallOptions = {}
  ): Promise<InstallOutcome> {
    const pkg = this.getPackage(step.packageId)
    if (step.action === 'skip') {
      hooks.stage('checking', 'completed', 'Already satisfied.', null)
      hooks.stage('resolving', 'skipped', 'No installation is required.', null)
      hooks.stage('downloading', 'skipped', 'The package is already installed.', null)
      hooks.stage('verifying-download', 'skipped', 'No download was required.', null)
      hooks.stage('installing', 'skipped', 'The existing installation is reused.', null)
      hooks.stage('configuring', 'skipped', 'An installation is not required.', null)
      hooks.stage('verifying', 'skipped', 'No verification was requested.', null)
      const summary = summarizeOperation(
        pkg,
        step.alreadyInstalledVersion ?? step.version,
        'already-installed',
        'not-required',
        'not-run',
        false,
        []
      )
      hooks.stage('completed', 'completed', 'Already satisfied.', null)
      return {
        status: 'completed',
        installDir: null,
        detectedVersion: step.alreadyInstalledVersion,
        verification: null,
        envConfigured: false,
        summary,
        error: null,
        message: summary.summary
      }
    }
    if (pkg.installationMethod === 'project-recipe') {
      throw new AppError(
        'UNSUPPORTED',
        `${pkg.name} is a project-level tool and is not installed globally. Follow its setup recipe inside your project.`
      )
    }
    if (!step.version) {
      throw new AppError('VALIDATION', `No installable version was selected for ${pkg.name}.`)
    }
    if (signal.aborted) throw new AppError('CANCELLED', 'The operation was cancelled before it started.')

    if (step.action === 'configure') {
      return this.configureInstalledPackage(pkg, step, transactionId, signal, hooks)
    }

    this.log(transactionId, 'checking', 'info', `Preparing ${pkg.name} ${step.version}`)

    await this.runStage('checking', hooks, async () => {
      if (step.action === 'upgrade' && step.alreadyInstalledVersion) {
        return `Replacing ${pkg.name} ${step.alreadyInstalledVersion} with ${step.version}.`
      }
      return 'System compatibility checked.'
    })

    await this.runStage('resolving', hooks, async () => {
      return pkg.dependencies.length === 0
        ? 'No dependencies required.'
        : `${pkg.dependencies.length} dependenc${pkg.dependencies.length === 1 ? 'y' : 'ies'} resolved.`
    })

    let installDir: string | null = null
    let restartRequired = false
    let alreadyInstalled = false
    const notes: string[] = []
    if (pkg.installationMethod === 'winget') {
      const result = await this.installWithWinget(pkg, step, transactionId, signal, hooks)
      installDir = result.installDir
      restartRequired = result.restartRequired
      alreadyInstalled = result.alreadyInstalled
    } else if (pkg.installationMethod === 'archive') {
      const result = await this.installFromArchive(pkg, step, transactionId, signal, hooks, options)
      installDir = result.installDir
      restartRequired = result.restartRequired
      alreadyInstalled = result.alreadyInstalled
      notes.push(...result.notes)
    } else if (pkg.installationMethod === 'official-installer') {
      const result = await this.installWithOfficialInstaller(pkg, step, transactionId, signal, hooks)
      installDir = result.installDir
      restartRequired = result.restartRequired
    } else {
      throw new AppError('UNSUPPORTED', `${pkg.name} uses an unsupported installation method.`)
    }

    if (signal.aborted) {
      throw new AppError('CANCELLED', 'The operation was cancelled after the installer started.', {
        hint: 'The package may be partially installed. Check Installed Software and repair it if needed.'
      })
    }

    this.detector.invalidate()
    this.env.invalidate()
    const detection = await this.detector.detectPackage(pkg)
    installDir = installDir ?? detection.installDir
    const detectedVersion = detection.version

    const installationId = this.db.upsertInstallation({
      packageId: pkg.id,
      version: step.version,
      method: pkg.installationMethod,
      source: 'devforge',
      installDir,
      detectedVersion,
      availableVersion: null,
      envStatus: 'not-configured',
      verificationStatus: this.settings.get().autoVerify ? 'pending' : 'unknown',
      isActive: true
    })
    this.db.setActiveInstallation(pkg.id, step.version)
    this.db.setAvailableVersion(pkg.id, null)

    const configuration = await this.configureEnvironment(
      pkg,
      step,
      transactionId,
      installDir,
      detectedVersion,
      installationId,
      hooks
    )
    const verification = await this.verifyPackage(pkg, step, transactionId, installDir, hooks)

    const finalInstallDir = installDir ?? detection.installDir
    this.db.updateInstallationAfterInstall(installationId, {
      installDir: finalInstallDir,
      detectedVersion,
      envStatus: configuration.envConfigured ? 'configured' : 'not-configured',
      verificationStatus: verification.run
        ? verification.run.status === 'passed'
          ? 'verified'
          : 'failed'
        : this.settings.get().autoVerify && pkg.verification.length > 0
          ? 'pending'
          : 'unknown',
      status: 'installed',
      isActive: true
    })

    const installationKind: InstallationOutcomeKind = alreadyInstalled
      ? 'already-installed'
      : step.action === 'upgrade'
        ? 'upgraded'
        : 'installed'
    const summary = summarizeOperation(
      pkg,
      step.version,
      installationKind,
      configuration.outcome,
      verification.outcome,
      restartRequired,
      notes
    )
    const error = this.combineErrors([configuration.error, verification.error])

    this.db.addActivity({
      type: step.action === 'upgrade' ? 'update' : 'install',
      level: summary.outcome === 'partial' ? 'warning' : 'success',
      title:
        summary.outcome === 'partial'
          ? `${pkg.name} ${step.version} finished with issues`
          : `${step.action === 'upgrade' ? 'Updated' : 'Installed'} ${pkg.name} ${step.version}`,
      message: summary.summary,
      packageId: pkg.id
    })

    this.log(transactionId, 'completed', 'info', `${pkg.name} operation completed`, {
      stdout: JSON.stringify({
        installationId,
        installDir: finalInstallDir,
        detectedVersion,
        summary
      })
    })

    hooks.stage(
      'completed',
      'completed',
      summary.outcome === 'partial'
        ? 'Finished with issues. Review the details below.'
        : restartRequired
          ? 'Windows restart required.'
          : 'Installation complete.',
      null
    )

    return {
      status: summary.outcome === 'partial' ? 'partial' : restartRequired ? 'requires-restart' : 'completed',
      installDir: finalInstallDir,
      detectedVersion,
      verification: verification.run,
      envConfigured: configuration.envConfigured,
      summary,
      error,
      message: summary.summary
    }
  }

  async uninstall(packageId: string, options: { removeDirectory?: boolean } = {}): Promise<UninstallResult> {
    const pkg = this.getPackage(packageId)
    const records = this.db
      .listInstallationsForPackage(packageId)
      .filter((record) => record.status === 'installed')
    const record = records.find((candidate) => candidate.isActive) ?? records[0]
    if (!record) {
      throw new AppError('NOT_FOUND', `${pkg.name} is not recorded as installed.`)
    }
    const method = pkg.uninstall?.method ?? (pkg.installationMethod === 'winget' ? 'winget' : null)
    if (!method) {
      throw new AppError(
        'UNSUPPORTED',
        `DevForge does not know how to uninstall ${pkg.name} automatically.`,
        { hint: 'Use the official uninstaller from Windows Settings, then verify the environment in DevForge.' }
      )
    }
    let output = ''
    if (method === 'winget') {
      const versionDefinition = pkg.versions.find((version) => version.version === record.version)
      const wingetId = versionDefinition?.packageManagerId ?? pkg.packageManagerId
      if (!wingetId) throw new AppError('VALIDATION', `${pkg.name} does not define a WinGet package id.`)
      const result = await this.executor.run(
        'winget',
        [
          'uninstall',
          '--id',
          wingetId,
          '--exact',
          '--silent',
          '--disable-interactivity',
          '--accept-source-agreements'
        ],
        { env: await this.env.getMergedProcessEnv(), timeoutMs: 15 * 60 * 1000 }
      )
      output = `${result.stdout}\n${result.stderr}`.trim()
      if (result.exitCode !== 0) {
        const mapped = mapWinGetExitCode(result.exitCode, output)
        if (mapped) throw mapped
      }
    } else if (method === 'command') {
      if (!pkg.uninstall?.command) {
        throw new AppError('VALIDATION', `${pkg.name} does not define an uninstall command.`)
      }
      const result = await this.executor.run(pkg.uninstall.command, pkg.uninstall.args ?? [], {
        env: await this.env.getMergedProcessEnv(),
        timeoutMs: 15 * 60 * 1000
      })
      output = `${result.stdout}\n${result.stderr}`.trim()
      if (result.exitCode !== 0) {
        throw new AppError('INSTALLER_FAILED', `The ${pkg.name} uninstaller exited with code ${result.exitCode}.`, {
          hint: 'Inspect the uninstall output for details.',
          details: output.slice(-4000)
        })
      }
    }

    let removedDirectory = false
    if (options.removeDirectory) {
      if (!record.installDir) {
        output += '\nNo installation directory was recorded, so no files were deleted.'
      } else if (pkg.category === 'database') {
        output += '\nDatabase files were preserved because removing them could destroy your data.'
      } else {
        const toolsRoot = resolve(this.settings.toolsDir()).toLowerCase()
        const target = resolve(record.installDir)
        if (!target.toLowerCase().startsWith(`${toolsRoot}\\`) || target.toLowerCase() === toolsRoot) {
          output += `\n${target} is outside the DevForge tools directory, so it was not deleted to avoid removing unrelated files.`
        } else if (existsSync(target)) {
          try {
            rmSync(target, { recursive: true, force: true })
            removedDirectory = true
            output += `\nRemoved ${target}`
          } catch (error) {
            output += `\nCould not remove ${target}: ${error instanceof Error ? error.message : String(error)}`
          }
        }
      }
    }

    let environmentRestored = false
    let environmentMessage = ''
    try {
      const preview = await this.env.revertPackageEnvironment(pkg.id)
      environmentRestored = true
      environmentMessage =
        preview.changes.length > 0
          ? ` Restored ${preview.changes.length} environment change${preview.changes.length === 1 ? '' : 's'}.`
          : ' No DevForge environment changes needed to be reverted.'
    } catch (error) {
      environmentMessage = ` Environment cleanup did not finish: ${toUserFacingError(error).message}`
      this.logger.warn('Environment cleanup failed after uninstall', {
        packageId,
        error: String(error)
      })
    }

    this.db.markPackageRemoved(packageId)
    this.db.addActivity({
      type: 'uninstall',
      level: 'info',
      title: `Uninstalled ${pkg.name}`,
      message: `${environmentMessage.trim()}${removedDirectory ? ' Installation folder removed.' : ''}`,
      packageId
    })
    this.detector.invalidate()
    this.env.invalidate()

    return {
      success: true,
      output: output.trim() || 'The uninstall command completed.',
      environmentRestored,
      message: `${pkg.name} was uninstalled.${environmentMessage}${
        removedDirectory ? ' The installation folder was deleted.' : ''
      }`
    }
  }

  async repair(packageId: string): Promise<EnvPreview> {
    const pkg = this.getPackage(packageId)
    const records = this.db
      .listInstallationsForPackage(packageId)
      .filter((record) => record.status === 'installed')
    const record = records.find((candidate) => candidate.isActive) ?? records[0]
    if (!record) {
      throw new AppError('NOT_FOUND', `${pkg.name} is not installed, so there is nothing to repair.`)
    }
    if (pkg.environment.length === 0) {
      throw new AppError('UNSUPPORTED', `${pkg.name} does not need environment configuration.`)
    }
    const preview = await this.env.applyPackageEnvironment(pkg, record.installDir, {
      packageId,
      version: record.version
    })
    this.db.updateInstallationAfterInstall(record.id, {
      installDir: record.installDir,
      detectedVersion: record.detectedVersion,
      envStatus: preview.errors.length === 0 ? 'configured' : 'not-configured',
      status: 'installed',
      isActive: record.isActive
    })
    const message =
      preview.outcome === 'applied'
        ? `${preview.changes.length} environment change${preview.changes.length === 1 ? '' : 's'} re-applied.`
        : preview.outcome === 'already-satisfied'
          ? 'The environment was already configured. No changes were required.'
          : 'No environment changes were required.'
    this.db.addActivity({
      type: 'configure',
      level: 'success',
      title: `Repaired ${pkg.name} configuration`,
      message,
      packageId
    })
    return preview
  }

  async switchVersion(packageId: string, version: string): Promise<SwitchVersionResult> {
    const pkg = this.getPackage(packageId)
    if (!pkg.supportsVersionSwitching) {
      throw new AppError(
        'UNSUPPORTED',
        `${pkg.name} does not support switching versions through DevForge.`,
        { hint: 'Install the desired version from Discover Software.' }
      )
    }
    const records = this.db
      .listInstallationsForPackage(packageId)
      .filter((record) => record.status === 'installed')
    const target = records.find((record) => record.version === version)
    if (!target) {
      throw new AppError('NOT_FOUND', `${pkg.name} ${version} is not installed. Install it first.`)
    }
    await this.env.revertPackageEnvironment(packageId)
    const preview = await this.env.applyPackageEnvironment(pkg, target.installDir, {
      packageId,
      version: target.version
    })
    this.db.setActiveInstallation(packageId, target.version)
    this.db.addActivity({
      type: 'configure',
      level: 'success',
      title: `Switched ${pkg.name} to ${target.detectedVersion ?? target.version}`,
      message: 'Environment variables now point to the selected installation.',
      packageId
    })
    return {
      success: true,
      message: `DevForge switched ${pkg.name} to ${target.detectedVersion ?? target.version}. Open a new terminal to use it.`,
      envPreview: preview
    }
  }

  async checkUpdates(): Promise<UpdateInfo[]> {
    const installed = this.db.listInstallations().filter((record) => record.status === 'installed')
    const seen = new Set<string>()
    const candidates = installed.filter((record) => {
      if (!record.isActive || seen.has(record.packageId)) return false
      seen.add(record.packageId)
      return true
    })
    const checkUpstream = this.settings.get().checkUpstreamUpdates

    const results = await mapWithConcurrency(candidates, 4, async (record): Promise<UpdateInfo | null> => {
      const pkg = this.registry.getPackage(record.packageId)
      if (!pkg || pkg.versions.length === 0) return null
      // Prefer whichever known version is higher. A stale detection result
      // must not make an already-updated package look outdated.
      const installedVersion = highestVersion([record.version, record.detectedVersion])
      if (!installedVersion) return null
      const latest = [...pkg.versions].sort((a, b) => compareVersions(b.version, a.version))[0]
      if (!latest) return null

      const registryUpdate = compareVersions(latest.version, installedVersion) > 0
      let upstreamVersion: string | null = null
      let upstreamChannel: string | null = null
      let upstreamProvenance: string | null = null
      let upstreamError: string | null = null

      if (checkUpstream) {
        const identity = this.identities.forPackage(pkg)
        if (identity && identity.versionSource !== 'none' && identity.versionSource !== 'winget') {
          try {
            const resolution = await this.releases.resolve(identity, latest.version)
            const release = recommendedRelease(resolution)
            if (release && release.channel !== 'preview' && compareVersions(release.version, installedVersion) > 0) {
              upstreamVersion = release.version
              upstreamChannel = release.channel
              upstreamProvenance = `${resolution.source.label}${resolution.stale ? ' (cached)' : ''}`
            }
            upstreamError = resolution.error
          } catch (error) {
            upstreamError = error instanceof Error ? error.message : String(error)
          }
        }
      }

      if (registryUpdate) {
        const note =
          upstreamVersion && compareVersions(upstreamVersion, latest.version) > 0
            ? ` The vendor reports ${upstreamVersion}, which is newer than the verified package (${latest.version}).`
            : null
        this.db.saveUpdateCache(pkg.id, latest.version)
        this.db.setAvailableVersion(pkg.id, latest.version)
        return {
          packageId: pkg.id,
          name: pkg.name,
          currentVersion: installedVersion,
          availableVersion: latest.version,
          method: pkg.installationMethod,
          installable: pkg.installationMethod !== 'project-recipe',
          source: 'registry',
          channel: latest.channel ?? null,
          provenance: 'DevForge package definition',
          reason: note
        }
      }

      if (upstreamVersion) {
        this.db.setAvailableVersion(pkg.id, null)
        return {
          packageId: pkg.id,
          name: pkg.name,
          currentVersion: installedVersion,
          availableVersion: upstreamVersion,
          method: pkg.installationMethod,
          installable: false,
          source: 'upstream',
          channel: upstreamChannel,
          provenance: upstreamProvenance,
          reason: `The vendor reports ${upstreamVersion}, but DevForge has no verified installation procedure for that release yet. This is informational until a validated package is available.`
        }
      }

      this.db.setAvailableVersion(pkg.id, null)
      if (upstreamError) {
        this.logger.debug('Upstream update check did not produce a newer release', {
          packageId: pkg.id,
          error: upstreamError
        })
      }
      return null
    })

    return results
      .filter((update): update is UpdateInfo => update !== null)
      .sort((left, right) => left.name.localeCompare(right.name))
  }
}
