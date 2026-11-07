import { describe, expect, it } from 'vitest'
import type { InstalledSummary } from '@shared/types'
import type { PackageDefinition, RegistryVersion } from '@shared/registry'
import { buildInstallationPlan, describePlan, findInstalledVersion, latestVersionOf } from '../electron/main/services/planner/Planner'

function version(
  value: string,
  options: Partial<RegistryVersion> & { sizeBytes?: number } = {}
): RegistryVersion {
  return {
    version: value,
    channel: 'stable',
    isDefault: options.isDefault ?? false,
    installArgs: [],
    estimatedSizeBytes: options.sizeBytes,
    packageManagerId: options.packageManagerId
  }
}

function pkg(overrides: Partial<PackageDefinition> & { id: string }): PackageDefinition {
  const { id, ...rest } = overrides
  return {
    schemaVersion: 1,
    id,
    name: id,
    category: 'language',
    description: 'Test package',
    publisher: 'DevForge Tests',
    homepage: 'https://example.com',
    license: 'MIT',
    icon: 'terminal',
    installationMethod: 'winget',
    packageManagerId: 'Test.Package',
    scope: 'user',
    supportedArchitectures: ['x64'],
    supportedWindowsVersions: ['10', '11'],
    requiresAdmin: false,
    requiresRestart: false,
    advanced: false,
    caveats: [],
    tags: [],
    expectedExecutables: [],
    supportsVersionSwitching: false,
    versions: [version('1.0.0', { isDefault: true })],
    dependencies: [],
    environment: [],
    verification: [],
    detection: { args: [], knownPaths: [] },
    ...rest
  }
}

function installed(packageId: string, value: string, options: Partial<InstalledSummary> = {}): InstalledSummary {
  return {
    id: 1,
    packageId,
    version: value,
    method: 'winget',
    source: 'devforge',
    installDir: null,
    status: 'installed',
    verificationStatus: 'pending',
    detectedVersion: value,
    availableVersion: null,
    envStatus: 'unknown',
    isActive: true,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...options
  }
}

function planFor(packages: PackageDefinition[], requests: { packageId: string; version?: string }[], extra: {
  installed?: InstalledSummary[]
  arch?: 'x64' | 'arm64'
  diskFreeBytes?: number | null
  wingetAvailable?: boolean
} = {}) {
  return buildInstallationPlan({
    requests,
    packages: new Map(packages.map((entry) => [entry.id, entry])),
    installed: extra.installed ?? [],
    arch: extra.arch ?? 'x64',
    diskFreeBytes: extra.diskFreeBytes === undefined ? null : extra.diskFreeBytes,
    wingetAvailable: extra.wingetAvailable,
    now: () => new Date('2026-01-01T00:00:00.000Z')
  })
}

