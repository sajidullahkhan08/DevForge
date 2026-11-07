import type { CanonicalIdentity, OfficialArchiveKind } from './identity'
import type { PackageDefinition, RegistryVersion } from './registry'
import type { ReleaseRecord, VersionResolution } from './releases'
import { compareVersions } from './version'

interface OfficialArchiveLayout {
  license: string
  installDirectoryTemplate: string
  expectedExecutables: string[]
  environmentPath: string
  verification: { command: string; args: string[]; expectPattern: string; versionPattern: string }
  detection: { command?: string; args?: string[]; versionPattern?: string }
  caveats: string[]
}

const layouts: Record<OfficialArchiveKind, OfficialArchiveLayout> = {
  flutter: {
    license: 'BSD-3-Clause',
    installDirectoryTemplate: '{toolsDir}\\Flutter\\{version}',
    expectedExecutables: ['bin\\flutter.bat'],
    environmentPath: '{installDir}\\bin',
    verification: {
      command: 'flutter.bat',
      args: ['--version'],
      expectPattern: 'Flutter',
      versionPattern: 'Flutter\\s+([\\d.]+)'
    },
    detection: { command: 'flutter.bat', args: ['--version'], versionPattern: 'Flutter\\s+([\\d.]+)' },
    caveats: [
      'DevForge installs the official Flutter SDK archive from Google and verifies its SHA-256 checksum.',
      'The first Flutter command may download additional SDK components and requires an internet connection.',
      'Flutter is large: the Windows SDK archive can take a long time to download and extract.'
    ]
  },
  dart: {
    license: 'BSD-3-Clause',
    installDirectoryTemplate: '{toolsDir}\\Dart\\{version}',
    expectedExecutables: ['bin\\dart.exe'],
    environmentPath: '{installDir}\\bin',
    verification: {
      command: 'dart',
      args: ['--version'],
      expectPattern: 'Dart SDK version',
      versionPattern: 'Dart SDK version:\\s*([\\d.]+)'
    },
    detection: { command: 'dart', args: ['--version'], versionPattern: 'Dart SDK version:\\s*([\\d.]+)' },
    caveats: [
      'DevForge installs the official Dart SDK archive from Google and verifies its SHA-256 checksum.',
      'The Dart SDK is separate from Flutter; Flutter bundles its own Dart SDK.'
    ]
  },
  php: {
    license: 'PHP-3.01',
    installDirectoryTemplate: '{toolsDir}\\PHP\\{version}',
    expectedExecutables: ['php.exe'],
    environmentPath: '{installDir}',
    verification: {
      command: 'php',
      args: ['--version'],
      expectPattern: 'PHP',
      versionPattern: 'PHP\\s+([\\d.]+)'
    },
    detection: { command: 'php', args: ['--version'], versionPattern: 'PHP\\s+([\\d.]+)' },
    caveats: [
      'DevForge installs the official PHP for Windows archive and verifies its SHA-256 checksum.',
      'No php.ini is activated. Copy php.ini-development to php.ini and enable extensions you need.',
      'This is the non-thread-safe x64 build, which is appropriate for command-line PHP.'
    ]
  }
}

function versionRecords(resolution: VersionResolution): ReleaseRecord[] {
  const seen = new Set<string>()
  const records: ReleaseRecord[] = []
  for (const record of [
    resolution.latestLts,
    resolution.latestStable,
    ...resolution.others
  ]) {
    if (!record || !record.archive) continue
    if (record.channel === 'preview') continue
    if (seen.has(record.version)) continue
    seen.add(record.version)
    records.push(record)
  }
  return records.sort((left, right) => compareVersions(right.version, left.version))
}

export function isOfficialArchiveInstallable(
  identity: CanonicalIdentity,
  resolution: VersionResolution | null
): boolean {
  if (!identity.officialArchive || !resolution) return false
  return versionRecords(resolution).length > 0
}

/**
 * Builds an installable package definition from a resolved official release
 * archive. Only archives with an HTTPS URL and a SHA-256 checksum become
 * versions; anything else is omitted rather than installed unverified.
 */
export function buildOfficialArchivePackage(
  identity: CanonicalIdentity,
  resolution: VersionResolution
): PackageDefinition | null {
  if (!identity.officialArchive) return null
  const layout = layouts[identity.officialArchive]
  const records = versionRecords(resolution)
  if (records.length === 0) return null

  const recommended =
    records.find((record) => record.channel === 'lts') ?? records[0]
  const versions: RegistryVersion[] = records.map((record) => ({
    version: record.version,
    channel: record.channel === 'lts' ? 'lts' : 'stable',
    isDefault: record.version === recommended.version,
    download: {
      url: record.archive!.url,
      archiveType: 'zip',
      checksum: record.archive!.checksum,
      checksumAlgorithm: record.archive!.checksumAlgorithm,
      ...(record.archive!.sizeBytes ? { sizeBytes: record.archive!.sizeBytes } : {}),
      stripRootFolder: true
    },
    ...(record.archive!.sizeBytes ? { estimatedSizeBytes: record.archive!.sizeBytes } : {}),
    installArgs: []
  }))

  return {
    schemaVersion: 1,
    id: identity.id,
    name: identity.name,
    category: identity.category,
    origin: 'official',
    description: identity.description,
    longDescription: `${identity.description} DevForge installs the official ${identity.name} release archive published by ${identity.publisher} and verifies its SHA-256 checksum before extraction.`,
    publisher: identity.publisher,
    homepage: identity.homepage,
    documentationUrl: identity.homepage,
    license: layout.license,
    icon: identity.icon,
    installationMethod: 'archive',
    scope: 'user',
    supportedArchitectures: identity.architectures,
    supportedWindowsVersions: ['10', '11'],
    requiresAdmin: false,
    requiresRestart: false,
    advanced: false,
    caveats: layout.caveats,
    tags: identity.tags,
    installDirectoryTemplate: layout.installDirectoryTemplate,
    expectedExecutables: layout.expectedExecutables,
    supportsVersionSwitching: versions.length > 1,
    versions,
    dependencies: [],
    environment: [
      {
        kind: 'path',
        name: 'PATH',
        valueTemplate: layout.environmentPath,
        scope: 'user'
      }
    ],
    verification: [
      {
        id: `${identity.id}-version`,
        label: `${identity.name} command line`,
        kind: 'command',
        command: layout.verification.command,
        args: layout.verification.args,
        expectPattern: layout.verification.expectPattern,
        versionPattern: layout.verification.versionPattern,
        optional: false
      }
    ],
    detection: {
      args: layout.detection.args ?? [],
      ...(layout.detection.command ? { command: layout.detection.command } : {}),
      ...(layout.detection.versionPattern ? { versionPattern: layout.detection.versionPattern } : {}),
      knownPaths: []
    },
    uninstall: { method: 'directory', keepData: true, args: [] }
  }
}
