import { describe, expect, it } from 'vitest'
import type { CanonicalIdentity, VersionSourceKind } from '@shared/identity'
import type { ReleaseChannel, ReleaseRecord, ReleaseSourceInfo, VersionResolution } from '@shared/releases'
import type { HttpClient, HttpResponse } from '../electron/main/services/releases/http'
import type { Logger } from '../electron/main/services/logging/Logger'
import {
  buildVersionResolution,
  dartArchiveUrl,
  packageVersionResolution,
  parseChecksumText,
  parseDartVersion,
  parseFlutterReleases,
  parseGitHubReleases,
  parseGoReleases,
  parseJson,
  parseNodeReleases,
  parsePhpReleases,
  parsePythonReleases,
  phpReleasesBaseUrl
} from '../electron/main/services/releases/parsers'
import {
  DartReleaseProvider,
  GitHubReleaseProvider,
  type ReleaseProvider,
  type ReleaseProviderResult
} from '../electron/main/services/releases/providers'
import { ReleaseResolver, type ReleaseCache } from '../electron/main/services/releases/ReleaseResolver'

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger

const officialSource: ReleaseSourceInfo = {
  id: 'test-feed',
  label: 'Test release feed',
  url: 'https://example.com/releases',
  kind: 'official'
}

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

function record(
  version: string,
  channel: ReleaseChannel,
  options: Partial<ReleaseRecord> = {}
): ReleaseRecord {
  return { version, channel, publishedAt: null, archive: null, ...options }
}

function resolution(overrides: Partial<VersionResolution> = {}): VersionResolution {
  return {
    latestStable: null,
    latestLts: null,
    latestPreview: null,
    others: [],
    source: officialSource,
    retrievedAt: new Date().toISOString(),
    stale: false,
    error: null,
    ...overrides
  }
}

function response(text: string, status = 200, url = 'https://example.com/'): HttpResponse {
  return { ok: status >= 200 && status < 300, status, url, text }
}

const fakeHttp: HttpClient = {
  async get(): Promise<HttpResponse> {
    throw new Error('HTTP is not expected in this test')
  }
}

/* ------------------------------------------------------------------ */
/* Parsers                                                             */
/* ------------------------------------------------------------------ */

describe('parseNodeReleases', () => {
  it('classifies LTS, stable and pre-release entries and cleans the version', () => {
    const records = parseNodeReleases([
      { version: 'v23.1.0', date: '2024-10-29', lts: false },
      { version: 'v22.11.0', date: '2024-10-29', lts: 'Jod' },
      { version: 'v21.0.0-rc.1', date: '2024-01-01', lts: false },
      { version: 'v20.0.0', date: 'not-a-date', lts: false }
    ])
    expect(records.map((entry) => [entry.version, entry.channel])).toEqual([
      ['23.1.0', 'stable'],
      ['22.11.0', 'lts'],
      ['21.0.0-rc.1', 'preview'],
      ['20.0.0', 'stable']
    ])
    expect(records[0].publishedAt).toBe('2024-10-29')
    expect(records[3].publishedAt).toBeNull()
  })

  it('returns an empty list for an unexpected payload', () => {
    expect(parseNodeReleases({ version: 'v20.0.0' })).toEqual([])
  })
})

describe('parsePythonReleases', () => {
  it('uses the published pre-release flag and strips the Python prefix', () => {
    const records = parsePythonReleases([
      { name: 'Python 3.13.0', release_date: '2024-10-07', pre_release: false },
      { name: 'Python 3.14.0a1', release_date: '2024-05-07', pre_release: true }
    ])
    expect(records).toEqual([
      { version: '3.13.0', channel: 'stable', publishedAt: '2024-10-07', archive: null },
      { version: '3.14.0a1', channel: 'preview', publishedAt: '2024-05-07', archive: null }
    ])
  })
})

describe('parseGoReleases', () => {
  it('maps the stable flag to the preview channel', () => {
    const records = parseGoReleases([
      { version: 'go1.23.3', stable: true },
      { version: 'go1.24rc1', stable: false }
    ])
    expect(records.map((entry) => [entry.version, entry.channel])).toEqual([
      ['go1.23.3', 'stable'],
      ['go1.24rc1', 'preview']
    ])
  })
})

