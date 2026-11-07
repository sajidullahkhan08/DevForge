import type {
  DashboardData,
  HealthCheck,
  InstalledSummary,
  PackageCategory,
  UpdateInfo
} from '@shared/types'
import type { AppDatabase } from '../database/Database'
import type { EnvironmentManager } from '../environment/EnvironmentManager'
import type { InstallationEngine } from '../install/InstallationEngine'
import type { InstallationQueue } from '../install/InstallationQueue'
import type { CatalogueService } from '../catalogue/CatalogueService'
import type { ProfileService } from '../profiles/ProfileService'
import { compareVersions, highestVersion } from '@shared/version'

export class DashboardService {
  constructor(
    private readonly db: AppDatabase,
    private readonly env: EnvironmentManager,
    private readonly queue: InstallationQueue,
    private readonly catalogue: CatalogueService,
    private readonly profiles: ProfileService,
    private readonly engine: InstallationEngine
  ) {}

  private activeInstallations(): InstalledSummary[] {
    const records = this.db
      .listInstallations()
      .filter((record) => record.status === 'installed')
      .sort((a, b) => compareVersions(b.installedAt, a.installedAt))
    const selected = new Map<string, InstalledSummary>()
    for (const record of records) {
      const existing = selected.get(record.packageId)
      if (!existing) {
        selected.set(record.packageId, record)
        continue
      }
      if (record.isActive && !existing.isActive) {
        selected.set(record.packageId, record)
      }
    }
    return [...selected.values()]
  }

  async get(): Promise<DashboardData> {
    const installations = this.activeInstallations()
    const catalogue = this.catalogue.list()
    const updates = await this.engine.checkUpdates()
    const profiles = this.profiles.list()
    const installedIds = new Set(installations.map((record) => record.packageId))
    const queue = this.queue.getSnapshot()

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const recentInstalls = this.db
      .listInstallations()
      .filter(
        (record) =>
          record.source === 'devforge' &&
          new Date(record.installedAt).getTime() >= sevenDaysAgo &&
          record.status !== 'removed'
      ).length

    const activeProfiles = profiles.filter((profile) => {
      const required = profile.components.filter((component) => !component.optional)
      const relevant = required.length > 0 ? required : profile.components
      return relevant.some((component) => installedIds.has(component.packageId)) &&
        required.every((component) => installedIds.has(component.packageId))
    }).length

    const health: HealthCheck[] = [...(await this.env.validate())]
    const seenHealth = new Set(health.map((check) => check.id))
    for (const record of installations) {
      const item = catalogue.find((candidate) => candidate.package.id === record.packageId)
      if (!item) continue
      const pkg = item.package
      if (record.verificationStatus === 'failed') {
        const id = `verification-${pkg.id}`
        if (!seenHealth.has(id)) {
          seenHealth.add(id)
          health.push({
            id,
            label: `${pkg.name} verification`,
            status: 'error',
            detail: `The last verification run for ${pkg.name} did not pass.`,
            packageId: pkg.id,
            fixHint: 'Use Verify, then Repair Configuration if the environment is stale.'
          })
        }
      } else if (record.envStatus === 'not-configured' && pkg.environment.length > 0) {
        const id = `env-${pkg.id}`
        if (!seenHealth.has(id)) {
          seenHealth.add(id)
          health.push({
            id,
            label: `${pkg.name} environment`,
            status: 'warning',
            detail: `${pkg.name} is installed but its environment variables were not fully configured.`,
            packageId: pkg.id,
            fixHint: 'Use Repair Configuration on the Installed Software page.'
          })
        }
      } else if (record.verificationStatus === 'verified') {
        const id = `available-${pkg.id}`
        if (!seenHealth.has(id)) {
          seenHealth.add(id)
          health.push({
            id,
            label: `${pkg.name} availability`,
            status: 'ok',
            detail: `${pkg.name} ${highestVersion([record.version, record.detectedVersion]) ?? record.version} is installed and verified.`,
            packageId: pkg.id,
            fixHint: null
          })
        }
      }
    }

    const categoryCounts = new Map<PackageCategory, number>()
    for (const record of installations) {
      const item = catalogue.find((candidate) => candidate.package.id === record.packageId)
      if (!item) continue
      categoryCounts.set(item.package.category, (categoryCounts.get(item.package.category) ?? 0) + 1)
    }

    const updateList: UpdateInfo[] = updates

    return {
      stats: {
        installedCount: installations.length,
        updatesCount: updateList.length,
        activeProfiles,
        recentInstalls,
        pendingOperations: queue.items.filter(
          (item) => item.status === 'pending' || item.status === 'running'
        ).length
      },
      installations,
      health,
      activity: this.db.listActivity(12),
      queue,
      updates: updateList,
      categoryBreakdown: [...categoryCounts.entries()].map(([category, count]) => ({ category, count }))
    }
  }
}
