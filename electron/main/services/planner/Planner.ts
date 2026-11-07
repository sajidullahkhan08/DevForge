import { randomBytes } from 'node:crypto'
import type { InstallRequest, InstalledSummary, InstallationPlan, PlanStep } from '@shared/types'
import type { PackageDefinition, RegistryVersion } from '@shared/registry'
import {
  compareVersions,
  isSameVersion,
  satisfiesMinimum,
  sortVersionsDescending
} from '@shared/version'

export interface PlannerOptions {
  requests: InstallRequest[]
  packages: Map<string, PackageDefinition>
  installed: InstalledSummary[]
  arch: 'x64' | 'arm64'
  diskFreeBytes: number | null
  wingetAvailable?: boolean
  now?: () => Date
}

interface Candidate {
  packageId: string
  requestedVersion: string | null
  isDependency: boolean
  dependencyKind: 'required' | 'optional' | null
  requiresVersion: string | undefined
  reason: string | null
}

function getDefaultVersion(pkg: PackageDefinition): RegistryVersion | null {
  if (pkg.versions.length === 0) return null
  return pkg.versions.find((version) => version.isDefault) ?? pkg.versions[0]
}

function pickVersion(pkg: PackageDefinition, requested: string | null, minimum?: string): RegistryVersion | null {
  if (pkg.versions.length === 0) return null
  if (requested) {
    const exact = pkg.versions.find((version) => version.version === requested)
    if (exact) return exact
    return null
  }
  if (minimum) {
    const satisfying = pkg.versions
      .filter((version) => compareVersions(version.version, minimum) >= 0)
      .sort((a, b) => compareVersions(b.version, a.version))
    if (satisfying.length > 0) return satisfying[0]
    return null
  }
  return getDefaultVersion(pkg)
}

function activeInstalledFor(packageId: string, installed: InstalledSummary[]): InstalledSummary | null {
  const records = installed.filter((record) => record.packageId === packageId && record.status === 'installed')
  if (records.length === 0) return null
  const active = records.find((record) => record.isActive)
  if (active) return active
  return [...records].sort((a, b) => compareVersions(b.version, a.version))[0]
}

/**
 * Resolves required dependencies, verifies architecture and version
 * constraints, and returns a topologically ordered installation plan. The
 * function is pure so the resolution logic can be exercised by unit tests.
 */
