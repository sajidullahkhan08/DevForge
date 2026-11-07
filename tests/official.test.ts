import { describe, expect, it } from 'vitest'
import type { CanonicalIdentity, OfficialArchiveKind } from '@shared/identity'
import { buildOfficialArchivePackage, isOfficialArchiveInstallable } from '@shared/official'
import type { ReleaseRecord, ReleaseSourceInfo, VersionResolution } from '@shared/releases'
import { validatePackageDefinition, validatePackageSemantics } from '@shared/registry'

const source: ReleaseSourceInfo = {
  id: 'official-feed',
  label: 'Official release feed',
  url: 'https://example.com/releases',
  kind: 'official'
}

function identity(
  archive: OfficialArchiveKind,
  overrides: Partial<CanonicalIdentity> = {}
): CanonicalIdentity {
  const name = archive === 'flutter' ? 'Flutter' : archive === 'dart' ? 'Dart' : 'PHP'
  return {
    schemaVersion: 1,
    id: archive,
    name,
    officialName: `${name} SDK`,
    publisher: archive === 'php' ? 'PHP Group' : 'Google',
    homepage: 'https://example.com/',
    category: archive === 'php' ? 'runtime' : 'framework',
    description: `The official ${name} distribution`,
    icon: 'terminal',
    aliases: [name],
    executables: [archive === 'flutter' ? 'flutter' : archive],
    packageIds: [],
    wingetIds: [],
    githubRepo: null,
    versionSource: archive,
    installationAdapters: ['official-archive'],
    officialArchive: archive,
    relatedTools: [],
    tags: [name],
    platforms: ['windows'],
    architectures: ['x64'],
    ...overrides
  }
}

function record(
  version: string,
  channel: ReleaseRecord['channel'],
  options: { archive?: boolean; sizeBytes?: number | null } = {}
): ReleaseRecord {
  const withArchive = options.archive ?? true
  return {
    version,
    channel,
    publishedAt: null,
    archive: withArchive
      ? {
          url: `https://example.com/releases/${version}.zip`,
          checksum: 'a'.repeat(64),
          checksumAlgorithm: 'sha256',
          archiveType: 'zip',
          sizeBytes: options.sizeBytes ?? null
        }
      : null
  }
}

function resolution(overrides: Partial<VersionResolution> = {}): VersionResolution {
  return {
    latestStable: null,
    latestLts: null,
    latestPreview: null,
    others: [],
    source,
    retrievedAt: new Date().toISOString(),
    stale: false,
    error: null,
    ...overrides
  }
}

