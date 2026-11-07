import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PackageDefinition, VerificationSpec } from '@shared/registry'
import {
  extractVersion,
  highestVersion,
  isSameVersion,
  compareVersions,
  testPattern
} from '@shared/version'
import { managerIdForPackage, parseWinGetListTable } from '@shared/winget'
import type { InstalledSummary, VerificationCheck, VerificationRun } from '@shared/types'
import type { AppDatabase } from '../database/Database'
import type { EnvironmentManager } from '../environment/EnvironmentManager'
import { AppError } from '../errors'
import type { Logger } from '../logging/Logger'
import type { ProcessExecutor } from '../process/ProcessExecutor'
import type { PowerShellService } from '../system/PowerShellService'
import { powershellScripts } from '../system/PowerShellService'
import { buildTemplateContext, resolveTemplate } from '../environment/TemplateResolver'
import { mapLimit } from '../discovery/concurrency'

interface UninstallEntry {
  DisplayName?: string
  DisplayVersion?: string
  InstallLocation?: string
  Publisher?: string
}

export interface DetectionResult {
  packageId: string
  installed: boolean
  version: string | null
  installDir: string | null
  displayName: string | null
  source: 'devforge' | 'external'
  evidence: string[]
}

interface ServiceInfo {
  exists?: boolean
  name?: string
  status?: string
}

const registryScanTtlMs = 2 * 60 * 1000

function normalizeInstallRoot(path: string | null): string | null {
  if (!path) return null
  const cleaned = path.replace(/[\\/]+$/, '')
  return /[\\/](bin|cmd)$/i.test(cleaned) ? dirname(cleaned) : cleaned
}

export class VerificationEngine {
  constructor(
    private readonly db: AppDatabase,
    private readonly executor: ProcessExecutor,
    private readonly env: EnvironmentManager,
    private readonly ps: PowerShellService,
    private readonly logger: Logger
  ) {}

  private async runCommandCheck(
    spec: VerificationSpec,
    extraDirs: string[]
  ): Promise<VerificationCheck> {
    const command = spec.command ?? ''
    const args = spec.args ?? []
    const label = spec.label
    if (!command) {
      return {
        id: spec.id,
        label,
        command: '(missing command)',
        passed: false,
        output: '',
        expected: spec.expectPattern ?? null,
        error: 'The registry definition does not specify a command.',
        optional: spec.optional
      }
    }
    try {
      const result = await this.executor.run(command, args, {
        env: await this.env.getMergedProcessEnv(extraDirs),
        timeoutMs: 20000,
        maxOutputBytes: 256 * 1024
      })
      const output = `${result.stdout}\n${result.stderr}`.trim()
      const pattern = spec.expectPattern
      const passed = pattern ? testPattern(output, pattern) : result.exitCode === 0
      return {
        id: spec.id,
        label,
        command: [command, ...args].join(' '),
        passed,
        output: output.slice(-6000),
        expected: pattern ?? 'exit code 0',
        error: passed ? null : `The command ran but its output did not match the expected value.`,
        optional: spec.optional
      }
    } catch (error) {
      return {
        id: spec.id,
        label,
        command: [command, ...args].join(' '),
        passed: false,
        output: '',
        expected: spec.expectPattern ?? 'exit code 0',
        error: error instanceof Error ? error.message : String(error),
        optional: spec.optional
      }
    }
  }

  private async runServiceCheck(spec: VerificationSpec): Promise<VerificationCheck> {
    const pattern = spec.serviceNamePattern ?? ''
    try {
      const info = await this.ps.runJson<ServiceInfo>(
        powershellScripts.serviceInfo,
        { pattern },
        20000
      )
      const status = info?.status ?? 'Unknown'
      const exists = Boolean(info?.exists)
      const passed = exists && (spec.expectPattern ? testPattern(status, spec.expectPattern) : true)
      return {
        id: spec.id,
        label: spec.label,
        command: `Get-Service -Name "${pattern}"`,
        passed,
        output: exists ? `${info?.name ?? pattern}: ${status}` : 'Service not found',
        expected: spec.expectPattern ?? 'Service present',
        error: passed ? null : 'The Windows service was not found or is not running.',
        optional: spec.optional
      }
    } catch (error) {
      return {
        id: spec.id,
        label: spec.label,
        command: `Get-Service -Name "${pattern}"`,
        passed: false,
        output: '',
        expected: spec.expectPattern ?? 'Service present',
        error: error instanceof Error ? error.message : String(error),
        optional: spec.optional
      }
    }
  }

