import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PackageDefinition } from '@shared/registry'
import type { Logger } from '../logging/Logger'
import type { ReleaseCache } from '../releases/ReleaseResolver'

interface StoredFileV1 {
  version: 1
  packages: unknown[]
  refreshedAt: Record<string, string>
}

interface StoredFileV2 {
  version: 2
  packages: unknown[]
  refreshedAt: Record<string, string>
  releases: ReleaseCache
}

export interface DiscoveryStoreState {
  packages: unknown[]
  refreshedAt: Record<string, string>
  releases: ReleaseCache
}

const emptyState = (): DiscoveryStoreState => ({ packages: [], refreshedAt: {}, releases: {} })

/**
 * Persists packages prepared from discovery results and the authoritative
 * release cache. Version 1 files are upgraded transparently, so no user data
 * is discarded when the cache is added.
 */
export class DiscoveryStore {
  constructor(
    private readonly filePath: string,
    private readonly logger: Logger
  ) {}

  get path(): string {
    return this.filePath
  }

  load(): DiscoveryStoreState {
    if (!existsSync(this.filePath)) return emptyState()
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<
        StoredFileV1 | StoredFileV2
      >
      if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.packages)) {
        this.logger.warn('Discovery store has an unsupported format', { path: this.filePath })
        return emptyState()
      }
      const refreshedAt: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed.refreshedAt ?? {})) {
        if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
          refreshedAt[key] = value
        }
      }
      const releases =
        parsed.version === 2 && parsed.releases && typeof parsed.releases === 'object'
          ? (parsed.releases as ReleaseCache)
          : {}
      return { packages: parsed.packages, refreshedAt, releases }
    } catch (error) {
      this.logger.warn('Could not read the discovery store', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error)
      })
      return emptyState()
    }
  }

  save(
    packages: PackageDefinition[],
    refreshedAt: Record<string, string>,
    releases: ReleaseCache = {}
  ): void {
    const payload: StoredFileV2 = {
      version: 2,
      packages,
      refreshedAt,
      releases
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.tmp`
      writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(temporary, this.filePath)
    } catch (error) {
      this.logger.warn('Could not save the discovery store', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
