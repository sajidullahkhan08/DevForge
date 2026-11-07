import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiscoverySearchResponse } from '@shared/discovery'
import type { CanonicalIdentity } from '@shared/identity'
import { buildOfficialArchivePackage } from '@shared/official'
import type { PackageDefinition, RegistryVersion } from '@shared/registry'
import type { ReleaseRecord, VersionResolution } from '@shared/releases'
import { buildWinGetPackage } from '@shared/winget'
import type { AppDatabase } from '../electron/main/services/database/Database'
import { DiscoveryService } from '../electron/main/services/discovery/DiscoveryService'
import { DiscoveryStore } from '../electron/main/services/discovery/DiscoveryStore'
import type {
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryProviderOutcome,
  ProviderDiscoveryResult
} from '../electron/main/services/discovery/types'
import type { IdentityRegistry } from '../electron/main/services/identities/IdentityRegistry'
import { Logger } from '../electron/main/services/logging/Logger'
import type { ProcessExecutor } from '../electron/main/services/process/ProcessExecutor'
import type { RegistryService } from '../electron/main/services/registry/RegistryService'
import type { ReleaseResolver } from '../electron/main/services/releases/ReleaseResolver'

function identity(overrides: Partial<CanonicalIdentity> & { id: string }): CanonicalIdentity {
  const { id, ...rest } = overrides
  return {
    schemaVersion: 1,
    id,
    name: id,
    officialName: id,
    publisher: 'Test Publisher',
    homepage: 'https://example.com/',
    category: 'language',
    description: 'Test software identity',
    icon: 'terminal',
    aliases: [],
    executables: [],
    packageIds: [],
    wingetIds: [],
    githubRepo: null,
    versionSource: 'none',
    installationAdapters: ['winget'],
    officialArchive: null,
    relatedTools: [],
    tags: [],
    platforms: ['windows'],
    architectures: ['x64'],
    ...rest
  }
}

function registryVersion(value: string, options: Partial<RegistryVersion> = {}): RegistryVersion {
  return {
    version: value,
    channel: 'stable',
    isDefault: options.isDefault ?? true,
    installArgs: [],
    ...options
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
    publisher: 'Test Publisher',
    homepage: 'https://example.com/',
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
    versions: [registryVersion('1.0.0')],
    dependencies: [],
    environment: [],
    verification: [],
    detection: { args: [], knownPaths: [] },
    ...rest
  }
}

function providerResult(
  overrides: Partial<ProviderDiscoveryResult> & { id: string }
): ProviderDiscoveryResult {
  const { id, ...rest } = overrides
  return {
    id,
    source: 'winget',
    sourceLabel: 'WinGet',
    managerId: id.replace(/^winget:/, ''),
    name: id,
    publisher: 'Test Publisher',
    description: 'Test package',
    version: '1.0.0',
    category: 'language',
    homepage: 'https://example.com/',
    license: 'MIT',
    tags: [],
    icon: 'terminal',
    compatibility: 'installable',
    compatibilityNote: null,
    packageId: null,
    installedVersion: null,
    updateAvailable: false,
    verified: true,
    metadataUrl: 'https://example.com/',
    ...rest
  }
}

function fakeProvider(
  id: string,
  outcome: DiscoveryProviderOutcome | (() => Promise<DiscoveryProviderOutcome>)
): DiscoveryProvider & { calls: number } {
  const provider = {
    id,
    label: id,
    calls: 0,
    async search(_query: string, _context: DiscoveryProviderContext): Promise<DiscoveryProviderOutcome> {
      provider.calls += 1
      return typeof outcome === 'function' ? outcome() : outcome
    }
  }
  return provider
}

function emptyOutcome(id = 'empty'): DiscoveryProviderOutcome {
  return {
    results: [],
    candidates: new Map(),
    report: { id, label: id, status: 'ok', message: null, count: 0 }
  }
}

function resolution(overrides: Partial<VersionResolution> = {}): VersionResolution {
  return {
    latestStable: null,
    latestLts: null,
    latestPreview: null,
    others: [],
    source: {
      id: 'official-feed',
      label: 'Official release feed',
      url: 'https://example.com/releases',
      kind: 'official'
    },
    retrievedAt: new Date().toISOString(),
    stale: false,
    error: null,
    ...overrides
  }
}