describe('buildOfficialArchivePackage', () => {
  const flutterResolution = resolution({
    latestStable: record('3.27.1', 'stable', { sizeBytes: 1_000_000 }),
    latestLts: record('3.24.5', 'lts'),
    latestPreview: record('3.30.0-0.1.pre', 'preview'),
    others: [record('3.29.0', 'stable'), record('3.10.0', 'stable', { archive: false })]
  })

  it('builds a schema-valid installable package from verified archives', () => {
    const pkg = buildOfficialArchivePackage(identity('flutter'), flutterResolution)
    expect(pkg).not.toBeNull()
    if (!pkg) return

    expect(pkg).toMatchObject({
      id: 'flutter',
      name: 'Flutter',
      origin: 'official',
      installationMethod: 'archive',
      publisher: 'Google',
      license: 'BSD-3-Clause',
      supportsVersionSwitching: true,
      installDirectoryTemplate: '{toolsDir}\\Flutter\\{version}',
      expectedExecutables: ['bin\\flutter.bat'],
      uninstall: { method: 'directory', keepData: true }
    })
    expect(pkg.environment).toEqual([
      { kind: 'path', name: 'PATH', valueTemplate: '{installDir}\\bin', scope: 'user' }
    ])
    expect(pkg.verification[0]).toMatchObject({
      kind: 'command',
      command: 'flutter.bat',
      args: ['--version']
    })
    expect(pkg.detection.command).toBe('flutter.bat')

    const validation = validatePackageDefinition(pkg)
    expect(validation.ok).toBe(true)
    expect(validatePackageSemantics(pkg)).toEqual([])
  })

  it('maps archives to versions and defaults to LTS, excluding previews and unverified archives', () => {
    const pkg = buildOfficialArchivePackage(identity('flutter'), flutterResolution)
    expect(pkg?.versions.map((version) => [version.version, version.channel, version.isDefault])).toEqual([
      ['3.29.0', 'stable', false],
      ['3.27.1', 'stable', false],
      ['3.24.5', 'lts', true]
    ])
    expect(pkg?.versions[1].download).toEqual({
      url: 'https://example.com/releases/3.27.1.zip',
      archiveType: 'zip',
      checksum: 'a'.repeat(64),
      checksumAlgorithm: 'sha256',
      sizeBytes: 1_000_000,
      stripRootFolder: true
    })
    expect(pkg?.versions[1].estimatedSizeBytes).toBe(1_000_000)
    expect(pkg?.versions.find((version) => version.version === '3.10.0')).toBeUndefined()
    expect(pkg?.versions.some((version) => version.version.startsWith('3.30.'))).toBe(false)
  })

  it('falls back to the newest verified stable release when no LTS has an archive', () => {
    const pkg = buildOfficialArchivePackage(
      identity('flutter'),
      resolution({
        latestStable: record('3.27.1', 'stable'),
        latestLts: record('3.24.5', 'lts', { archive: false })
      })
    )
    expect(pkg?.versions).toHaveLength(1)
    expect(pkg?.versions[0]).toMatchObject({ version: '3.27.1', isDefault: true })
  })

  it('refuses to build installable versions from preview or unverified data', () => {
    const previewOnly = resolution({ latestPreview: record('3.30.0-0.1.pre', 'preview') })
    expect(buildOfficialArchivePackage(identity('flutter'), previewOnly)).toBeNull()
    expect(isOfficialArchiveInstallable(identity('flutter'), previewOnly)).toBe(false)

    const noArchives = resolution({
      latestStable: record('3.27.1', 'stable', { archive: false })
    })
    expect(buildOfficialArchivePackage(identity('flutter'), noArchives)).toBeNull()
    expect(isOfficialArchiveInstallable(identity('flutter'), noArchives)).toBe(false)
  })

  it('requires both an official archive identity and a resolution', () => {
    const nonArchive = identity('flutter', {
      officialArchive: null,
      installationAdapters: ['winget']
    })
    expect(buildOfficialArchivePackage(nonArchive, flutterResolution)).toBeNull()
    expect(buildOfficialArchivePackage(identity('flutter'), resolution())).toBeNull()
    expect(isOfficialArchiveInstallable(identity('flutter'), null)).toBe(false)
    expect(isOfficialArchiveInstallable(identity('flutter'), flutterResolution)).toBe(true)
  })

  it('uses the Dart and PHP archive layouts', () => {
    const dart = buildOfficialArchivePackage(
      identity('dart'),
      resolution({ latestStable: record('3.5.4', 'stable') })
    )
    expect(dart).toMatchObject({
      installDirectoryTemplate: '{toolsDir}\\Dart\\{version}',
      expectedExecutables: ['bin\\dart.exe'],
      license: 'BSD-3-Clause'
    })
    expect(dart?.environment[0].valueTemplate).toBe('{installDir}\\bin')
    expect(dart?.verification[0]).toMatchObject({ command: 'dart', expectPattern: 'Dart SDK version' })

    const php = buildOfficialArchivePackage(
      identity('php'),
      resolution({ latestStable: record('8.3.27', 'stable') })
    )
    expect(php).toMatchObject({
      installDirectoryTemplate: '{toolsDir}\\PHP\\{version}',
      expectedExecutables: ['php.exe'],
      license: 'PHP-3.01'
    })
    expect(php?.environment[0].valueTemplate).toBe('{installDir}')
    expect(php?.caveats.some((caveat) => caveat.includes('php.ini'))).toBe(true)

    for (const pkg of [dart, php]) {
      expect(pkg).not.toBeNull()
      if (!pkg) continue
      expect(validatePackageDefinition(pkg).ok).toBe(true)
      expect(validatePackageSemantics(pkg)).toEqual([])
    }
  })
})
