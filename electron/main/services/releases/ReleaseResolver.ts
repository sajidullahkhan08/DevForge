import type { CanonicalIdentity } from '@shared/identity'
import { emptyResolution, type ReleaseSourceInfo, type VersionResolution } from '@shared/releases'
import type { Logger } from '../logging/Logger'
import { buildVersionResolution, packageVersionResolution } from './parsers'
import type { HttpClient } from './http'
import { defaultReleaseProviders, type ReleaseProvider } from './providers'

export interface StoredReleaseResolution {
  resolution: VersionResolution
  expiresAt: string
}

export type ReleaseCache = Record<string, StoredReleaseResolution>

const releaseTtlMs = 6 * 60 * 60 * 1000
const emptyTtlMs = 30 * 60 * 1000
const maxCacheEntries = 120

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const catalogueSource: ReleaseSourceInfo = {
  id: 'devforge-catalogue',
  label: 'DevForge catalog definition',
  url: null,
  kind: 'catalogue'
}

const winGetDefinitionSource: ReleaseSourceInfo = {
  id: 'devforge-winget-definition',
  label: 'DevForge WinGet definition',
  url: null,
  kind: 'package'
}

/**
 * Resolves the authoritative version channels for a canonical software
 * identity. Only the provider registered for the identity's declared version
 * source is trusted; cached data is served when fresh and is explicitly
 * marked stale when a refresh fails.
 */
export class ReleaseResolver {
  private readonly providers: Map<string, ReleaseProvider>
  private readonly inflight = new Map<string, Promise<VersionResolution>>()
  private cache: ReleaseCache

  private onChange: ((cache: ReleaseCache) => void) | undefined

  constructor(
    private readonly http: HttpClient,
    private readonly logger: Logger,
    cache: ReleaseCache = {},
    providers: ReleaseProvider[] = defaultReleaseProviders(),
    onChange?: (cache: ReleaseCache) => void
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
    this.cache = this.sanitize(cache)
    this.onChange = onChange
  }

  setOnChange(handler: (cache: ReleaseCache) => void): void {
    this.onChange = handler
  }

  snapshot(): ReleaseCache {
    return structuredClone(this.cache)
  }

  private sanitize(cache: ReleaseCache): ReleaseCache {
    const clean: ReleaseCache = {}
    for (const [key, value] of Object.entries(cache)) {
      if (!value || typeof value !== 'object') continue
      const { resolution, expiresAt } = value
      if (!resolution || typeof resolution !== 'object') continue
      if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) continue
      if (!resolution.source || !Array.isArray(resolution.others)) continue
      clean[key] = { resolution, expiresAt }
    }
    return clean
  }

  private prune(now: number): void {
    const entries = Object.entries(this.cache)
    if (entries.length <= maxCacheEntries) return
    entries
      .filter(([, value]) => Date.parse(value.expiresAt) <= now)
      .forEach(([key]) => delete this.cache[key])
    while (Object.keys(this.cache).length > maxCacheEntries) {
      const oldest = Object.entries(this.cache).sort(
        (left, right) => Date.parse(left[1].expiresAt) - Date.parse(right[1].expiresAt)
      )[0]
      if (!oldest) break
      delete this.cache[oldest[0]]
    }
  }

  private store(identityId: string, resolution: VersionResolution, ttlMs: number, now: number): void {
    this.cache[identityId] = {
      resolution,
      expiresAt: new Date(now + ttlMs).toISOString()
    }
    this.prune(now)
    try {
      this.onChange?.(this.snapshot())
    } catch (error) {
      this.logger.warn('Could not persist the release cache', { error: errorMessage(error) })
    }
  }

  private fallbackResolution(
    identity: CanonicalIdentity,
    catalogueVersion: string | null
  ): VersionResolution {
    if (!catalogueVersion) {
      return emptyResolution(
        identity.versionSource === 'winget' ? winGetDefinitionSource : catalogueSource,
        null
      )
    }
    return packageVersionResolution(
      catalogueVersion,
      identity.versionSource === 'winget' ? winGetDefinitionSource : catalogueSource
    )
  }

  /**
   * `catalogueVersion` is the version currently defined by the DevForge
   * package (or WinGet definition). It is shown as a manifest version and is
   * never presented as the upstream latest release.
   */
  async resolve(identity: CanonicalIdentity, catalogueVersion: string | null = null): Promise<VersionResolution> {
    if (identity.versionSource === 'none' || identity.versionSource === 'winget') {
      return this.fallbackResolution(identity, catalogueVersion)
    }

    const provider = this.providers.get(identity.versionSource)
    if (!provider) {
      return emptyResolution(
        { id: identity.versionSource, label: 'Unsupported release source', url: null, kind: 'official' },
        `No release provider is configured for "${identity.versionSource}".`
      )
    }

    const now = Date.now()
    const cached = this.cache[identity.id]
    if (cached && Date.parse(cached.expiresAt) > now) {
      return cached.resolution
    }

    const existing = this.inflight.get(identity.id)
    if (existing) return existing

    const task = (async (): Promise<VersionResolution> => {
      const started = Date.now()
      try {
        const result = await provider.fetch(identity, this.http)
        const resolution = buildVersionResolution(result.records, result.source)
        this.store(identity.id, resolution, result.records.length > 0 ? releaseTtlMs : emptyTtlMs, now)
        this.logger.info('Release metadata resolved', {
          identity: identity.id,
          source: provider.id,
          stable: resolution.latestStable?.version ?? null,
          lts: resolution.latestLts?.version ?? null,
          preview: resolution.latestPreview?.version ?? null,
          ms: Date.now() - started
        })
        return resolution
      } catch (error) {
        const message = errorMessage(error)
        this.logger.warn('Release metadata resolution failed', {
          identity: identity.id,
          source: provider.id,
          error: message
        })
        if (cached) {
          return { ...cached.resolution, stale: true, error: message }
        }
        return emptyResolution(provider.source(identity), message)
      } finally {
        this.inflight.delete(identity.id)
      }
    })()

    this.inflight.set(identity.id, task)
    return task
  }
}