describe('buildInstallationPlan', () => {
  it('orders dependencies before dependents', () => {
    const runtime = pkg({ id: 'runtime' })
    const app = pkg({
      id: 'app',
      dependencies: [{ packageId: 'runtime', kind: 'required', reason: 'App needs the runtime' }]
    })
    const plan = planFor([app, runtime], [{ packageId: 'app' }])

    expect(plan.errors).toEqual([])
    expect(plan.steps.map((step) => step.packageId)).toEqual(['runtime', 'app'])
    const runtimeStep = plan.steps[0]
    expect(runtimeStep.isDependency).toBe(true)
    expect(runtimeStep.reason).toBe('App needs the runtime')
    expect(plan.steps[1].isDependency).toBe(false)
    expect(describePlan(plan)).toContain('1. INSTALL runtime')
  })

  it('reports packages missing from the registry', () => {
    const app = pkg({ id: 'app', dependencies: [{ packageId: 'ghost', kind: 'required' }] })
    const plan = planFor([app], [{ packageId: 'app' }])
    expect(plan.errors.join('\n')).toContain('ghost')
    expect(plan.errors.join('\n')).toContain('not in the registry')
  })

  it('reports unknown explicit packages', () => {
    const plan = planFor([], [{ packageId: 'missing' }])
    expect(plan.errors).toHaveLength(1)
    expect(plan.errors[0]).toContain('missing')
  })

  it('detects circular dependencies', () => {
    const a = pkg({ id: 'a', dependencies: [{ packageId: 'b', kind: 'required' }] })
    const b = pkg({ id: 'b', dependencies: [{ packageId: 'a', kind: 'required' }] })
    const plan = planFor([a, b], [{ packageId: 'a' }])
    expect(plan.errors.some((error) => error.includes('Circular dependency'))).toBe(true)
  })

  it('skips dependencies that are already satisfied', () => {
    const runtime = pkg({ id: 'runtime', versions: [version('2.0.0', { isDefault: true })] })
    const app = pkg({ id: 'app', dependencies: [{ packageId: 'runtime', kind: 'required', minVersion: '1.0.0' }] })
    const plan = planFor([app, runtime], [{ packageId: 'app' }], {
      installed: [installed('runtime', '2.0.0')]
    })
    expect(plan.errors).toEqual([])
    const runtimeStep = plan.steps.find((step) => step.packageId === 'runtime')
    expect(runtimeStep?.action).toBe('skip')
    expect(plan.steps.find((step) => step.packageId === 'app')?.action).toBe('install')
  })

  it('warns about missing optional dependencies without adding them', () => {
    const app = pkg({ id: 'app', dependencies: [{ packageId: 'extra', kind: 'optional', reason: 'nice to have' }] })
    const extra = pkg({ id: 'extra' })
    const plan = planFor([app, extra], [{ packageId: 'app' }])
    expect(plan.steps.map((step) => step.packageId)).toEqual(['app'])
    expect(plan.warnings.some((warning) => warning.includes('extra') && warning.includes('optional'))).toBe(true)
  })

  it('marks upgrades when a newer version is requested', () => {
    const app = pkg({
      id: 'app',
      versions: [version('1.0.0', { isDefault: true }), version('1.1.0')]
    })
    const plan = planFor([app], [{ packageId: 'app', version: '1.1.0' }], {
      installed: [installed('app', '1.0.0')]
    })
    expect(plan.errors).toEqual([])
    expect(plan.steps[0].action).toBe('upgrade')
    expect(plan.steps[0].version).toBe('1.1.0')
  })

  it('skips when the requested version is already installed', () => {
    const app = pkg({ id: 'app', versions: [version('1.0.0', { isDefault: true })] })
    const plan = planFor([app], [{ packageId: 'app' }], { installed: [installed('app', '1.0.0')] })
    expect(plan.steps[0].action).toBe('skip')
  })

  it('rejects versions that are not in the registry', () => {
    const app = pkg({ id: 'app' })
    const plan = planFor([app], [{ packageId: 'app', version: '9.9.9' }])
    expect(plan.errors.some((error) => error.includes('9.9.9'))).toBe(true)
  })

  it('picks the highest satisfying version for dependency minimums', () => {
    const runtime = pkg({
      id: 'runtime',
      versions: [
        version('1.0.0', { isDefault: true }),
        version('2.1.0'),
        version('3.0.0')
      ]
    })
    const app = pkg({
      id: 'app',
      dependencies: [{ packageId: 'runtime', kind: 'required', minVersion: '2.0.0' }]
    })
    const plan = planFor([app, runtime], [{ packageId: 'app' }], { installed: [] })
    expect(plan.steps.find((step) => step.packageId === 'runtime')?.version).toBe('3.0.0')
  })

  it('reports unsupported architectures', () => {
    const app = pkg({ id: 'app', supportedArchitectures: ['arm64'] })
    const plan = planFor([app], [{ packageId: 'app' }], { arch: 'x64' })
    expect(plan.steps[0].action).toBe('unsupported')
    expect(plan.errors.some((error) => error.includes('architecture'))).toBe(true)
  })

  it('warns when WinGet is unavailable for a WinGet package', () => {
    const app = pkg({ id: 'app' })
    const plan = planFor([app], [{ packageId: 'app' }], { wingetAvailable: false })
    expect(plan.errors.some((error) => error.includes('WinGet'))).toBe(true)
    expect(plan.steps[0].warnings.some((warning) => warning.includes('WinGet'))).toBe(true)
  })

  it('adds project recipes as non-installable steps', () => {
    const recipe = pkg({
      id: 'recipe',
      installationMethod: 'project-recipe',
      versions: [],
      projectRecipe: {
        summary: 'Create a new project',
        commands: [{ label: 'Scaffold', command: 'npm create vite@latest' }],
        notes: ['Run inside your project folder.']
      }
    })
    const plan = planFor([recipe], [{ packageId: 'recipe' }])
    expect(plan.errors).toEqual([])
    expect(plan.steps[0].action).toBe('project-recipe')
    expect(plan.steps[0].version).toBeNull()
  })

  it('fails when disk space is insufficient and warns when it is tight', () => {
    const large = pkg({
      id: 'large',
      versions: [version('1.0.0', { isDefault: true, sizeBytes: 600 * 1024 * 1024 })]
    })
    const insufficient = planFor([large], [{ packageId: 'large' }], { diskFreeBytes: 100 * 1024 * 1024 })
    expect(insufficient.errors.some((error) => error.includes('disk space'))).toBe(true)

    const tight = planFor([large], [{ packageId: 'large' }], { diskFreeBytes: 800 * 1024 * 1024 })
    expect(tight.errors).toEqual([])
    expect(tight.warnings.some((warning) => warning.includes('Free disk space'))).toBe(true)
  })

  it('aggregates admin, restart and size requirements', () => {
    const base = pkg({
      id: 'base',
      requiresRestart: true,
      versions: [version('1.0.0', { isDefault: true, sizeBytes: 1024 })]
    })
    const elevated = pkg({ id: 'elevated', scope: 'system' })
    const plan = planFor([base, elevated], [{ packageId: 'base' }, { packageId: 'elevated' }], {
      diskFreeBytes: 10 * 1024 * 1024 * 1024
    })
    expect(plan.requiresAdmin).toBe(true)
    expect(plan.requiresRestart).toBe(true)
    expect(plan.totalEstimatedSizeBytes).toBe(1024)
    expect(plan.warnings.some((warning) => warning.includes('one at a time'))).toBe(true)
  })

  it('rejects duplicate explicit requests', () => {
    const app = pkg({ id: 'app' })
    const plan = planFor([app], [{ packageId: 'app' }, { packageId: 'app' }])
    expect(plan.errors.some((error) => error.includes('more than once'))).toBe(true)
  })

  it('configures an installed package whose environment was never applied', () => {
    const python = pkg({
      id: 'python',
      environment: [
        { kind: 'path', name: 'Path', valueTemplate: '{toolsDir}\\python', scope: 'user' }
      ]
    })
    const plan = planFor([python], [{ packageId: 'python' }], {
      installed: [installed('python', '1.0.0', { envStatus: 'unknown' })]
    })

    expect(plan.errors).toEqual([])
    expect(plan.steps[0].action).toBe('configure')
    expect(plan.steps[0].version).toBe('1.0.0')
    expect(plan.steps[0].requiresAdmin).toBe(false)
    expect(plan.steps[0].environmentChanges).toHaveLength(1)
    expect(plan.steps[0].warnings.join(' ')).toContain('only applies the missing environment configuration')
    expect(plan.totalEstimatedSizeBytes).toBe(0)
  })

  it('skips an installed package whose environment is already configured', () => {
    const python = pkg({
      id: 'python',
      environment: [
        { kind: 'path', name: 'Path', valueTemplate: '{toolsDir}\\python', scope: 'user' }
      ]
    })
    const plan = planFor([python], [{ packageId: 'python' }], {
      installed: [installed('python', '1.0.0', { envStatus: 'configured' })]
    })
    expect(plan.steps[0].action).toBe('skip')
  })

  it('skips installed packages that have no environment requirements', () => {
    const app = pkg({ id: 'app' })
    const plan = planFor([app], [{ packageId: 'app' }], {
      installed: [installed('app', '1.0.0', { envStatus: 'unknown' })]
    })
    expect(plan.steps[0].action).toBe('skip')
  })

  it('upgrades rather than configures when a newer version is requested', () => {
    const python = pkg({
      id: 'python',
      environment: [
        { kind: 'path', name: 'Path', valueTemplate: '{toolsDir}\\python', scope: 'user' }
      ],
      versions: [version('1.0.0', { isDefault: true }), version('2.0.0')]
    })
    const plan = planFor([python], [{ packageId: 'python', version: '2.0.0' }], {
      installed: [installed('python', '1.0.0', { envStatus: 'unknown' })]
    })
    expect(plan.steps[0].action).toBe('upgrade')
  })
})

describe('planner helpers', () => {
  it('finds the active installation', () => {
    const records = [
      installed('app', '2.0.0', { id: 1, isActive: false }),
      installed('app', '1.5.0', { id: 2, isActive: true })
    ]
    expect(findInstalledVersion(records, 'app')?.version).toBe('1.5.0')
    expect(findInstalledVersion(records, 'other')).toBeNull()
  })

  it('falls back to the highest installed version when none is active', () => {
    const records = [
      installed('app', '1.0.0', { id: 1, isActive: false }),
      installed('app', '1.4.0', { id: 2, isActive: false })
    ]
    expect(findInstalledVersion(records, 'app')?.version).toBe('1.4.0')
  })

  it('ignores removed installations', () => {
    expect(
      findInstalledVersion([installed('app', '1.0.0', { status: 'removed' })], 'app')
    ).toBeNull()
  })

  it('returns the latest declared version', () => {
    const app = pkg({
      id: 'app',
      versions: [version('1.0.0', { isDefault: true }), version('1.12.0')]
    })
    expect(latestVersionOf(app)).toBe('1.12.0')
    expect(latestVersionOf(pkg({ id: 'empty', installationMethod: 'project-recipe', versions: [] }))).toBeNull()
  })
})