function releaseRecord(value: string, options: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    version: value,
    channel: 'stable',
    publishedAt: null,
    archive: {
      url: `https://example.com/releases/${value}.zip`,
      checksum: 'a'.repeat(64),
      checksumAlgorithm: 'sha256',
      archiveType: 'zip',
      sizeBytes: null
    },
    ...options
  }
}

function fallbackResolution(): VersionResolution {
  return {
    latestStable: null,
    latestLts: null,
    latestPreview: null,
    others: [],
    source: { id: 'devforge-manifest', label: 'DevForge package manifest', url: null, kind: 'catalogue' },
    retrievedAt: new Date().toISOString(),
    stale: false,
    error: null
  }
}

const kotlinIdentity = identity({
  id: 'kotlin',
  name: 'Kotlin',
  officialName: 'Kotlin Programming Language',
  publisher: 'JetBrains',
  homepage: 'https://kotlinlang.org/',
  aliases: ['Kotlin', 'kotlinc'],
  executables: ['kotlinc'],
  githubRepo: 'JetBrains/kotlin',
  versionSource: 'github',
  installationAdapters: ['winget'],
  tags: ['kotlin']
})

const flutterIdentity = identity({
  id: 'flutter',
  name: 'Flutter',
  officialName: 'Flutter SDK',
  publisher: 'Google',
  homepage: 'https://flutter.dev/',
  category: 'framework',
  aliases: ['Flutter', 'Flutter SDK'],
  executables: ['flutter'],
  versionSource: 'flutter',
  officialArchive: 'flutter',
  installationAdapters: ['official-archive', 'winget'],
  tags: ['flutter']
})

const testPackage = buildWinGetPackage({
  wingetId: 'JetBrains.Kotlin',
  name: 'Kotlin',
  version: '2.1.0',
  publisher: 'JetBrains',
  description: 'Kotlin is a modern programming language.',
  homepage: 'https://kotlinlang.org/',
  license: 'Apache-2.0',
  tags: ['kotlin', 'language']
})

let directory: string
let store: DiscoveryStore
let logger: Logger
let dynamicPackages: PackageDefinition[]
let curatedPackages: PackageDefinition[]
let registered: PackageDefinition[]
let synced: number
let registry: RegistryService
let db: AppDatabase
let identities: CanonicalIdentity[]
let releases: ReleaseResolver & { resolveCalls: number }

function fakeReleases(handler: () => VersionResolution): ReleaseResolver & { resolveCalls: number } {
  const fake = {
    resolveCalls: 0,
    async resolve() {
      fake.resolveCalls += 1
      return handler()
    },
    setOnChange() {
      // no-op for tests
    },
    snapshot: () => ({})
  }
  return fake as unknown as ReleaseResolver & { resolveCalls: number }
}

function fakeIdentityRegistry(): IdentityRegistry {
  return {
    list: () => identities,
    forPackage: (pkg: PackageDefinition) => {
      const direct = identities.find(
        (entry) =>
          entry.id === pkg.id ||
          entry.packageIds.includes(pkg.id) ||
          (pkg.packageManagerId ? entry.wingetIds.includes(pkg.packageManagerId) : false)
      )
      if (direct) return direct
      return identities.find(
        (entry) => entry.name === pkg.name && entry.publisher === pkg.publisher
      ) ?? null
    }
  } as unknown as IdentityRegistry
}

