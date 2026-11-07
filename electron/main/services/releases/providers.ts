import type { CanonicalIdentity, VersionSourceKind } from '@shared/identity'
import type { ReleaseRecord, ReleaseSourceInfo } from '@shared/releases'
import type { HttpClient } from './http'
import {
  dartArchiveUrl,
  parseChecksumText,
  parseDartVersion,
  parseFlutterReleases,
  parseGitHubReleases,
  parseGoReleases,
  parseJson,
  parseNodeReleases,
  parsePhpReleases,
  parsePythonReleases
} from './parsers'

export interface ReleaseProviderResult {
  source: ReleaseSourceInfo
  records: ReleaseRecord[]
}

export interface ReleaseProvider {
  readonly id: VersionSourceKind
  source(identity: CanonicalIdentity): ReleaseSourceInfo
  fetch(identity: CanonicalIdentity, http: HttpClient): Promise<ReleaseProviderResult>
}

async function jsonResponse(
  http: HttpClient,
  url: string,
  label: string,
  options: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {}
): Promise<unknown> {
  const response = await http.get(url, options)
  if (!response.ok) {
    throw new Error(`${label} responded with HTTP ${response.status}.`)
  }
  return parseJson(response.text, label)
}

const nodeSource: ReleaseSourceInfo = {
  id: 'nodejs-index',
  label: 'Node.js release index',
  url: 'https://nodejs.org/dist/index.json',
  kind: 'official'
}

export class NodeReleaseProvider implements ReleaseProvider {
  readonly id = 'nodejs' as const

  source(): ReleaseSourceInfo {
    return nodeSource
  }

  async fetch(_identity: CanonicalIdentity, http: HttpClient): Promise<ReleaseProviderResult> {
    const payload = await jsonResponse(http, nodeSource.url!, 'The Node.js release index', {
      timeoutMs: 12000,
      maxBytes: 4 * 1024 * 1024
    })
    return { source: nodeSource, records: parseNodeReleases(payload) }
  }
}

const pythonSource: ReleaseSourceInfo = {
  id: 'python-releases',
  label: 'Python release index',
  url: 'https://www.python.org/api/v2/downloads/release/?is_published=true',
  kind: 'official'
}

export class PythonReleaseProvider implements ReleaseProvider {
  readonly id = 'python' as const

  source(): ReleaseSourceInfo {
    return pythonSource
  }

  async fetch(_identity: CanonicalIdentity, http: HttpClient): Promise<ReleaseProviderResult> {
    const payload = await jsonResponse(http, pythonSource.url!, 'The Python release index', {
      timeoutMs: 15000,
      maxBytes: 16 * 1024 * 1024
    })
    return { source: pythonSource, records: parsePythonReleases(payload) }
  }
}

const goSource: ReleaseSourceInfo = {
  id: 'go-download-index',
  label: 'Go download index',
  url: 'https://go.dev/dl/?mode=json&include=all',
  kind: 'official'
}

export class GoReleaseProvider implements ReleaseProvider {
  readonly id = 'go' as const

  source(): ReleaseSourceInfo {
    return goSource
  }

  async fetch(_identity: CanonicalIdentity, http: HttpClient): Promise<ReleaseProviderResult> {
    const payload = await jsonResponse(http, goSource.url!, 'The Go download index', {
      timeoutMs: 12000,
      maxBytes: 8 * 1024 * 1024
    })
    return { source: goSource, records: parseGoReleases(payload) }
  }
}

const phpSource: ReleaseSourceInfo = {
  id: 'php-windows-releases',
  label: 'PHP for Windows releases',
  url: 'https://windows.php.net/downloads/releases/releases.json',
  kind: 'official'
}

export class PhpReleaseProvider implements ReleaseProvider {
  readonly id = 'php' as const

  source(): ReleaseSourceInfo {
    return phpSource
  }

  async fetch(_identity: CanonicalIdentity, http: HttpClient): Promise<ReleaseProviderResult> {
    const payload = await jsonResponse(http, phpSource.url!, 'The PHP for Windows release index', {
      timeoutMs: 15000,
      maxBytes: 4 * 1024 * 1024
    })
    return { source: phpSource, records: parsePhpReleases(payload) }
  }
}

