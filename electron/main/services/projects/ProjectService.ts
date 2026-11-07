import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  ProjectConfig,
  ProjectGenerateRequest,
  ProjectGenerateResult,
  ProjectInspection,
  ProjectInstallationOption,
  ProjectRemoveResult
} from '@shared/types'
import {
  buildActivationScript,
  buildDeactivationScript,
  parseProjectConfig,
  type ProjectActivationEntry
} from '@shared/project'
import type { AppDatabase } from '../database/Database'
import type { Logger } from '../logging/Logger'
import type { RegistryService } from '../registry/RegistryService'
import { buildTemplateContext, resolveTemplate } from '../environment/TemplateResolver'
import { AppError } from '../errors'

const projectDirectoryName = '.devforge'
const configFileName = 'environment.json'
const activationFileName = 'activate.ps1'
const deactivationFileName = 'deactivate.ps1'

function isProtectedRoot(candidate: string): boolean {
  const lower = candidate.toLowerCase()
  if (/^[a-z]:\\?$/.test(lower)) return true
  const roots = [
    process.env.SystemRoot ?? 'C:\\Windows',
    process.env.ProgramFiles ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    process.env.ProgramData ?? 'C:\\ProgramData'
  ]
    .filter(Boolean)
    .map((root) => resolve(root).toLowerCase())
  return roots.some((root) => lower === root || lower.startsWith(`${root}\\`))
}

/**
 * Project-scoped runtime pinning. DevForge writes a small manifest and a
 * PowerShell activation script into the project folder. Activating it changes
 * only the current shell, so multiple projects can use different versions
 * without rewriting the machine-wide PATH.
 */
export class ProjectService {
  constructor(
    private readonly db: AppDatabase,
    private readonly registry: RegistryService,
    private readonly logger: Logger,
    private readonly toolsDir: () => string
  ) {}

  private projectDirectory(path: string): string {
    return join(path, projectDirectoryName)
  }

  private configPath(path: string): string {
    return join(this.projectDirectory(path), configFileName)
  }

  private activationPath(path: string): string {
    return join(this.projectDirectory(path), activationFileName)
  }

  private deactivationPath(path: string): string {
    return join(this.projectDirectory(path), deactivationFileName)
  }

