import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { PackageDefinition, ProfileDefinition, ValidationIssue } from '@shared/registry'
import {
  validatePackageDefinition,
  validatePackageSemantics,
  validateProfileDefinition
} from '@shared/registry'
import { sortVersionsDescending } from '@shared/version'
import { managerIdForPackage } from '@shared/winget'
import type { AppDatabase } from '../database/Database'
import type { Logger } from '../logging/Logger'

function collectJsonFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(fullPath))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      files.push(fullPath)
    }
  }
  return files.sort()
}

/**
 * Loads the declarative package registry and built-in profiles from disk,
 * validates every definition with zod plus cross-field checks, and syncs the
 * accepted definitions into SQLite. Invalid files are reported instead of
 * being executed.
 */
export class RegistryService {
  private readonly packages = new Map<string, PackageDefinition>()
  private readonly profiles = new Map<string, ProfileDefinition>()
  private readonly issues: ValidationIssue[] = []
  private readonly dynamicPackages = new Set<string>()

  constructor(
    private readonly rootDir: string,
    private readonly db: AppDatabase,
    private readonly logger: Logger
  ) {
    this.load()
  }

  get registryDir(): string {
    return join(this.rootDir, 'registry')
  }

  get profilesDir(): string {
    return join(this.rootDir, 'profiles')
  }

  getIssues(): ValidationIssue[] {
    return [...this.issues]
  }

  addIssues(issues: ValidationIssue[]): void {
    if (issues.length > 0) this.issues.push(...issues)
  }

  private load(): void {
    const packageFiles = collectJsonFiles(this.registryDir)
    for (const file of packageFiles) {
      const label = relative(this.rootDir, file)
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        this.issues.push({
          file: label,
          path: '(root)',
          message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        })
        continue
      }
      const result = validatePackageDefinition(raw, label)
      if (!result.ok) {
        this.issues.push(...result.issues)
        continue
      }
      const semantic = validatePackageSemantics(result.value)
      if (semantic.length > 0) {
        this.issues.push(...semantic.map((issue) => ({ ...issue, file: label })))
        continue
      }
      if (this.packages.has(result.value.id)) {
        this.issues.push({
          file: label,
          path: 'id',
          message: `Duplicate package id "${result.value.id}"`
        })
        continue
      }
      this.packages.set(result.value.id, result.value)
    }

    for (const pkg of [...this.packages.values()]) {
      for (const dependency of pkg.dependencies) {
        if (!this.packages.has(dependency.packageId)) {
          this.issues.push({
            file: pkg.id,
            path: 'dependencies',
            message: `Unknown dependency "${dependency.packageId}"`
          })
        }
      }
    }