export function buildInstallationPlan(options: PlannerOptions): InstallationPlan {
  const packages = options.packages
  const errors: string[] = []
  const warnings: string[] = []
  const candidates = new Map<string, Candidate>()
  const visitState = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []

  const explicitRequests = new Map<string, string | null>()
  for (const request of options.requests) {
    if (explicitRequests.has(request.packageId)) {
      errors.push(`${request.packageId} was requested more than once.`)
      continue
    }
    explicitRequests.set(request.packageId, request.version ?? null)
  }

  const addCandidate = (candidate: Candidate): void => {
    const existing = candidates.get(candidate.packageId)
    if (!existing) {
      candidates.set(candidate.packageId, candidate)
      return
    }
    if (candidate.isDependency && !existing.isDependency) return
    if (!candidate.isDependency && existing.isDependency) {
      candidates.set(candidate.packageId, candidate)
      return
    }
    if (candidate.dependencyKind === 'required') {
      existing.dependencyKind = 'required'
      if (candidate.requiresVersion && !existing.requiresVersion) {
        existing.requiresVersion = candidate.requiresVersion
      }
    }
    if (candidate.reason && !existing.reason) existing.reason = candidate.reason
  }

  const resolve = (packageId: string, candidate: Candidate): void => {
    const state = visitState.get(packageId)
    if (state === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(packageId)), packageId].join(' → ')
      errors.push(`Circular dependency detected: ${cycle}`)
      return
    }
    if (state === 'visited') {
      addCandidate(candidate)
      return
    }

    const pkg = packages.get(packageId)
    if (!pkg) {
      errors.push(`Package "${packageId}" is not in the DevForge registry.`)
      return
    }

    visitState.set(packageId, 'visiting')
    stack.push(packageId)
    addCandidate(candidate)

    for (const dependency of pkg.dependencies) {
      if (!packages.has(dependency.packageId)) {
        errors.push(`${pkg.name} depends on "${dependency.packageId}", which is not in the registry.`)
        continue
      }
      const installedRecord = activeInstalledFor(dependency.packageId, options.installed)
      const alreadySatisfied =
        dependency.kind === 'required' &&
        installedRecord !== null &&
        satisfiesMinimum(installedRecord.detectedVersion ?? installedRecord.version, dependency.minVersion)

      if (dependency.kind === 'optional' && !installedRecord) {
        warnings.push(
          `${pkg.name} works best with ${dependency.packageId}${
            dependency.reason ? ` (${dependency.reason})` : ''
          }, which is not installed. It is optional and was not added automatically.`
        )
        continue
      }
      if (alreadySatisfied) {
        addCandidate({
          packageId: dependency.packageId,
          requestedVersion: null,
          isDependency: true,
          dependencyKind: 'required',
          requiresVersion: dependency.minVersion,
          reason: dependency.reason ?? `Required by ${pkg.name}`
        })
        continue
      }

      resolve(dependency.packageId, {
        packageId: dependency.packageId,
        requestedVersion: null,
        isDependency: true,
        dependencyKind: dependency.kind,
        requiresVersion: dependency.minVersion,
        reason: dependency.reason ?? `Required by ${pkg.name}`
      })
    }

    stack.pop()
    visitState.set(packageId, 'visited')
  }

  for (const [packageId, version] of explicitRequests) {
    const pkg = packages.get(packageId)
    if (!pkg) {
      errors.push(`Package "${packageId}" is not in the DevForge registry.`)
      continue
    }
    if (version) {
      const exists = pkg.versions.some((candidate) => candidate.version === version)
      if (!exists) {
        errors.push(`${pkg.name} does not offer version ${version} in this registry.`)
        continue
      }
    }
    resolve(packageId, {
      packageId,
      requestedVersion: version,
      isDependency: false,
      dependencyKind: null,
      requiresVersion: undefined,
      reason: null
    })
  }

  const ordered = topologicalOrder(candidates, packages, errors)
  const steps: PlanStep[] = []
  let requiresAdmin = false
  let requiresRestart = false
  let totalEstimatedSizeBytes = 0

  for (const [index, candidate] of ordered.entries()) {
    const pkg = packages.get(candidate.packageId)
    if (!pkg) continue
    const stepWarnings: string[] = []
    const installedRecord = activeInstalledFor(pkg.id, options.installed)
    const isExplicit = !candidate.isDependency

    if (pkg.installationMethod === 'project-recipe') {
      steps.push({
        order: index + 1,
        packageId: pkg.id,
        name: pkg.name,
        version: null,
        action: 'project-recipe',
        method: pkg.installationMethod,
        isDependency: candidate.isDependency,
        dependencyKind: candidate.dependencyKind,
        reason: pkg.projectRecipe?.summary ?? 'Project-level setup recipe',
        requiresAdmin: false,
        requiresRestart: false,
        estimatedSizeBytes: null,
        environmentChanges: [],
        verificationChecks: [],
        warnings: pkg.projectRecipe?.notes ?? [],
        alreadyInstalledVersion: null
      })
      continue
    }

    if (!pkg.supportedArchitectures.includes(options.arch)) {
      steps.push({
        order: index + 1,
        packageId: pkg.id,
        name: pkg.name,
        version: candidate.requestedVersion,
        action: 'unsupported',
        method: pkg.installationMethod,
        isDependency: candidate.isDependency,
        dependencyKind: candidate.dependencyKind,
        reason: candidate.reason,
        requiresAdmin: pkg.requiresAdmin,
        requiresRestart: pkg.requiresRestart,
        estimatedSizeBytes: null,
        environmentChanges: [],
        verificationChecks: [],
        warnings: [`This package does not support the ${options.arch} architecture.`],
        alreadyInstalledVersion: installedRecord?.version ?? null
      })
      errors.push(`${pkg.name} does not support the ${options.arch} architecture on this machine.`)
      continue
    }

    const target = pickVersion(pkg, candidate.requestedVersion, candidate.requiresVersion)
    if (!target) {
      const reason = candidate.requiresVersion
        ? `No ${pkg.name} version satisfies the minimum version ${candidate.requiresVersion}.`
        : `${pkg.name} has no installable versions in the registry.`
      errors.push(reason)
      continue
    }

    const installedVersion = installedRecord?.detectedVersion ?? installedRecord?.version ?? null
    const dependencySatisfied =
      candidate.isDependency && satisfiesMinimum(installedVersion, candidate.requiresVersion)
    const sameVersionInstalled = Boolean(installedRecord && isSameVersion(installedVersion, target.version))
    const explicitSatisfied = isExplicit && sameVersionInstalled
    const configure = Boolean(
      explicitSatisfied &&
        installedRecord &&
        pkg.environment.length > 0 &&
        installedRecord.envStatus !== 'configured'
    )
    const skip = Boolean(dependencySatisfied || (explicitSatisfied && !configure))

    let action: PlanStep['action'] = skip ? 'skip' : configure ? 'configure' : 'install'
    if (!skip && !configure && installedRecord) {
      action = compareVersions(target.version, installedVersion ?? '0') > 0 ? 'upgrade' : 'install'
      if (action === 'install' && installedVersion && compareVersions(target.version, installedVersion) < 0) {
        stepWarnings.push(
          `Version ${target.version} is older than the detected ${pkg.name} ${installedVersion}. Installing it may replace the newer version or add a second copy.`
        )
      }
    }

    const isInstall = action === 'install' || action === 'upgrade'
    const changesEnvironment = isInstall || action === 'configure'
    const stepRequiresAdmin =
      pkg.requiresAdmin || pkg.scope === 'system' || pkg.environment.some((spec) => spec.scope === 'system')
    if (changesEnvironment && stepRequiresAdmin) {
      requiresAdmin = true
    }
    if (isInstall && pkg.requiresRestart) requiresRestart = true

    const estimatedSize = target.estimatedSizeBytes ?? target.download?.sizeBytes ?? null
    if (isInstall && estimatedSize) totalEstimatedSizeBytes += estimatedSize

    if (action === 'configure') {
      stepWarnings.push(
        'The installation files are already present. This step only applies the missing environment configuration.'
      )
    }

    if (isInstall) {
      stepWarnings.push(...pkg.caveats)
      if (pkg.advanced) {
        stepWarnings.push(
          `${pkg.name} is an advanced integration. Review the requirements on its details page before installing.`
        )
      }
      if (stepRequiresAdmin) {
        stepWarnings.push('This step requires administrator permission. Windows will ask you to approve it.')
      }
      if (pkg.requiresRestart) {
        stepWarnings.push('A Windows restart may be required to finish this installation.')
      }
      if (
        installedRecord &&
        !pkg.supportsVersionSwitching &&
        installedVersion &&
        !isSameVersion(installedVersion, target.version)
      ) {
        stepWarnings.push(
          `${pkg.name} does not support side-by-side version switching. The existing ${installedVersion} installation may be replaced.`
        )
      }
      if (pkg.installationMethod === 'winget' && options.wingetAvailable === false) {
        stepWarnings.push('WinGet was not detected on this system, so this installation cannot start yet.')
        errors.push('WinGet is required for one or more selected packages but was not found.')
      }
    }

    const environmentChanges = pkg.environment.map((spec) =>
      spec.kind === 'path'
        ? `Add "${spec.valueTemplate}" to the ${spec.scope} PATH`
        : `Set ${spec.name} to "${spec.valueTemplate}" (${spec.scope})`
    )
    const verificationChecks = pkg.verification.map((spec) => spec.label)

    if (skip) {
      stepWarnings.length = 0
    }

    steps.push({
      order: index + 1,
      packageId: pkg.id,
      name: pkg.name,
      version: target.version,
      action,
      method: pkg.installationMethod,
      isDependency: candidate.isDependency,
      dependencyKind: candidate.dependencyKind,
      reason: candidate.reason,
      requiresAdmin: changesEnvironment ? stepRequiresAdmin : false,
      requiresRestart: isInstall ? pkg.requiresRestart : false,
      estimatedSizeBytes: estimatedSize,
      environmentChanges,
      verificationChecks,
      warnings: stepWarnings,
      alreadyInstalledVersion: installedVersion
    })
  }

  if (options.diskFreeBytes !== null && totalEstimatedSizeBytes > 0) {
    const reserve = 512 * 1024 * 1024
    if (totalEstimatedSizeBytes > options.diskFreeBytes) {
      errors.push(
        'The selected packages need more disk space than is currently available on the installation drive.'
      )
    } else if (totalEstimatedSizeBytes + reserve > options.diskFreeBytes) {
      warnings.push(
        'Free disk space is low after these installs. Windows may need additional space for temporary files.'
      )
    }
  }

  if (options.requests.length > 1) {
    warnings.push(
      'Installations run one at a time because they share environment variables and the tools directory. Downloads and installers are never run in parallel.'
    )
  }

  const plan: InstallationPlan = {
    id: `plan-${(options.now ?? (() => new Date()))().getTime().toString(36)}-${randomBytes(3).toString('hex')}`,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    requests: options.requests,
    steps,
    warnings,
    errors,
    diskFreeBytes: options.diskFreeBytes,
    totalEstimatedSizeBytes,
    requiresAdmin: steps.some((step) => step.action !== 'skip' && step.requiresAdmin) || requiresAdmin,
    requiresRestart: steps.some((step) => step.action !== 'skip' && step.requiresRestart) || requiresRestart,
    serializedReason:
      'DevForge installs packages sequentially so environment variables, PATH entries and shared tool directories are never modified concurrently.'
  }
  return plan
}