  private normalizePath(input: string): string {
    if (!input || input.length > 1024) {
      throw new AppError('VALIDATION', 'Choose a project folder first.')
    }
    const resolved = resolve(input)
    if (!/^[a-zA-Z]:\\/.test(resolved)) {
      throw new AppError('VALIDATION', 'Project folders must be absolute Windows paths.')
    }
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new AppError('NOT_FOUND', 'That project folder no longer exists.')
    }
    if (isProtectedRoot(resolved)) {
      throw new AppError('PERMISSION_DENIED', 'Choose a project folder rather than a Windows system folder.')
    }
    return resolved
  }

  private options(): ProjectInstallationOption[] {
    const records = this.db
      .listInstallations()
      .filter((record) => record.status === 'installed' && record.installDir)
    return records
      .map((record) => ({
        packageId: record.packageId,
        name: this.registry.getPackage(record.packageId)?.name ?? record.packageId,
        version: record.detectedVersion ?? record.version,
        installDir: record.installDir as string,
        active: record.isActive
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  inspect(input: string): ProjectInspection {
    const path = this.normalizePath(input)
    const configPath = this.configPath(path)
    const warnings: string[] = []
    let config: ProjectConfig | null = null
    let configExists = false

    if (existsSync(configPath)) {
      configExists = true
      try {
        if (statSync(configPath).size > 256 * 1024) {
          warnings.push('The project environment file is larger than 256 KB and was ignored.')
        } else {
          const parsed = parseProjectConfig(JSON.parse(readFileSync(configPath, 'utf8')))
          if (parsed.ok) {
            config = parsed.value
          } else {
            warnings.push(...parsed.issues.slice(0, 4))
          }
        }
      } catch (error) {
        warnings.push(
          `The project environment file could not be read: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    const options = this.options()
    for (const [packageId, version] of Object.entries(config?.packages ?? {})) {
      const matches = options.filter(
        (option) => option.packageId === packageId && option.version === version
      )
      if (matches.length === 0) {
        warnings.push(`${packageId} ${version} is pinned but is not installed with a known folder.`)
      }
    }
    if (options.length === 0) {
      warnings.push('DevForge has not recorded any installed tool with a known installation folder yet.')
    }

    return {
      path,
      name: config?.name ?? path.split('\\').filter(Boolean).pop() ?? 'Project',
      configPath,
      configExists,
      config,
      options,
      warnings
    }
  }

  generate(request: ProjectGenerateRequest): ProjectGenerateResult {
    const path = this.normalizePath(request.path)
    if (!request.packages || typeof request.packages !== 'object') {
      throw new AppError('VALIDATION', 'Select at least one package version for the project.')
    }
    const options = this.options()
    const warnings: string[] = []
    const entries: ProjectActivationEntry[] = []
    const pinned: Record<string, string> = {}

    for (const [packageId, version] of Object.entries(request.packages)) {
      const matches = options.filter(
        (option) => option.packageId === packageId && option.version === String(version)
      )
      if (matches.length === 0) {
        throw new AppError(
          'NOT_FOUND',
          `${packageId} ${version} is not installed with a known folder, so it cannot be pinned to this project.`,
          { hint: 'Install that version first, then refresh the project inspection.' }
        )
      }
      const option = matches.find((candidate) => candidate.active) ?? matches[0]
      const pkg = this.registry.getPackage(packageId)
      if (!pkg) {
        throw new AppError('NOT_FOUND', `${packageId} is not in the DevForge catalogue.`)
      }
      const environment: ProjectActivationEntry['environment'] = []
      const context = buildTemplateContext({
        installDir: option.installDir,
        toolsDir: this.toolsDir(),
        version: option.version,
        packageName: pkg.name
      })
      for (const spec of pkg.environment) {
        try {
          const value = resolveTemplate(spec.valueTemplate, context)
          environment.push({ kind: spec.kind, name: spec.name, value })
        } catch (error) {
          warnings.push(
            `${pkg.name}: ${spec.name} was skipped because its template could not be resolved (${error instanceof Error ? error.message : String(error)}).`
          )
        }
      }
      entries.push({
        packageId,
        name: pkg.name,
        version: option.version,
        installDir: option.installDir,
        environment
      })
      pinned[packageId] = option.version
    }

    if (entries.length === 0) {
      throw new AppError('VALIDATION', 'Select at least one installed package version.')
    }

    const name = path.split('\\').filter(Boolean).pop() ?? 'Project'
    const config: ProjectConfig = {
      schemaVersion: 1,
      name,
      packages: pinned
    }
    const directory = this.projectDirectory(path)
    mkdirSync(directory, { recursive: true })
    const configPath = this.configPath(path)
    const scriptPath = this.activationPath(path)
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    writeFileSync(scriptPath, buildActivationScript(entries, name), 'utf8')
    writeFileSync(this.deactivationPath(path), buildDeactivationScript(), 'utf8')

    this.logger.info('Project environment generated', {
      path,
      packages: entries.length
    })
    return {
      path,
      configPath,
      scriptPath,
      command: '. .\\.devforge\\activate.ps1',
      warnings
    }
  }

  remove(input: string): ProjectRemoveResult {
    const path = this.normalizePath(input)
    const directory = this.projectDirectory(path)
    if (!existsSync(directory)) {
      return { path, removed: [] }
    }
    const removed: string[] = []
    for (const fileName of [activationFileName, deactivationFileName, configFileName]) {
      const filePath = join(directory, fileName)
      if (!existsSync(filePath) || !statSync(filePath).isFile()) continue
      try {
        rmSync(filePath, { force: true })
        removed.push(filePath)
      } catch (error) {
        this.logger.warn('Could not remove a project environment file', {
          path: filePath,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    try {
      if (readdirSync(directory).length === 0) rmSync(directory, { recursive: false, force: true })
    } catch {
      // Leave the folder alone when it contains unrelated files.
    }
    this.logger.info('Project environment removed', { path, removed: removed.length })
    return { path, removed }
  }
}
