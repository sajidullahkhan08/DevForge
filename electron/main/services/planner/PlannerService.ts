import type { InstallRequest, InstallationPlan } from '@shared/types'
import type { AppDatabase } from '../database/Database'
import type { EnvironmentManager } from '../environment/EnvironmentManager'
import { AppError } from '../errors'
import type { Logger } from '../logging/Logger'
import type { RegistryService } from '../registry/RegistryService'
import type { PowerShellService } from '../system/PowerShellService'
import { powershellScripts } from '../system/PowerShellService'
import { buildInstallationPlan } from './Planner'

export class PlannerService {
  constructor(
    private readonly registry: RegistryService,
    private readonly db: AppDatabase,
    private readonly ps: PowerShellService,
    private readonly env: EnvironmentManager,
    private readonly logger: Logger,
    private readonly getToolsDir: () => string
  ) {}

  async preview(requests: InstallRequest[]): Promise<InstallationPlan> {
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new AppError('VALIDATION', 'Select at least one package to install.')
    }
    if (requests.length > 20) {
      throw new AppError('VALIDATION', 'Select no more than 20 packages at a time.')
    }
    for (const request of requests) {
      if (typeof request.packageId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(request.packageId)) {
        throw new AppError('VALIDATION', 'One of the requested packages is not valid.')
      }
      if (request.version !== undefined && typeof request.version !== 'string') {
        throw new AppError('VALIDATION', 'A requested version is not valid.')
      }
    }

    const installed = this.db.listInstallations()
    let diskFreeBytes: number | null = null
    try {
      const free = await this.ps.runJson<string | number>(
        powershellScripts.diskFree,
        { path: this.getToolsDir() },
        15000
      )
      const parsed = typeof free === 'number' ? free : Number(String(free).trim())
      diskFreeBytes = Number.isFinite(parsed) ? parsed : null
    } catch (error) {
      this.logger.warn('Could not determine free disk space', { error: String(error) })
    }
    const wingetAvailable = Boolean(await this.env.getWingetVersion())
    const packages = new Map(this.registry.listPackages().map((pkg) => [pkg.id, pkg]))

    const plan = buildInstallationPlan({
      requests,
      packages,
      installed,
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
      diskFreeBytes,
      wingetAvailable
    })

    for (const issue of this.registry.getIssues()) {
      plan.warnings.push(`Registry issue in ${issue.file}: ${issue.message}`)
    }
    this.logger.info('Installation plan created', {
      planId: plan.id,
      steps: plan.steps.length,
      errors: plan.errors.length
    })
    return plan
  }
}