    for (const file of collectJsonFiles(this.profilesDir)) {
      const label = relative(this.rootDir, file)
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        this.issues.push({
          file: label,
          path: '(root)',
          message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        })
        continue
      }
      const result = validateProfileDefinition(raw, label)
      if (!result.ok) {
        this.issues.push(...result.issues)
        continue
      }
      const unknown = result.value.components.filter(
        (component) => !this.packages.has(component.packageId)
      )
      if (unknown.length > 0) {
        this.issues.push({
          file: label,
          path: 'components',
          message: `Unknown package${unknown.length === 1 ? '' : 's'}: ${unknown
            .map((component) => component.packageId)
            .join(', ')}`
        })
        continue
      }
      this.profiles.set(result.value.id, result.value)
    }

    const invalidFiles = new Set(this.issues.map((issue) => issue.file))
    if (invalidFiles.size > 0) {
      this.logger.warn('Registry validation issues', {
        issues: this.issues,
        loaded: this.packages.size
      })
    }
  }

  syncDatabase(): void {
    this.db.syncCatalog([...this.packages.values()], [...this.profiles.values()])
    this.logger.info('Package registry synced', {
      packages: this.packages.size,
      profiles: this.profiles.size,
      discovered: this.dynamicPackages.size
    })
  }

  /**
   * Loads packages that were prepared from a discovery result. Built-in
   * registry definitions always win over a persisted discovered copy.
   */
  loadDynamicPackages(inputs: unknown[], label = 'discovered-packages.json'): number {
    let accepted = 0
    for (const input of inputs) {
      const result = validatePackageDefinition(input, label)
      if (!result.ok) {
        this.issues.push(...result.issues.slice(0, 5))
        continue
      }
      const pkg = result.value
      const isWinGet = pkg.origin === 'winget' && pkg.installationMethod === 'winget'
      const isOfficialArchive =
        pkg.origin === 'official' &&
        pkg.installationMethod === 'archive' &&
        pkg.versions.length > 0 &&
        pkg.versions.every((version) => Boolean(version.download))
      if (!isWinGet && !isOfficialArchive) {
        this.issues.push({
          file: label,
          path: 'origin',
          message: `Discovered package "${pkg.id}" must be a validated WinGet or official archive package`
        })
        continue
      }
      const semantics = validatePackageSemantics(pkg)
      if (semantics.length > 0) {
        this.issues.push(...semantics.map((issue) => ({ ...issue, file: label })))
        continue
      }
      if (isWinGet && !managerIdForPackage(pkg)) {
        this.issues.push({
          file: label,
          path: 'packageManagerId',
          message: `Discovered package "${pkg.id}" has no WinGet package id`
        })
        continue
      }
      const existing = this.packages.get(pkg.id)
      if (existing) {
        if (pkg.origin === 'official' && existing.origin === 'official') {
          this.packages.set(pkg.id, pkg)
          this.dynamicPackages.add(pkg.id)
          accepted += 1
          continue
        }
        const existingManager = managerIdForPackage(existing)?.toLowerCase()
        if (existingManager !== managerIdForPackage(pkg)?.toLowerCase()) {
          this.issues.push({
            file: label,
            path: 'id',
            message: `Discovered package id "${pkg.id}" conflicts with an existing package`
          })
        }
        continue
      }
      this.packages.set(pkg.id, pkg)
      this.dynamicPackages.add(pkg.id)
      accepted += 1
    }
    if (this.issues.length > 0) {
      this.logger.warn('Discovered package validation issues', { issues: this.issues })
    }
    return accepted
  }

  registerDynamicPackage(input: PackageDefinition): void {
    const result = validatePackageDefinition(input, 'discovery')
    if (!result.ok) {
      throw new Error(result.issues[0]?.message ?? 'The discovered package definition is invalid.')
    }
    const pkg = result.value
    const isWinGet = pkg.origin === 'winget' && pkg.installationMethod === 'winget'
    const isOfficialArchive =
      pkg.origin === 'official' &&
      pkg.installationMethod === 'archive' &&
      pkg.versions.length > 0 &&
      pkg.versions.every((version) => Boolean(version.download))
    if (isWinGet && !managerIdForPackage(pkg)) {
      throw new Error('Only validated WinGet discovery results can be added as WinGet packages.')
    }
    if (!isWinGet && !isOfficialArchive) {
      throw new Error(
        'Only validated WinGet manifests and official checksum-verified archives can be added to the catalogue.'
      )
    }
    const semantics = validatePackageSemantics(pkg)
    if (semantics.length > 0) {
      throw new Error(semantics[0].message)
    }
    const existing = this.packages.get(pkg.id)
    if (existing && !this.dynamicPackages.has(pkg.id)) {
      throw new Error(`The package id "${pkg.id}" is already used by a built-in package.`)
    }
    if (existing?.origin === 'official' && pkg.origin === 'official') {
      this.packages.set(pkg.id, pkg)
      this.dynamicPackages.add(pkg.id)
      return
    }
    if (
      existing &&
      managerIdForPackage(existing)?.toLowerCase() !== managerIdForPackage(pkg)?.toLowerCase()
    ) {
      throw new Error(`The package id "${pkg.id}" is already used by another discovered package.`)
    }
    this.packages.set(pkg.id, pkg)
    this.dynamicPackages.add(pkg.id)
  }

  listDynamicPackages(): PackageDefinition[] {
    return [...this.dynamicPackages]
      .map((id) => this.packages.get(id))
      .filter((pkg): pkg is PackageDefinition => Boolean(pkg))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  findByManagerId(managerId: string): PackageDefinition | null {
    const target = managerId.toLowerCase()
    for (const pkg of this.packages.values()) {
      if (managerIdForPackage(pkg)?.toLowerCase() === target) return pkg
    }
    return null
  }

  listPackages(): PackageDefinition[] {
    return [...this.packages.values()].sort(
      (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)
    )
  }

  getPackage(id: string): PackageDefinition | null {
    return this.packages.get(id) ?? null
  }

  hasPackage(id: string): boolean {
    return this.packages.has(id)
  }

  listProfiles(): ProfileDefinition[] {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  getProfile(id: string): ProfileDefinition | null {
    return this.profiles.get(id) ?? null
  }

  getDefaultVersion(pkg: PackageDefinition): string | null {
    if (pkg.versions.length === 0) return null
    const explicit = pkg.versions.find((version) => version.isDefault)
    return explicit?.version ?? pkg.versions[0].version
  }

  getLatestVersion(pkg: PackageDefinition): string | null {
    if (pkg.versions.length === 0) return null
    return sortVersionsDescending(pkg.versions.map((version) => version.version))[0] ?? null
  }

  getVersion(pkg: PackageDefinition, requested?: string | null) {
    if (pkg.versions.length === 0) return null
    if (!requested) {
      return pkg.versions.find((version) => version.isDefault) ?? pkg.versions[0]
    }
    return pkg.versions.find((version) => version.version === requested) ?? null
  }
}
