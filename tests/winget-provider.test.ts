import { describe, expect, it } from 'vitest'
import type { PackageDefinition } from '@shared/registry'
import { buildWinGetPackage, wingetPackageId } from '@shared/winget'
import type { Logger } from '../electron/main/services/logging/Logger'
import type { ProcessExecutor } from '../electron/main/services/process/ProcessExecutor'
import type { DiscoveryProviderContext } from '../electron/main/services/discovery/types'
import { WinGetProvider } from '../electron/main/services/discovery/providers/WinGetProvider'

const pad = (value: string, width: number): string => value.padEnd(width)

const searchHeader = `${pad('Name', 20)}${pad('Id', 25)}${pad('Version', 10)}${pad('Match', 18)}Source`
const searchRow = (name: string, id: string, version: string, match: string): string =>
  `${pad(name, 20)}${pad(id, 25)}${pad(version, 10)}${pad(match, 18)}winget`
const listHeader = `${pad('Name', 20)}${pad('Id', 25)}${pad('Version', 10)}${pad('Available', 12)}Source`
const listRow = (name: string, id: string, version: string, available: string): string =>
  `${pad(name, 20)}${pad(id, 25)}${pad(version, 10)}${pad(available, 12)}winget`

const searchOutput = [
  searchHeader,
  '-'.repeat(searchHeader.length),
  searchRow('Kotlin', 'JetBrains.Kotlin', '2.2.0', 'Tag: language'),
  searchRow('Zig', 'ziglang.zig', '0.13.0', 'Tag: compiler'),
  searchRow('BadTool', 'Vendor.BadTool', '1.0.0', ''),
  ''
].join('\n')

const listOutput = [
  listHeader,
  '-'.repeat(listHeader.length),
  listRow('Kotlin', 'JetBrains.Kotlin', '2.1.0', '2.2.0'),
  ''
].join('\n')

const kotlinShow = `Found Kotlin [JetBrains.Kotlin]
Version: 2.2.0
Publisher: JetBrains
Publisher Url: https://www.jetbrains.com/
Homepage: https://kotlinlang.org/
License: Apache-2.0
Description: Kotlin is a modern programming language.
Tags:
  kotlin
  language
Installer:
  Installer Type: zip
`

const zigShow = `Found Zig [ziglang.zig]
Version: 0.13.0
Publisher: Zig Software Foundation
Homepage: https://ziglang.org/
License: MIT
Description: General-purpose programming language and toolchain.
Tags:
  compiler
  language
Installer:
  Installer Type: zip
`

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  directory: ''
} as unknown as Logger