  private async runFileCheck(
    spec: VerificationSpec,
    packageName: string,
    installDir: string | null,
    version: string | null
  ): Promise<VerificationCheck> {
    try {
      if (!spec.filePathTemplate) {
        throw new AppError('VALIDATION', 'The registry definition does not specify a file path.')
      }
      const context = buildTemplateContext({
        installDir,
        toolsDir: installDir ? dirname(installDir) : '',
        version,
        packageName
      })
      const filePath = resolveTemplate(spec.filePathTemplate, context)
      const exists = existsSync(filePath)
      return {
        id: spec.id,
        label: spec.label,
        command: `Test-Path "${filePath}"`,
        passed: exists,
        output: exists ? filePath : 'File not found',
        expected: filePath,
        error: exists ? null : 'The expected file does not exist.',
        optional: spec.optional
      }
    } catch (error) {
      return {
        id: spec.id,
        label: spec.label,
        command: spec.filePathTemplate ?? '(missing path)',
        passed: false,
        output: '',
        expected: spec.filePathTemplate ?? null,
        error: error instanceof Error ? error.message : String(error),
        optional: spec.optional
      }
    }
  }

  private async runWingetCheck(spec: VerificationSpec, packageId: string | null): Promise<VerificationCheck> {
    if (!packageId) {
      return {
        id: spec.id,
        label: spec.label,
        command: 'winget list',
        passed: false,
        output: '',
        expected: 'A package manager id',
        error: 'The registry definition does not specify a WinGet package id.',
        optional: spec.optional
      }
    }
    try {
      const result = await this.executor.run(
        'winget',
        ['list', '--id', packageId, '--exact', '--accept-source-agreements', '--disable-interactivity'],
        {
          env: await this.env.getMergedProcessEnv(),
          timeoutMs: 60000,
          maxOutputBytes: 256 * 1024
        }
      )
      const output = `${result.stdout}\n${result.stderr}`.trim()
      const passed = result.exitCode === 0 && output.toLowerCase().includes(packageId.toLowerCase())
      return {
        id: spec.id,
        label: spec.label,
        command: `winget list --id ${packageId}`,
        passed,
        output: output.slice(-4000),
        expected: packageId,
        error: passed ? null : 'WinGet does not list this package as installed.',
        optional: spec.optional
      }
    } catch (error) {
      return {
        id: spec.id,
        label: spec.label,
        command: `winget list --id ${packageId}`,
        passed: false,
        output: '',
        expected: packageId,
        error: error instanceof Error ? error.message : String(error),
        optional: spec.optional
      }
    }
  }

  async verify(
    pkg: PackageDefinition,
    options: {
      version?: string | null
      installDir?: string | null
      transactionId?: string | null
      extraDirs?: string[]
      emit?: (run: VerificationRun) => void
      recordActivity?: boolean
    } = {}
  ): Promise<VerificationRun> {
    const version = options.version ?? null
    const runId = this.db.createVerificationRun(pkg.id, version, options.transactionId ?? null)
    const packageManagerId =
      pkg.versions.find((candidate) => candidate.version === version)?.packageManagerId ??
      pkg.packageManagerId ??
      null
    const extraDirs = [
      ...(options.extraDirs ?? []),
      ...(options.installDir ? [options.installDir, join(options.installDir, 'bin')] : [])
    ]

    const checks: VerificationCheck[] = []
    for (const spec of pkg.verification) {
      let check: VerificationCheck
      if (spec.kind === 'command') {
        check = await this.runCommandCheck(spec, extraDirs)
      } else if (spec.kind === 'service') {
        check = await this.runServiceCheck(spec)
      } else if (spec.kind === 'file') {
        check = await this.runFileCheck(spec, pkg.name, options.installDir ?? null, version)
      } else {
        check = await this.runWingetCheck(spec, packageManagerId)
      }
      checks.push(check)
      this.db.addVerificationCheck(runId, check)
    }

    const requiredChecks = checks.filter((check) => !check.optional)
    const passed = requiredChecks.length === 0 ? true : requiredChecks.every((check) => check.passed)
    this.db.finishVerificationRun(runId, passed ? 'passed' : 'failed')
    this.db.setInstallationVerification(pkg.id, passed ? 'verified' : 'failed')

    if (options.recordActivity !== false) {
      this.db.addActivity({
        type: 'verify',
        level: passed ? 'success' : 'warning',
        title: passed ? `${pkg.name} verified` : `${pkg.name} verification failed`,
        message: passed
          ? `${requiredChecks.length} check${requiredChecks.length === 1 ? '' : 's'} passed.`
          : checks.filter((check) => !check.passed).map((check) => check.label).join(', '),
        packageId: pkg.id
      })
    }

    const run = this.db.getVerificationRun(runId)
    if (!run) throw new AppError('DATABASE', 'The verification record could not be stored.')
    options.emit?.(run)
    this.logger.info('Verification finished', { packageId: pkg.id, passed, checks: checks.length })
    return run
  }
}