describe('parsePhpReleases', () => {
  const sha256 = 'a'.repeat(64)

  it('prefers the non-thread-safe x64 zip and builds the archive download', () => {
    const records = parsePhpReleases({
      '8.3': {
        version: '8.3.27',
        'ts-vs17-x64': {
          zip: {
            path: 'php-8.3.27-ts-Win32-vs17-x64.zip',
            sha256: 'b'.repeat(64),
            size: '31.0MB'
          },
          mtime: '2025-10-23'
        },
        'nts-vs17-x64': {
          zip: {
            path: 'php-8.3.27-nts-Win32-vs17-x64.zip',
            sha256,
            size: '30.5MB'
          },
          mtime: '2025-10-23'
        }
      }
    })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      version: '8.3.27',
      channel: 'stable',
      publishedAt: '2025-10-23',
      archive: {
        url: `${phpReleasesBaseUrl}php-8.3.27-nts-Win32-vs17-x64.zip`,
        checksum: sha256,
        checksumAlgorithm: 'sha256',
        archiveType: 'zip',
        sizeBytes: 31_981_568
      }
    })
  })

  it('omits archives without a valid SHA-256 checksum', () => {
    const records = parsePhpReleases({
      '8.4': {
        version: '8.4.0',
        'nts-vs17-x64': {
          zip: { path: 'php-8.4.0-nts.zip', sha256: 'not-a-checksum', size: '30MB' },
          mtime: '2025-10-23'
        }
      }
    })
    expect(records[0].archive).toBeNull()
  })
})

describe('parseFlutterReleases', () => {
  it('resolves archive URLs against base_url and keeps channel information', () => {
    const records = parseFlutterReleases({
      base_url: 'https://storage.googleapis.com/flutter_infra_release/releases',
      releases: [
        {
          version: '3.24.5',
          channel: 'stable',
          archive: 'stable/windows/flutter_windows_3.24.5-stable.zip',
          sha256: 'c'.repeat(64),
          release_date: '2024-10-01'
        },
        {
          version: '3.27.0-0.1.pre',
          channel: 'beta',
          archive: 'beta/windows/flutter_windows_3.27.0-0.1.pre-beta.zip',
          sha256: 'd'.repeat(64),
          release_date: '2024-10-02'
        },
        {
          version: '3.25.0',
          channel: 'stable',
          archive: 'stable/windows/flutter_windows_3.25.0-stable.zip',
          sha256: 'missing',
          release_date: '2024-10-03'
        }
      ]
    })
    expect(records).toHaveLength(3)
    expect(records[0].archive?.url).toBe(
      'https://storage.googleapis.com/flutter_infra_release/releases/stable/windows/flutter_windows_3.24.5-stable.zip'
    )
    expect(records[0].channel).toBe('stable')
    expect(records[1].channel).toBe('preview')
    expect(records[2].archive).toBeNull()
  })
})

describe('Dart parsing helpers', () => {
  it('parses version files per channel', () => {
    expect(parseDartVersion({ version: '3.5.4', date: '2024-10-15' }, 'stable')).toMatchObject({
      version: '3.5.4',
      channel: 'stable',
      publishedAt: '2024-10-15',
      archive: null
    })
    expect(parseDartVersion({ version: '3.6.0-1.2.beta' }, 'beta')?.channel).toBe('preview')
    expect(parseDartVersion({}, 'stable')).toBeNull()
  })

  it('reads SHA-256 checksum files', () => {
    const digest = 'E'.repeat(64)
    expect(parseChecksumText(`${digest}  dartsdk-windows-x64-release.zip\n`)).toBe('e'.repeat(64))
    expect(parseChecksumText('not a checksum')).toBeNull()
  })

  it('builds the official Windows archive URL', () => {
    expect(dartArchiveUrl('stable', '3.5.4')).toBe(
      'https://storage.googleapis.com/dart-archive/channels/stable/release/3.5.4/sdk/dartsdk-windows-x64-release.zip'
    )
  })
})

describe('parseGitHubReleases', () => {
  it('skips drafts and classifies pre-release tags', () => {
    const records = parseGitHubReleases([
      {
        tag_name: 'v2.0.0',
        prerelease: false,
        draft: false,
        published_at: '2024-09-01T00:00:00Z'
      },
      { tag_name: 'v2.1.0-beta.1', prerelease: false, draft: false, published_at: null },
      { tag_name: 'v3.0.0', prerelease: false, draft: true, published_at: null }
    ])
    expect(records).toEqual([
      {
        version: '2.0.0',
        channel: 'stable',
        publishedAt: '2024-09-01T00:00:00Z',
        archive: null
      },
      { version: '2.1.0-beta.1', channel: 'preview', publishedAt: null, archive: null }
    ])
  })
})

describe('parseJson', () => {
  it('reports an unreadable response instead of leaking parser output', () => {
    expect(() => parseJson('<html>', 'Test feed')).toThrow('Test feed returned an unreadable response.')
  })
})

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