function executor(overrides: (args: string[]) => { stdout: string; stderr?: string; exitCode?: number } | null): ProcessExecutor {
  return {
    run: async (_command: string, args: string[]) => {
      const override = overrides(args)
      if (override) return { stdout: override.stdout, stderr: override.stderr ?? '', exitCode: override.exitCode ?? 0 }
      if (args[0] === '--version') return { stdout: 'v1.29.380', stderr: '', exitCode: 0 }
      if (args[0] === 'search') return { stdout: searchOutput, stderr: '', exitCode: 0 }
      if (args[0] === 'list') return { stdout: listOutput, stderr: '', exitCode: 0 }
      if (args[0] === 'show') {
        const id = args[args.indexOf('--id') + 1]
        if (id === 'JetBrains.Kotlin') return { stdout: kotlinShow, stderr: '', exitCode: 0 }
        if (id === 'ziglang.zig') return { stdout: zigShow, stderr: '', exitCode: 0 }
        return { stdout: '', stderr: 'No package found.', exitCode: 1 }
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    },
    isCancellation: () => false
  } as unknown as ProcessExecutor
}

const knownKotlin = buildWinGetPackage({
  wingetId: 'JetBrains.Kotlin',
  packageId: 'kotlin',
  name: 'Kotlin',
  version: '2.1.0',
  publisher: 'JetBrains',
  description: 'Kotlin is a modern programming language.',
  homepage: 'https://kotlinlang.org/',
  license: 'Apache-2.0',
  tags: ['kotlin', 'language']
})

function context(knownPackages: PackageDefinition[] = [knownKotlin]): DiscoveryProviderContext {
  return {
    knownPackages,
    installations: [
      {
        id: 1,
        packageId: 'kotlin',
        version: '2.1.0',
        method: 'winget',
        source: 'devforge',
        installDir: null,
        status: 'installed',
        verificationStatus: 'verified',
        detectedVersion: '2.1.0',
        availableVersion: null,
        envStatus: 'configured',
        isActive: true,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  }
}

describe('WinGetProvider', () => {
  it('classifies known, validated and unvalidated search results', async () => {
    const provider = new WinGetProvider(executor(() => null), logger)
    const outcome = await provider.search('kotlin', context())

    expect(outcome.report.status).toBe('ok')
    expect(outcome.report.message).toContain('2 validated')
    expect(outcome.report.message).toContain('1 metadata-only')

    const kotlin = outcome.results.find((entry) => entry.id === 'winget:JetBrains.Kotlin')
    expect(kotlin).toMatchObject({
      packageId: 'kotlin',
      compatibility: 'installable',
      installedVersion: '2.1.0',
      updateAvailable: true,
      verified: true
    })
    expect(kotlin?.compatibilityNote).toContain('existing DevForge package')

    const zig = outcome.results.find((entry) => entry.id === 'winget:ziglang.zig')
    expect(zig).toMatchObject({
      packageId: null,
      compatibility: 'installable',
      verified: true
    })
    expect(outcome.candidates.get('winget:ziglang.zig')?.packageManagerId).toBe('ziglang.zig')

    const broken = outcome.results.find((entry) => entry.id === 'winget:Vendor.BadTool')
    expect(broken).toMatchObject({
      compatibility: 'metadata-only',
      verified: false,
      packageId: null
    })
    expect(broken?.compatibilityNote).toContain('No package found')
    expect(outcome.candidates.has('winget:Vendor.BadTool')).toBe(false)
  })

  it('does not create a candidate when the generated id collides with another package', async () => {
    const colliding = buildWinGetPackage({
      wingetId: 'Other.Zig',
      packageId: wingetPackageId('ziglang.zig'),
      name: 'Other Zig',
      version: '1.0.0',
      publisher: 'Other',
      description: 'Unrelated package',
      homepage: 'https://example.com/other-zig',
      license: 'MIT',
      tags: []
    })
    const provider = new WinGetProvider(executor(() => null), logger)
    const outcome = await provider.search('zig', { knownPackages: [colliding], installations: [] })
    const zig = outcome.results.find((entry) => entry.id === 'winget:ziglang.zig')
    expect(zig?.compatibility).toBe('metadata-only')
    expect(zig?.compatibilityNote).toContain('already used')
    expect(outcome.candidates.has('winget:ziglang.zig')).toBe(false)
  })

  it('reports unavailable WinGet without running a search', async () => {
    const provider = new WinGetProvider(
      executor((args) => (args[0] === '--version' ? { stdout: '', stderr: 'not found', exitCode: 1 } : null)),
      logger
    )
    const outcome = await provider.search('kotlin', context())
    expect(outcome.report.status).toBe('error')
    expect(outcome.report.message).toContain('not available')
    expect(outcome.results).toEqual([])
  })

  it('handles a failed search gracefully', async () => {
    const provider = new WinGetProvider(
      executor((args) => (args[0] === 'search' ? { stdout: '', stderr: 'network failure', exitCode: 1 } : null)),
      logger
    )
    const outcome = await provider.search('kotlin', context())
    expect(outcome.report.status).toBe('error')
    expect(outcome.report.message).toContain('network failure')
  })
})