export class SoftwareDetector {
  private registryScan: { entries: UninstallEntry[]; takenAt: number } | null = null
  private wingetScan: { rows: Map<string, string | null>; takenAt: number } | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly executor: ProcessExecutor,
    private readonly env: EnvironmentManager,
    private readonly ps: PowerShellService,
    private readonly logger: Logger,
    private readonly getToolsDir: () => string
  ) {}

  invalidate(): void {
    this.registryScan = null
  }

  private async getUninstallEntries(): Promise<UninstallEntry[]> {
    if (this.registryScan && Date.now() - this.registryScan.takenAt < registryScanTtlMs) {
      return this.registryScan.entries
    }
    try {
      const raw = await this.ps.runJson<UninstallEntry[]>(
        powershellScripts.scanUninstallRegistry,
        undefined,
        60000
      )
      const entries = Array.isArray(raw) ? raw : raw ? [raw] : []
      this.registryScan = { entries, takenAt: Date.now() }
      return entries
    } catch (error) {
      this.logger.warn('Could not scan the Windows uninstall registry', { error: String(error) })
      this.registryScan = { entries: [], takenAt: Date.now() }
      return []
    }
  }

  /**
   * One WinGet listing is shared by every package in a detection pass. This
   * keeps external installations visible without spawning a process per
   * package.
   */
  private async getWinGetListings(): Promise<Map<string, string | null>> {
    const now = Date.now()
    if (this.wingetScan && now - this.wingetScan.takenAt < registryScanTtlMs) {
      return this.wingetScan.rows
    }
    try {
      const result = await this.executor.run(
        'winget',
        ['list', '--accept-source-agreements', '--disable-interactivity'],
        { timeoutMs: 45000, maxOutputBytes: 4 * 1024 * 1024 }
      )
      const rows = new Map<string, string | null>()
      if (result.exitCode === 0) {
        for (const row of parseWinGetListTable(result.stdout)) {
          rows.set(row.id.toLowerCase(), row.version)
        }
      }
      this.wingetScan = { rows, takenAt: now }
      return rows
    } catch (error) {
      this.logger.warn('Could not scan WinGet installed packages', { error: String(error) })
      this.wingetScan = { rows: new Map(), takenAt: now }
      return this.wingetScan.rows
    }
  }

  private async getServiceStatus(pattern: string): Promise<ServiceInfo | null> {
    try {
      return await this.ps.runJson<ServiceInfo>(
        powershellScripts.serviceInfo,
        { pattern },
        20000
      )
    } catch {
      return null
    }
  }

  private async resolveInstallDirFromCommand(command: string, extraDirs: string[]): Promise<string | null> {
    try {
      const result = await this.executor.run('where', [command], {
        env: await this.env.getMergedProcessEnv(extraDirs),
        timeoutMs: 10000
      })
      const first = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      if (!first) return null
      const directory = dirname(first)
      if (/(^|\\)(bin|cmd)$/i.test(directory)) return dirname(directory)
      return directory
    } catch {
      return null
    }
  }

  async detectPackage(pkg: PackageDefinition): Promise<DetectionResult> {
    const result: DetectionResult = {
      packageId: pkg.id,
      installed: false,
      version: null,
      installDir: null,
      displayName: null,
      source: 'external',
      evidence: []
    }
    if (pkg.installationMethod === 'project-recipe') return result

    const records = this.db
      .listInstallationsForPackage(pkg.id)
      .filter((record) => record.status !== 'removed')
    const primaryRecord: InstalledSummary | null =
      records.find((record) => record.source === 'devforge') ?? records[0] ?? null
    if (primaryRecord?.installDir) result.installDir = primaryRecord.installDir
    if (primaryRecord?.source) result.source = primaryRecord.source
    // The recorded install version is only a fallback. A previous detection may
    // be stale (for example, from another toolchain earlier on PATH), so fresh
    // command, registry or WinGet evidence must always win.
    const fallbackVersion = primaryRecord?.version ?? null

    const context = buildTemplateContext({
      installDir: primaryRecord?.installDir ?? null,
      toolsDir: this.getToolsDir(),
      version: null,
      packageName: pkg.name
    })
    const knownPaths: string[] = []
    for (const template of pkg.detection.knownPaths) {
      try {
        knownPaths.push(resolveTemplate(template, context))
      } catch {
        // Paths that need a version or install directory are resolved later.
      }
    }
    const existingKnownPaths = knownPaths.filter((path) => existsSync(path))
    const extraDirs = [...existingKnownPaths]
    if (primaryRecord?.installDir) {
      extraDirs.push(primaryRecord.installDir, join(primaryRecord.installDir, 'bin'))
    }

    let commandOutput = ''
    if (pkg.detection.command) {
      try {
        const probe = await this.executor.run(pkg.detection.command, pkg.detection.args ?? [], {
          env: await this.env.getMergedProcessEnv(extraDirs),
          timeoutMs: 15000,
          maxOutputBytes: 128 * 1024
        })
        commandOutput = `${probe.stdout}\n${probe.stderr}`.trim()
        if (commandOutput) {
          const displayOk = pkg.detection.displayNamePattern
            ? new RegExp(pkg.detection.displayNamePattern, 'i').test(commandOutput)
            : true
          const version = extractVersion(commandOutput, pkg.detection.versionPattern)
          if (displayOk && (version || probe.exitCode === 0)) {
            result.installed = true
            result.version = result.version ?? version
            result.evidence.push(`${pkg.detection.command} -> ${commandOutput.split(/\r?\n/)[0].slice(0, 160)}`)
            if (!result.installDir) {
              result.installDir = await this.resolveInstallDirFromCommand(pkg.detection.command, extraDirs)
            }
          }
        }
      } catch {
        // The command is not available in this environment.
      }
    }

    const entries = await this.getUninstallEntries()
    const displayPattern = pkg.detection.displayNamePattern
    const matchingEntry =
      displayPattern && entries.length > 0
        ? entries.find((entry) => {
            try {
              return new RegExp(displayPattern, 'i').test(String(entry.DisplayName ?? ''))
            } catch {
              return false
            }
          })
        : undefined

    if (!result.installed && matchingEntry) {
      result.installed = true
      result.version = matchingEntry.DisplayVersion ? String(matchingEntry.DisplayVersion) : result.version
      result.displayName = matchingEntry.DisplayName ? String(matchingEntry.DisplayName) : null
      if (!result.installDir && matchingEntry.InstallLocation) {
        result.installDir = String(matchingEntry.InstallLocation)
      }
      result.evidence.push(`Windows uninstall entry: ${matchingEntry.DisplayName}`)
    }

    if (!result.installed && pkg.installationMethod === 'winget') {
      const managerId = managerIdForPackage(pkg)
      if (managerId) {
        const listings = await this.getWinGetListings()
        const key = managerId.toLowerCase()
        if (listings.has(key)) {
          result.installed = true
          result.version = result.version ?? listings.get(key) ?? null
          result.evidence.push(`WinGet package: ${managerId}`)
        }
      }
    }

    if (!result.installed && pkg.detection.serviceNamePattern) {
      const service = await this.getServiceStatus(pkg.detection.serviceNamePattern)
      if (service?.exists) {
        result.installed = true
        result.displayName = service.name ?? null
        result.evidence.push(`Windows service: ${service.name} (${service.status})`)
      }
    }

    if (!result.installed && existingKnownPaths.length > 0) {
      const folder = existingKnownPaths[0]
      result.installed = true
      result.installDir = folder
      result.evidence.push(`Installation folder: ${folder}`)
    }

    if (result.installed) {
      result.version = result.version ?? fallbackVersion
      result.installDir = normalizeInstallRoot(result.installDir ?? knownPaths[0] ?? null)
      result.displayName =
        result.displayName ?? (matchingEntry?.DisplayName ? String(matchingEntry.DisplayName) : pkg.name)
    }

    this.logger.debug('Detection result', {
      packageId: pkg.id,
      installed: result.installed,
      version: result.version,
      evidence: result.evidence
    })
    return result
  }

  async refreshInstalledPackages(
    packages: PackageDefinition[]
  ): Promise<{ detections: DetectionResult[]; installations: InstalledSummary[] }> {
    this.registryScan = null
    // Warm the shared registry and WinGet caches once so parallel detection
    // does not spawn duplicate scans.
    await Promise.all([this.getUninstallEntries(), this.getWinGetListings()])
    const detected = await mapLimit(packages, 4, async (pkg) => {
      try {
        return { pkg, detection: await this.detectPackage(pkg) }
      } catch (error) {
        this.logger.warn('Detection failed', { packageId: pkg.id, error: String(error) })
        return null
      }
    })
    const detections: DetectionResult[] = []
    for (const entry of detected) {
      if (!entry) continue
      const { pkg, detection } = entry
      detections.push(detection)
      const records = this.db
        .listInstallationsForPackage(pkg.id)
        .filter((record) => record.status !== 'removed')
      const devforgeRecord = records.find((record) => record.source === 'devforge')

      if (detection.installed) {
        const latest = pkg.versions.length
          ? [...pkg.versions].map((version) => version.version).sort((a, b) => compareVersions(b, a))[0]
          : null
        // Compare against the highest known version. A stale PATH probe must
        // not make a just-updated DevForge installation look out of date.
        const knownVersion = highestVersion([devforgeRecord?.version, detection.version])
        const availableVersion =
          knownVersion && latest && compareVersions(latest, knownVersion) > 0 ? latest : null

        if (devforgeRecord) {
          const id = this.db.upsertInstallation({
            packageId: pkg.id,
            version: devforgeRecord.version,
            method: devforgeRecord.method,
            source: 'devforge',
            installDir: detection.installDir ?? devforgeRecord.installDir,
            detectedVersion: detection.version ?? devforgeRecord.detectedVersion,
            availableVersion,
            verificationStatus: devforgeRecord.verificationStatus,
            envStatus: devforgeRecord.envStatus,
            isActive: devforgeRecord.status === 'installed',
            installedAt: devforgeRecord.installedAt
          })
          if (id !== devforgeRecord.id) {
            this.logger.warn('Installation record changed unexpectedly during refresh', { packageId: pkg.id })
          }
          this.db.setAvailableVersion(pkg.id, availableVersion)
        } else {
          const version = detection.version ?? records[0]?.version ?? 'unknown'
          const sameExternal = records.find(
            (record) => record.source === 'external' && isSameVersion(record.version, version)
          )
          if (!sameExternal) {
            this.db.markExternalInstallationsRemoved(pkg.id)
            this.db.upsertInstallation({
              packageId: pkg.id,
              version,
              method: pkg.installationMethod,
              source: 'external',
              installDir: detection.installDir,
              detectedVersion: detection.version,
              availableVersion,
              verificationStatus: 'unknown',
              envStatus: 'unknown',
              isActive: true
            })
            this.db.addActivity({
              type: 'detect',
              level: 'info',
              title: `Detected ${pkg.name}`,
              message: detection.evidence[0] ?? null,
              packageId: pkg.id
            })
          } else {
            this.db.setAvailableVersion(pkg.id, availableVersion)
          }
        }
      }
    }
    return { detections, installations: this.db.listInstallations() }
  }
}