function service(providers: DiscoveryProvider[], refreshedAt: Record<string, string> = {}): DiscoveryService {
  const executor = {
    run: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    isCancellation: () => false
  } as unknown as ProcessExecutor
  return new DiscoveryService(
    registry,
    db,
    logger,
    store,
    fakeIdentityRegistry(),
    releases,
    executor,
    refreshedAt,
    providers
  )
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'devforge-discovery-'))
  store = new DiscoveryStore(join(directory, 'discovered-packages.json'), new Logger(join(directory, 'logs')))
  logger = new Logger(join(directory, 'logs'))
  dynamicPackages = []
  curatedPackages = []
  registered = []
  synced = 0
  identities = [kotlinIdentity, flutterIdentity]
  registry = {
    listPackages: () => [...curatedPackages, ...dynamicPackages],
    listDynamicPackages: () => [...dynamicPackages],
    getPackage: (id: string) =>
      [...curatedPackages, ...dynamicPackages].find((entry) => entry.id === id) ?? null,
    registerDynamicPackage: (next: PackageDefinition) => {
      registered.push(next)
      dynamicPackages = [...dynamicPackages.filter((entry) => entry.id !== next.id), next]
    },
    syncDatabase: () => {
      synced += 1
    }
  } as unknown as RegistryService
  db = { listInstallations: () => [] } as unknown as AppDatabase
  releases = fakeReleases(fallbackResolution)
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('DiscoveryService unified search', () => {
  it('validates the query and caches results by lowercase query', async () => {
    const provider = fakeProvider('test', emptyOutcome())
    const discovery = service([provider])

    await expect(discovery.search(' x ')).rejects.toMatchObject({ code: 'VALIDATION' })

    const first = await discovery.search('Kotlin')
    const second = await discovery.search('  kotlin ')
    expect(first.cached).toBe(false)
    expect(first.results).toHaveLength(1)
    expect(first.results[0].id).toBe('identity:kotlin')
    expect(second.cached).toBe(true)
    expect(provider.calls).toBe(1)
  })

  it('returns one canonical result instead of catalog, WinGet and GitHub duplicates', async () => {
    const provider = fakeProvider('winget', {
      results: [
        providerResult({
          id: 'winget:JetBrains.Kotlin',
          name: 'Kotlin',
          publisher: 'JetBrains',
          managerId: 'JetBrains.Kotlin'
        })
      ],
      candidates: new Map([['winget:JetBrains.Kotlin', testPackage]]),
      report: { id: 'winget', label: 'WinGet', status: 'ok', message: '1 validated', count: 1 }
    })
    const discovery = service([provider])

    const response = await discovery.search('kotlin')
    expect(response.results).toHaveLength(1)
    expect(response.related).toHaveLength(0)
    const match = response.results[0]
    expect(match.id).toBe('identity:kotlin')
    expect(match.identityId).toBe('kotlin')
    expect(match.match.tier).toBe('exact')
    expect(match.sources.map((source) => source.id)).toContain('winget')
    expect(match.compatibility).toBe('installable')
    expect(match.installationAdapter).toBe('winget')
    expect(match.candidateId).toBe('identity:kotlin')

    const prepared = await discovery.prepare('identity:kotlin')
    expect(prepared).toEqual({ packageId: testPackage.id, created: true })
    expect(registered).toHaveLength(1)
    expect(registered[0].origin).toBe('winget')
    expect(synced).toBe(1)
  })

  it('shows authoritative version channels and installs verified official archives', async () => {
    releases = fakeReleases(() =>
      resolution({
        latestStable: releaseRecord('3.35.0'),
        latestLts: releaseRecord('3.32.8', { channel: 'lts' })
      })
    )

    const discovery = service([fakeProvider('winget', emptyOutcome())])
    const response = await discovery.search('flutter')
    expect(response.results).toHaveLength(1)
    const match = response.results[0]
    expect(match.identityId).toBe('flutter')
    expect(match.versions.stable).toBe('3.35.0')
    expect(match.versions.lts).toBe('3.32.8')
    expect(match.versions.source.kind).toBe('official')
    expect(match.compatibility).toBe('installable')
    expect(match.installationAdapter).toBe('official-archive')
    expect(match.candidateId).toBe('identity:flutter')

    const prepared = await discovery.prepare('identity:flutter')
    expect(prepared.created).toBe(true)
    expect(registered[0].origin).toBe('official')
    expect(registered[0].versions.some((version) => version.version === '3.35.0')).toBe(true)
  })

  it('never exposes an install action for an unverified product', async () => {
    const phpIdentity = identity({
      id: 'php',
      name: 'PHP',
      publisher: 'The PHP Group',
      homepage: 'https://www.php.net/',
      versionSource: 'php',
      installationAdapters: ['winget'],
      aliases: ['PHP']
    })
    identities = [phpIdentity]
    const discovery = service([fakeProvider('winget', emptyOutcome())])

    const response = await discovery.search('php')
    expect(response.results[0].compatibility).toBe('metadata-only')
    expect(response.results[0].candidateId).toBeNull()
    await expect(discovery.prepare('identity:php')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(registered).toHaveLength(0)
  })

  it('keeps canonical results when an external provider fails', async () => {
    const broken = fakeProvider('winget', async () => {
      throw new Error('rate limited')
    })
    const discovery = service([broken])

    const response: DiscoverySearchResponse = await discovery.search('kotlin')
    expect(response.results.map((entry) => entry.id)).toEqual(['identity:kotlin'])
    expect(response.providers).toHaveLength(1)
    expect(response.providers[0].status).toBe('error')
    expect(response.providers[0].message).toContain('rate limited')
  })

  it('returns a standalone validated WinGet result when no identity matches', async () => {
    const unknownPackage = buildWinGetPackage({
      wingetId: 'Vendor.Widget',
      name: 'Vendor Widget',
      version: '4.2.0',
      publisher: 'Vendor',
      description: 'A developer widget.',
      homepage: 'https://vendor.example/',
      license: 'MIT',
      tags: ['widget']
    })
    const provider = fakeProvider('winget', {
      results: [
        providerResult({
          id: 'winget:Vendor.Widget',
          name: 'Vendor Widget',
          managerId: 'Vendor.Widget'
        })
      ],
      candidates: new Map([['winget:Vendor.Widget', unknownPackage]]),
      report: { id: 'winget', label: 'WinGet', status: 'ok', message: '1 validated', count: 1 }
    })
    const discovery = service([provider])

    const response = await discovery.search('vendor widget')
    expect(response.results).toHaveLength(1)
    expect(response.results[0].id).toBe('winget:Vendor.Widget')
    expect(response.results[0].match.tier).toBe('exact')
    const prepared = await discovery.prepare('winget:Vendor.Widget')
    expect(prepared).toEqual({ packageId: unknownPackage.id, created: true })
  })
})

describe('DiscoveryService custom package import', () => {
  it('validates, registers and persists an imported package', () => {
    const discovery = service([])
    const imported = pkg({ id: 'custom-tool', name: 'Custom Tool', packageManagerId: 'Example.CustomTool' })

    const result = discovery.importCustomPackage(imported)
    expect(result.package.id).toBe('custom-tool')
    expect(result.warnings.join(' ')).toContain('review the installation plan')
    expect(registered.map((entry) => entry.id)).toContain('custom-tool')
    expect(synced).toBe(1)
    expect(store.load().packages).toHaveLength(1)
  })

  it('refuses to replace an existing package id', () => {
    curatedPackages.push(pkg({ id: 'existing-tool' }))
    const discovery = service([])

    expect(() => discovery.importCustomPackage(pkg({ id: 'existing-tool' }))).toThrow(
      /already exists/
    )
    expect(registered).toEqual([])
    expect(synced).toBe(0)
  })

  it('rejects invalid schemas and semantically invalid packages', () => {
    const discovery = service([])

    expect(() =>
      discovery.importCustomPackage({ ...pkg({ id: 'broken' }), name: '' })
    ).toThrow(/Too small/i)

    expect(() =>
      discovery.importCustomPackage(
        pkg({ id: 'missing-download', installationMethod: 'archive', packageManagerId: undefined })
      )
    ).toThrow(/download metadata/i)

    expect(registered).toEqual([])
  })

  it('rejects unknown installation methods', () => {
    const discovery = service([])
    expect(() =>
      discovery.importCustomPackage({
        ...pkg({ id: 'unsafe' }),
        installationMethod: 'shell-script'
      })
    ).toThrow(/invalid option|installationMethod/i)
  })
})

describe('DiscoveryService prepare', () => {
  it('returns the existing curated package id without registering anything', async () => {
    curatedPackages = [
      pkg({
        id: 'kotlin',
        name: 'Kotlin',
        publisher: 'JetBrains',
        versions: [registryVersion('2.0.0')]
      })
    ]
    const discovery = service([fakeProvider('winget', emptyOutcome())])
    await discovery.search('kotlin')
    const prepared = await discovery.prepare('identity:kotlin')
    expect(prepared).toEqual({ packageId: 'kotlin', created: false })
    expect(registered).toHaveLength(0)
  })

  it('rejects ids that were never returned by a search or have expired', async () => {
    const discovery = service([fakeProvider('test', emptyOutcome())])
    await expect(discovery.prepare('identity:unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('DiscoveryService metadata refresh', () => {
  it('does nothing when no discovered packages exist', async () => {
    const discovery = service([fakeProvider('test', emptyOutcome())])
    expect(await discovery.refreshManagedPackages(true)).toEqual({
      checked: 0,
      updated: [],
      failed: 0,
      skipped: false
    })
  })

  it('skips gracefully when WinGet is unavailable', async () => {
    dynamicPackages = [testPackage]
    const discovery = service([fakeProvider('test', emptyOutcome())])
    const refresh = await discovery.refreshManagedPackages(true)
    expect(refresh).toMatchObject({ checked: 0, skipped: true })
  })

  it('updates discovered packages from the current WinGet manifest', async () => {
    dynamicPackages = [testPackage]
    const show = `Found Kotlin [JetBrains.Kotlin]
Version: 2.2.0
Publisher: JetBrains
Homepage: https://kotlinlang.org/
License: Apache-2.0
Description: Kotlin is a modern programming language.
Tags:
  kotlin
  language
Installer:
  Installer Type: zip
`
    const executing = {
      run: async (_command: string, args: string[]) => {
        if (args[0] === '--version') return { stdout: 'v1.29.380', stderr: '', exitCode: 0 }
        if (args[0] === 'show') return { stdout: show, stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 1 }
      },
      isCancellation: () => false
    } as unknown as ProcessExecutor
    const discovery = new DiscoveryService(
      registry,
      db,
      logger,
      store,
      fakeIdentityRegistry(),
      releases,
      executing,
      {},
      [fakeProvider('test', emptyOutcome())]
    )

    const refresh = await discovery.refreshManagedPackages(true)
    expect(refresh.checked).toBe(1)
    expect(refresh.updated).toEqual([testPackage.id])
    expect(refresh.failed).toBe(0)
    expect(dynamicPackages[0].versions[0].version).toBe('2.2.0')
    expect(store.load().refreshedAt['jetbrains.kotlin']).toBeTruthy()
  })

  it('refreshes official archive packages from their release feed', async () => {
    const oldResolution = resolution({ latestStable: releaseRecord('3.30.0') })
    const current = buildOfficialArchivePackage(flutterIdentity, oldResolution)
    expect(current).not.toBeNull()
    dynamicPackages = [current as PackageDefinition]

    releases = fakeReleases(() =>
      resolution({
        latestStable: releaseRecord('3.35.0'),
        latestLts: releaseRecord('3.32.8', { channel: 'lts' })
      })
    )

    const discovery = service([fakeProvider('test', emptyOutcome())])
    const refresh = await discovery.refreshManagedPackages(true)
    expect(refresh.checked).toBe(1)
    expect(refresh.updated).toEqual(['flutter'])
    expect(refresh.failed).toBe(0)
    expect(
      (dynamicPackages[0] as PackageDefinition).versions.map((version) => version.version)
    ).toContain('3.35.0')
    expect(store.load().refreshedAt['official:flutter']).toBeTruthy()
  })

  it('skips packages that were refreshed within the last 12 hours', async () => {
    dynamicPackages = [testPackage]
    const discovery = service(
      [fakeProvider('test', emptyOutcome())],
      { 'jetbrains.kotlin': new Date().toISOString() }
    )
    expect(await discovery.refreshManagedPackages(false)).toEqual({
      checked: 0,
      updated: [],
      failed: 0,
      skipped: false
    })
  })
})
