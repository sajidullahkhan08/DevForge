import { describe, expect, it } from 'vitest'
import { validatePackageDefinition, validatePackageSemantics } from '@shared/registry'
import {
  buildWinGetPackage,
  githubDiscoveryId,
  inferSoftwareIcon,
  isHttpsUrl,
  managerIdForPackage,
  normalizeWinGetVersion,
  parseWinGetListTable,
  parseWinGetSearchTable,
  parseWinGetShow,
  wingetDiscoveryId,
  wingetPackageId
} from '@shared/winget'

const searchOutput = `Name                  Id                          Version   Match             Source
-------------------------------------------------------------------------------------
Kotlin                JetBrains.Kotlin            2.1.0     Tag: language     winget
Kotlin Compiler       Eclipse.Kotlin.Compiler     2.1.0     Tag: compiler     winget
Flutter               Google.Flutter              3.24.0                      winget
`

const listOutput = `Name                  Id                          Version   Available   Source
--------------------------------------------------------------------------------
Kotlin                JetBrains.Kotlin            2.1.0     2.2.0       winget
Flutter               Google.Flutter              3.24.0                 winget
No installed package found matching input criteria.
`

const showOutput = `Found Kotlin [JetBrains.Kotlin]
Version: 2.2.0
Publisher: JetBrains
Publisher Url: https://www.jetbrains.com/
Homepage: https://kotlinlang.org/
License: Apache-2.0
Description: Kotlin is a modern programming language
  that makes developers happier.
Tags:
  kotlin
  language
Moniker: kotlin
Installer:
  Installer Type: zip
  Installer Url: https://example.org/kotlin.zip
`

describe('WinGet table parsers', () => {
  it('parses search rows with match and source columns', () => {
    const rows = parseWinGetSearchTable(searchOutput)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      name: 'Kotlin',
      id: 'JetBrains.Kotlin',
      version: '2.1.0',
      match: 'Tag: language',
      source: 'winget'
    })
    expect(rows[2].match).toBeNull()
  })

  it('parses installed rows with the available-update column', () => {
    const rows = parseWinGetListTable(listOutput)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      name: 'Kotlin',
      id: 'JetBrains.Kotlin',
      version: '2.1.0',
      available: '2.2.0'
    })
    expect(rows[1].available).toBeNull()
  })

  it('returns no rows for unrecognised output', () => {
    expect(parseWinGetSearchTable('something went wrong')).toEqual([])
    expect(parseWinGetListTable('')).toEqual([])
  })
})

describe('parseWinGetShow', () => {
  it('reads fields, joins multiline descriptions and splits tags', () => {
    const info = parseWinGetShow(showOutput)
    expect(info.id).toBe('JetBrains.Kotlin')
    expect(info.name).toBe('Kotlin')
    expect(info.version).toBe('2.2.0')
    expect(info.publisher).toBe('JetBrains')
    expect(info.publisherUrl).toBe('https://www.jetbrains.com/')
    expect(info.homepage).toBe('https://kotlinlang.org/')
    expect(info.license).toBe('Apache-2.0')
    expect(info.description).toBe('Kotlin is a modern programming language that makes developers happier.')
    expect(info.tags).toEqual(['kotlin', 'language'])
    expect(info.moniker).toBe('kotlin')
    expect(info.hasInstaller).toBe(true)
  })

  it('ignores warning lines', () => {
    const info = parseWinGetShow(`WARNING: The source requires authentication\nFound Tool [Vendor.Tool]\nVersion: 1.0.0\n`)
    expect(info.id).toBe('Vendor.Tool')
    expect(info.version).toBe('1.0.0')
  })
})

