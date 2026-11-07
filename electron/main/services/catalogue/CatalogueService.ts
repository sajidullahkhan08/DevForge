import type { CatalogueItem, InstalledSummary } from '@shared/types'
import type { CanonicalIdentity } from '@shared/identity'
import type { PackageDefinition } from '@shared/registry'
import { compareVersions, highestVersion, sortVersionsDescending } from '@shared/version'
import type { AppDatabase } from '../database/Database'
import type { IdentityRegistry } from '../identities/IdentityRegistry'
import type { RegistryService } from '../registry/RegistryService'

export class CatalogueService {
  constructor(
    private readonly registry: RegistryService,
    private readonly db: AppDatabase,
    private readonly identities: IdentityRegistry
  ) {}

  private groupInstalled(): Map<string, InstalledSummary[]> {
    const map = new Map<string, InstalledSummary[]>()
    for (const record of this.db.listInstallations()) {
      if (record.status === 'removed') continue
      const list = map.get(record.packageId) ?? []
      list.push(record)
      map.set(record.packageId, list)
    }
    return map
  }

  private toItem(
    pkg: PackageDefinition,
    installations: InstalledSummary[],
    identity: CanonicalIdentity | null
  ): CatalogueItem {
    const installed =
      installations.find((record) => record.isActive && record.status === 'installed') ??
      installations.find((record) => record.status === 'installed') ??
      null
    const latestVersion =
      pkg.versions.length > 0
        ? sortVersionsDescending(pkg.versions.map((version) => version.version))[0] ?? null
        : null
    const defaultVersion =
      pkg.versions.find((version) => version.isDefault)?.version ?? latestVersion
    // Detection can lag behind a completed installation, so never compare the
    // registry against a detected version lower than the recorded install.
    const currentVersion = installed
      ? highestVersion([installed.version, installed.detectedVersion])
      : null
    const updateAvailable = Boolean(
      installed &&
        latestVersion &&
        currentVersion &&
        compareVersions(latestVersion, currentVersion) > 0
    )
    return {
      package: pkg,
      identity,
      defaultVersion,
      latestVersion,
      installed,
      installations,
      updateAvailable,
      availableVersion: updateAvailable ? latestVersion : null
    }
  }

  list(): CatalogueItem[] {
    const installed = this.groupInstalled()
    return this.registry
      .listPackages()
      .map((pkg) => this.toItem(pkg, installed.get(pkg.id) ?? [], this.identities.forPackage(pkg)))
  }

  get(packageId: string): CatalogueItem | null {
    const pkg = this.registry.getPackage(packageId)
    if (!pkg) return null
    const installations = this.db
      .listInstallationsForPackage(packageId)
      .filter((record) => record.status !== 'removed')
    return this.toItem(pkg, installations, this.identities.forPackage(pkg))
  }
}