describe('buildVersionResolution', () => {
  it('dedupes versions and picks the newest record per channel', () => {
    const records = [
      record('3.0.0', 'stable'),
      record('3.0.0', 'stable'),
      record('2.0.0', 'lts'),
      record('4.0.0-beta', 'preview'),
      ...Array.from({ length: 10 }, (_, index) => record(`1.${index}.0`, 'stable'))
    ]
    const built = buildVersionResolution(records, officialSource)
    expect(built.latestStable?.version).toBe('3.0.0')
    expect(built.latestLts?.version).toBe('2.0.0')
    expect(built.latestPreview?.version).toBe('4.0.0-beta')
    expect(built.others).toHaveLength(8)
    expect(built.others[0].version).toBe('1.9.0')
    expect(built.others[7].version).toBe('1.2.0')
    expect(built.stale).toBe(false)
    expect(built.error).toBeNull()
  })

  it('leaves channels empty when no record exists', () => {
    const built = buildVersionResolution([record('3.0.0', 'stable')], officialSource)
    expect(built.latestLts).toBeNull()
    expect(built.latestPreview).toBeNull()
    expect(built.others).toEqual([])
  })
})

describe('packageVersionResolution', () => {
  it('labels a manifest version as stable catalogue data', () => {
    const built = packageVersionResolution('1.2.3', {
      id: 'devforge-winget-definition',
      label: 'DevForge WinGet definition',
      url: null,
      kind: 'package'
    })
    expect(built.latestStable?.version).toBe('1.2.3')
    expect(built.source.kind).toBe('package')
  })
})

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

describe('DartReleaseProvider', () => {
  it('resolves the stable version and its checksum while tolerating a beta failure', async () => {
    const requested: string[] = []
    const http: HttpClient = {
      async get(url) {
        requested.push(url)
        if (url.endsWith('/stable/release/latest/VERSION')) {
          return response(JSON.stringify({ version: '3.5.4', date: '2024-10-15' }))
        }
        if (url.includes('/stable/') && url.endsWith('.sha256sum')) {
          return response(`${'f'.repeat(64)}  dartsdk-windows-x64-release.zip`)
        }
        return response('', 404, url)
      }
    }
    const result = await new DartReleaseProvider().fetch(identity({ id: 'dart', versionSource: 'dart' }), http)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      version: '3.5.4',
      channel: 'stable',
      archive: {
        checksum: 'f'.repeat(64),
        checksumAlgorithm: 'sha256',
        archiveType: 'zip'
      }
    })
    expect(result.records[0].archive?.url).toContain('/stable/release/3.5.4/sdk/')
    expect(requested.some((url) => url.includes('/beta/release/latest/VERSION'))).toBe(true)
  })

  it('fails with the stable channel error when no channel produces a release', async () => {
    const http: HttpClient = { get: async (url) => response('', 404, url) }
    await expect(
      new DartReleaseProvider().fetch(identity({ id: 'dart', versionSource: 'dart' }), http)
    ).rejects.toThrow('HTTP 404')
  })
})

describe('GitHubReleaseProvider', () => {
  const repository = identity({
    id: 'composer',
    versionSource: 'github',
    githubRepo: 'composer/composer'
  })

  it('requests the official repository releases with API headers', async () => {
    let requestedUrl = ''
    let requestedHeaders: Record<string, string> | undefined
    const http: HttpClient = {
      async get(url, options) {
        requestedUrl = url
        requestedHeaders = options?.headers
        return response(
          JSON.stringify([
            { tag_name: 'v2.8.3', prerelease: false, draft: false, published_at: '2024-11-01' }
          ])
        )
      }
    }
    const result = await new GitHubReleaseProvider().fetch(repository, http)
    expect(requestedUrl).toBe('https://api.github.com/repos/composer/composer/releases?per_page=30')
    expect(requestedHeaders?.accept).toBe('application/vnd.github+json')
    expect(result.records[0].version).toBe('2.8.3')
    expect(result.source.url).toBe('https://github.com/composer/composer/releases')
  })

  it('explains rate limiting and refuses identities without a repository', async () => {
    const limited: HttpClient = { get: async (url) => response('', 403, url) }
    await expect(new GitHubReleaseProvider().fetch(repository, limited)).rejects.toThrow(
      'GitHub limits anonymous release requests'
    )
    await expect(
      new GitHubReleaseProvider().fetch(identity({ id: 'unknown' }), fakeHttp)
    ).rejects.toThrow('does not define an official GitHub repository')
  })
})

