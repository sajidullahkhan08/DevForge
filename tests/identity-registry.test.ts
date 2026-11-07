import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanonicalIdentity } from '@shared/identity'
import type { PackageDefinition } from '@shared/registry'
import { IdentityRegistry } from '../electron/main/services/identities/IdentityRegistry'
import type { Logger } from '../electron/main/services/logging/Logger'
import type { RegistryService } from '../electron/main/services/registry/RegistryService'

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger

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
    versions: [
      {
        version: '1.0.0',
        channel: 'stable',
        isDefault: true,
        packageManagerId: 'Test.Package',
        installArgs: []
      }
    ],
    dependencies: [],
    environment: [],
    verification: [],
    detection: { args: [], knownPaths: [] },
    ...rest
  }
}

const kotlin = identity({
  id: 'kotlin',
  name: 'Kotlin',
  officialName: 'Kotlin Programming Language',
  publisher: 'JetBrains',
  aliases: ['Kotlin', 'kotlinc'],
  executables: ['kotlinc'],
  packageIds: ['kotlin-cli']
})

const flutter = identity({
  id: 'flutter',
  name: 'Flutter',
  officialName: 'Flutter SDK',
  publisher: 'Google',
  category: 'framework',
  wingetIds: ['Google.Flutter'],
  officialArchive: 'flutter',
  installationAdapters: ['official-archive', 'winget'],
  versionSource: 'flutter'
})

const nodejs = identity({
  id: 'nodejs',
  name: 'Node.js',
  officialName: 'Node.js JavaScript Runtime',
  publisher: 'OpenJS Foundation',
  versionSource: 'nodejs'
})

let directory: string
let registry: IdentityRegistry

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'devforge-identities-'))
  writeFileSync(
    join(directory, 'identities.json'),
    JSON.stringify({ schemaVersion: 1, identities: [kotlin, flutter, nodejs] }),
    'utf8'
  )
  const service = {
    hasPackage: () => true,
    addIssues: () => {}
  } as unknown as RegistryService
  registry = new IdentityRegistry(directory, service, logger)
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('IdentityRegistry.forPackage', () => {
  it('matches the identity id, declared package ids and WinGet identifiers', () => {
    expect(registry.forPackage(pkg({ id: 'kotlin' }))?.id).toBe('kotlin')
    expect(
      registry.forPackage(pkg({ id: 'kotlin-cli', name: 'Kotlin command line tools' }))?.id
    ).toBe('kotlin')
    expect(
      registry.forPackage(
        pkg({
          id: 'winget-google-flutter',
          name: 'Google Flutter',
          publisher: 'Google',
          packageManagerId: 'Google.Flutter'
        })
      )?.id
    ).toBe('flutter')
  })

  it('maps a differently named package only when name and publisher agree', () => {
    expect(
      registry.forPackage(
        pkg({ id: 'nodejs-custom', name: 'Node.js', publisher: 'OpenJS Foundation' })
      )?.id
    ).toBe('nodejs')
    expect(
      registry.forPackage(pkg({ id: 'nodejs-custom', name: 'Node.js', publisher: 'Unknown Corp' }))
    ).toBeNull()
  })

  it('does not guess an identity for unrelated packages', () => {
    expect(registry.forPackage(pkg({ id: 'random-tool', name: 'Random Tool' }))).toBeNull()
  })

  it('reports invalid identity definitions as registry issues', () => {
    expect(registry.getIssues()).toEqual([])
    expect(registry.list().map((entry) => entry.id)).toEqual(['flutter', 'kotlin', 'nodejs'])
  })
})