describe('version and id helpers', () => {
  it('normalizes safe versions and rejects unsafe strings', () => {
    expect(normalizeWinGetVersion('v3.24.0')).toBe('3.24.0')
    expect(normalizeWinGetVersion(' 2.1.0-beta.1 ')).toBe('2.1.0-beta.1')
    expect(normalizeWinGetVersion('latest')).toBeNull()
    expect(normalizeWinGetVersion('1.0/../../evil')).toBeNull()
    expect(normalizeWinGetVersion(null)).toBeNull()
  })

  it('builds provider-scoped discovery ids', () => {
    expect(wingetDiscoveryId('JetBrains.Kotlin')).toBe('winget:JetBrains.Kotlin')
    expect(githubDiscoveryId('JetBrains/kotlin')).toBe('github:JetBrains/kotlin')
  })

  it('creates schema-safe package ids and truncates long ones', () => {
    expect(wingetPackageId('JetBrains.Kotlin')).toBe('winget-jetbrains-kotlin')
    expect(wingetPackageId('A.B+')).toBe('winget-a-b')
    const long = wingetPackageId('Vendor.With.A.Very.Long.Package.Identifier.That.Keeps.Going.And.Going')
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    expect(long).not.toBe(
      wingetPackageId('Vendor.With.A.Very.Long.Package.Identifier.That.Keeps.Going.And.Going.Two')
    )
  })

  it('resolves the WinGet id from package or version metadata', () => {
    const pkg = buildWinGetPackage({
      wingetId: 'Vendor.Tool',
      name: 'Tool',
      version: '1.0.0',
      publisher: 'Vendor',
      description: 'A tool',
      homepage: 'https://example.com',
      license: 'MIT',
      tags: []
    })
    expect(managerIdForPackage(pkg)).toBe('Vendor.Tool')
    expect(pkg.versions[0].packageManagerId).toBe('Vendor.Tool')
  })

  it('only accepts HTTPS URLs', () => {
    expect(isHttpsUrl('https://example.com/tool')).toBe(true)
    expect(isHttpsUrl('http://example.com/tool')).toBe(false)
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpsUrl(null)).toBe(false)
  })
})

describe('buildWinGetPackage', () => {
  const input = {
    wingetId: 'JetBrains.Kotlin',
    name: 'Kotlin',
    version: '2.2.0',
    publisher: 'JetBrains',
    description: 'Kotlin is a modern programming language.',
    homepage: 'https://kotlinlang.org/',
    license: 'Apache-2.0',
    tags: ['kotlin', 'language']
  }

  it('produces a valid, semantically clean package definition', () => {
    const pkg = buildWinGetPackage(input)
    expect(pkg.origin).toBe('winget')
    expect(pkg.installationMethod).toBe('winget')
    expect(pkg.packageManagerId).toBe('JetBrains.Kotlin')
    expect(pkg.environment).toEqual([])
    expect(pkg.expectedExecutables).toEqual([])
    expect(pkg.supportsVersionSwitching).toBe(false)
    expect(pkg.versions).toHaveLength(1)
    expect(pkg.versions[0]).toMatchObject({
      version: '2.2.0',
      isDefault: true,
      installArgs: []
    })
    expect(pkg.verification[0].kind).toBe('winget')
    expect(pkg.uninstall?.method).toBe('winget')

    expect(validatePackageDefinition(pkg).ok).toBe(true)
    expect(validatePackageSemantics(pkg)).toEqual([])
  })

  it('derives an icon and category from the WinGet metadata', () => {
    const pkg = buildWinGetPackage(input)
    expect(pkg.icon).toBe('kotlin')
    expect(pkg.category).toBe('language')
  })

  it('keeps an explicitly requested id and category', () => {
    const pkg = buildWinGetPackage({
      ...input,
      packageId: 'winget-jetbrains-kotlin',
      category: 'developer-tool',
      icon: 'terminal'
    })
    expect(pkg.id).toBe('winget-jetbrains-kotlin')
    expect(pkg.category).toBe('developer-tool')
    expect(pkg.icon).toBe('terminal')
  })
})

describe('inferSoftwareIcon', () => {
  it('maps common runtimes and frameworks to brand icons', () => {
    expect(inferSoftwareIcon({ name: 'Kotlin' })).toBe('kotlin')
    expect(inferSoftwareIcon({ name: 'Flutter SDK' })).toBe('flutter')
    expect(inferSoftwareIcon({ name: 'Dart SDK' })).toBe('dart')
    expect(inferSoftwareIcon({ name: 'PHP 8.3' })).toBe('php')
    expect(inferSoftwareIcon({ name: 'Ruby Installer' })).toBe('ruby')
    expect(inferSoftwareIcon({ name: 'LLVM' })).toBe('llvm')
    expect(inferSoftwareIcon({ name: 'Microsoft Visual C++ Redistributable' })).toBe('cplusplus')
    expect(inferSoftwareIcon({ name: 'Unknown Utility' })).toBe('terminal')
  })
})