/* ------------------------------------------------------------------ */
/* Resolution cache                                                    */
/* ------------------------------------------------------------------ */

interface FakeProvider extends ReleaseProvider {
  calls: number
}

function fakeProvider(
  id: VersionSourceKind,
  records: () => Promise<ReleaseRecord[]>
): FakeProvider {
  const provider: FakeProvider = {
    id,
    calls: 0,
    source: (): ReleaseSourceInfo => ({
      id: `${id}-feed`,
      label: `${id} release feed`,
      url: 'https://example.com/feed',
      kind: 'official'
    }),
    async fetch(): Promise<ReleaseProviderResult> {
      provider.calls += 1
      return { source: provider.source(identity({ id })), records: await records() }
    }
  }
  return provider
}

describe('ReleaseResolver', () => {
  it('resolves once and serves the cache afterwards', async () => {
    const provider = fakeProvider('nodejs', async () => [
      record('20.0.0', 'stable'),
      record('18.0.0', 'lts')
    ])
    const saved: ReleaseCache[] = []
    const resolver = new ReleaseResolver(fakeHttp, logger, {}, [provider])
    resolver.setOnChange((cache) => saved.push(cache))

    const node = identity({ id: 'nodejs', versionSource: 'nodejs' })
    const first = await resolver.resolve(node)
    const second = await resolver.resolve(node)

    expect(first.latestStable?.version).toBe('20.0.0')
    expect(first.latestLts?.version).toBe('18.0.0')
    expect(second).toEqual(first)
    expect(provider.calls).toBe(1)
    expect(saved.at(-1)?.['nodejs']?.resolution.latestStable?.version).toBe('20.0.0')
  })

  it('deduplicates concurrent requests for the same identity', async () => {
    const provider = fakeProvider('nodejs', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return [record('20.0.0', 'stable')]
    })
    const resolver = new ReleaseResolver(fakeHttp, logger, {}, [provider])
    const node = identity({ id: 'nodejs', versionSource: 'nodejs' })

    const [first, second] = await Promise.all([resolver.resolve(node), resolver.resolve(node)])
    expect(first.latestStable?.version).toBe('20.0.0')
    expect(second.latestStable?.version).toBe('20.0.0')
    expect(provider.calls).toBe(1)
  })

  it('marks an expired cached result as stale when a refresh fails', async () => {
    const cached: ReleaseCache = {
      nodejs: {
        resolution: resolution({ latestStable: record('19.0.0', 'stable') }),
        expiresAt: new Date(Date.now() - 1000).toISOString()
      }
    }
    const provider = fakeProvider('nodejs', async () => {
      throw new Error('feed unavailable')
    })
    const resolver = new ReleaseResolver(fakeHttp, logger, cached, [provider])
    const result = await resolver.resolve(identity({ id: 'nodejs', versionSource: 'nodejs' }))

    expect(result.latestStable?.version).toBe('19.0.0')
    expect(result.stale).toBe(true)
    expect(result.error).toBe('feed unavailable')
    expect(provider.calls).toBe(1)
  })

  it('returns an empty, explicit error instead of inventing a version', async () => {
    const provider = fakeProvider('nodejs', async () => {
      throw new Error('feed unavailable')
    })
    const resolver = new ReleaseResolver(fakeHttp, logger, {}, [provider])
    const result = await resolver.resolve(identity({ id: 'nodejs', versionSource: 'nodejs' }))

    expect(result.latestStable).toBeNull()
    expect(result.latestLts).toBeNull()
    expect(result.stale).toBe(false)
    expect(result.error).toBe('feed unavailable')
    expect(result.source.id).toBe('nodejs-feed')
  })

  it('falls back to the manifest version for WinGet and catalogue sources', async () => {
    const resolver = new ReleaseResolver(fakeHttp, logger, {}, [])
    const winget = await resolver.resolve(identity({ id: 'java-jdk', versionSource: 'winget' }), '21.0.2')
    expect(winget.latestStable?.version).toBe('21.0.2')
    expect(winget.source.kind).toBe('package')
    expect(winget.error).toBeNull()

    const empty = await resolver.resolve(identity({ id: 'mingw', versionSource: 'none' }), null)
    expect(empty.latestStable).toBeNull()
    expect(empty.source.kind).toBe('catalogue')
  })

  it('reports a missing provider for an unsupported version source', async () => {
    const resolver = new ReleaseResolver(fakeHttp, logger, {}, [])
    const result = await resolver.resolve(identity({ id: 'dart', versionSource: 'dart' }))
    expect(result.latestStable).toBeNull()
    expect(result.error).toContain('No release provider is configured for "dart"')
  })
})