const flutterSource: ReleaseSourceInfo = {
  id: 'flutter-windows-releases',
  label: 'Flutter Windows releases',
  url: 'https://storage.googleapis.com/flutter_infra_release/releases/releases_windows.json',
  kind: 'official'
}

export class FlutterReleaseProvider implements ReleaseProvider {
  readonly id = 'flutter' as const

  source(): ReleaseSourceInfo {
    return flutterSource
  }

  async fetch(_identity: CanonicalIdentity, http: HttpClient): Promise<ReleaseProviderResult> {
    const payload = await jsonResponse(http, flutterSource.url!, 'The Flutter Windows release index', {
      timeoutMs: 15000,
      maxBytes: 16 * 1024 * 1024
    })
    return { source: flutterSource, records: parseFlutterReleases(payload) }
  }
}

const dartSource: ReleaseSourceInfo = {
  id: 'dart-sdk-archive',
  label: 'Dart SDK archive',
  url: 'https://storage.googleapis.com/dart-archive/channels/stable/release/latest/VERSION',
  kind: 'official'
}

export class DartReleaseProvider implements ReleaseProvider {
  readonly id = 'dart' as const

  source(): ReleaseSourceInfo {
    return dartSource
  }

  async fetch(_identity: CanonicalIdentity, http: HttpClient): Promise<ReleaseProviderResult> {
    const records: ReleaseRecord[] = []
    let stableError: unknown = null

    for (const channel of ['stable', 'beta'] as const) {
      try {
        const versionUrl = `https://storage.googleapis.com/dart-archive/channels/${channel}/release/latest/VERSION`
        const payload = await jsonResponse(http, versionUrl, `The Dart ${channel} version index`, {
          timeoutMs: 10000,
          maxBytes: 64 * 1024
        })
        const parsed = parseDartVersion(payload, channel)
        if (!parsed) continue

        const archiveUrl = dartArchiveUrl(channel, parsed.version)
        let checksum: string | null = null
        try {
          const checksumResponse = await http.get(`${archiveUrl}.sha256sum`, {
            timeoutMs: 10000,
            maxBytes: 16 * 1024
          })
          if (checksumResponse.ok) checksum = parseChecksumText(checksumResponse.text)
        } catch {
          checksum = null
        }

        records.push({
          ...parsed,
          archive: checksum
            ? {
                url: archiveUrl,
                checksum,
                checksumAlgorithm: 'sha256',
                archiveType: 'zip',
                sizeBytes: null
              }
            : null
        })
      } catch (error) {
        if (channel === 'stable') stableError = error
      }
    }

    if (records.length === 0) {
      throw stableError instanceof Error
        ? stableError
        : new Error('The Dart SDK archive did not return a usable release.')
    }
    return { source: dartSource, records }
  }
}

export class GitHubReleaseProvider implements ReleaseProvider {
  readonly id = 'github' as const

  source(identity: CanonicalIdentity): ReleaseSourceInfo {
    const repo = identity.githubRepo ?? 'unknown/unknown'
    return {
      id: `github-${repo}`,
      label: `GitHub releases · ${repo}`,
      url: `https://github.com/${repo}/releases`,
      kind: 'official'
    }
  }

  async fetch(identity: CanonicalIdentity, http: HttpClient): Promise<ReleaseProviderResult> {
    if (!identity.githubRepo) {
      throw new Error(`${identity.name} does not define an official GitHub repository.`)
    }
    const source = this.source(identity)
    const [owner, repo] = identity.githubRepo.split('/')
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=30`
    const response = await http.get(url, {
      timeoutMs: 12000,
      maxBytes: 8 * 1024 * 1024,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      }
    })
    if (!response.ok) {
      const hint = response.status === 403 || response.status === 429
        ? ' GitHub limits anonymous release requests; try again later.'
        : ''
      throw new Error(`GitHub releases responded with HTTP ${response.status}.${hint}`)
    }
    return { source, records: parseGitHubReleases(parseJson(response.text, 'GitHub releases')) }
  }
}

export function defaultReleaseProviders(): ReleaseProvider[] {
  return [
    new NodeReleaseProvider(),
    new PythonReleaseProvider(),
    new GoReleaseProvider(),
    new PhpReleaseProvider(),
    new FlutterReleaseProvider(),
    new DartReleaseProvider(),
    new GitHubReleaseProvider()
  ]
}