function topologicalOrder(
  candidates: Map<string, Candidate>,
  packages: Map<string, PackageDefinition>,
  errors: string[]
): Candidate[] {
  const result: Candidate[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = (packageId: string): void => {
    if (visited.has(packageId)) return
    if (visiting.has(packageId)) return
    const pkg = packages.get(packageId)
    if (!pkg) return
    visiting.add(packageId)
    for (const dependency of pkg.dependencies) {
      if (dependency.kind === 'required' && candidates.has(dependency.packageId)) {
        visit(dependency.packageId)
      }
    }
    visiting.delete(packageId)
    visited.add(packageId)
    const candidate = candidates.get(packageId)
    if (candidate) result.push(candidate)
  }

  for (const packageId of candidates.keys()) visit(packageId)

  if (result.length !== candidates.size) {
    errors.push('The dependency graph could not be ordered because it contains a cycle.')
  }
  return result
}

export function describePlan(plan: InstallationPlan): string {
  return plan.steps
    .map((step) => `${step.order}. ${step.action.toUpperCase()} ${step.name}${step.version ? ` ${step.version}` : ''}`)
    .join('\n')
}

export function findInstalledVersion(
  installed: InstalledSummary[],
  packageId: string
): InstalledSummary | null {
  return activeInstalledFor(packageId, installed)
}

export function latestVersionOf(pkg: PackageDefinition): string | null {
  if (pkg.versions.length === 0) return null
  return sortVersionsDescending(pkg.versions.map((version) => version.version))[0] ?? null
}
