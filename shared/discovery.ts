import type { InstallationAdapterKind } from './identity'
import type { InstallationMethod, PackageCategory } from './registry'
import type { ReleaseSourceInfo } from './releases'

export type DiscoveryProviderStatus = 'ok' | 'error' | 'skipped'
export type DiscoveryCompatibility = 'installable' | 'metadata-only'
export type DiscoveryMatchTier = 'exact' | 'alias' | 'executable' | 'package' | 'related' | 'other'

export type DiscoveryFilter =
  | 'all'
  | 'verified'
  | 'languages'
  | 'frameworks'
  | 'compilers'
  | 'databases'
  | 'tools'

export interface DiscoverySourceRef {
  /** catalogue, winget, or an authoritative release provider. */
  id: string
  label: string
  kind: 'catalogue' | 'winget' | 'official' | 'package'
  url: string | null
}

/**
 * Authoritative version information. A channel is only populated when it was
 * resolved from the software's declared authoritative source. `stale` marks a
 * cached value that could not be refreshed; `source.kind` distinguishes an
 * upstream feed from a DevForge manifest that is not a latest-version claim.
 */
export interface DiscoveryVersionInfo {
  stable: string | null
  lts: string | null
  preview: string | null
  source: ReleaseSourceInfo
  retrievedAt: string
  stale: boolean
  error: string | null
}

export interface DiscoveryMatchInfo {
  tier: DiscoveryMatchTier
  score: number
  reason: string
}

/**
 * One canonical software result. Curated packages, WinGet manifests and
 * official release feeds are merged into this shape instead of appearing as
 * separate results for the same product.
 */
export interface UnifiedDiscoveryResult {
  /** `identity:<id>` for canonical results, otherwise the provider result id. */
  id: string
  identityId: string | null
  name: string
  publisher: string
  description: string
  category: PackageCategory
  homepage: string | null
  license: string | null
  icon: string
  tags: string[]
  match: DiscoveryMatchInfo
  sources: DiscoverySourceRef[]
  versions: DiscoveryVersionInfo
  /** Version defined by the DevForge package or WinGet manifest, if any. */
  manifestVersion: string | null
  /** Version an Install action would use, limited to verified procedures. */
  availableVersion: string | null
  installedVersion: string | null
  updateAvailable: boolean
  compatibility: DiscoveryCompatibility
  compatibilityNote: string | null
  packageId: string | null
  installationAdapter: InstallationAdapterKind | null
  installationMethod: InstallationMethod | null
  requiresAdmin: boolean
  verified: boolean
  candidateId: string | null
  metadataUrl: string | null
}

export interface DiscoveryProviderReport {
  id: string
  label: string
  status: DiscoveryProviderStatus
  message: string | null
  count: number
}

export interface DiscoveryIntent {
  identityId: string
  name: string
  score: number
}

export interface DiscoverySearchResponse {
  query: string
  results: UnifiedDiscoveryResult[]
  /** Lower-confidence matches shown separately from the main result list. */
  related: UnifiedDiscoveryResult[]
  providers: DiscoveryProviderReport[]
  cached: boolean
  searchedAt: string
  intent: DiscoveryIntent | null
}

export interface PrepareDiscoveryResponse {
  packageId: string
  created: boolean
}

export interface DiscoveryRefreshResult {
  checked: number
  updated: string[]
  failed: number
  skipped: boolean
}

const categoryHints: { category: PackageCategory; patterns: RegExp[] }[] = [
  {
    category: 'database',
    patterns: [/mysql|mariadb|postgres|mongodb|redis|sqlite|sqlserver|cassandra|couchdb|clickhouse|neo4j|database/i]
  },
  {
    category: 'compiler',
    patterns: [/llvm|clang|mingw|gcc|g\+\+|compiler|golangci|zig\b|msvc|buildtools?/i]
  },
  {
    category: 'framework',
    patterns: [/flutter|react|angular|vue|django|flask|spring|laravel|symfony|\.net\s*(sdk|framework)|electron|tauri/i]
  },
  {
    category: 'build-tool',
    patterns: [/\bcmake\b|\bninja\b|\bmaven\b|\bgradle\b|\bmake\b|meson|bazel|msbuild|build tool/i]
  },
  {
    category: 'language',
    patterns: [/\bpython\b|\bnode(js)?\b|\bjava\b|jdk|kotlin|\brust\b|\bgo(lang)?\b|\bphp\b|\bruby\b|\bdart\b|\bperl\b|\bscala\b|\belixir\b|\blua\b|swift|julia|haskell|\bc(pp|\+\+)?\b|typescript|deno|bun\b/i]
  },
  {
    category: 'runtime',
    patterns: [/runtime|redistributable|vc\+\+ redist|jre\b|\.net runtime/i]
  }
]

export function inferCategory(input: {
  name: string
  description?: string | null
  tags?: string[]
  id?: string
}): PackageCategory {
  const haystack = [input.name, input.description ?? '', input.id ?? '', ...(input.tags ?? [])].join(' ')
  for (const hint of categoryHints) {
    if (hint.patterns.some((pattern) => pattern.test(haystack))) return hint.category
  }
  return 'developer-tool'
}

export function filterDiscoveryResults(
  results: UnifiedDiscoveryResult[],
  filter: DiscoveryFilter
): UnifiedDiscoveryResult[] {
  switch (filter) {
    case 'all':
      return results
    case 'verified':
      return results.filter((result) => result.verified)
    case 'languages':
      return results.filter((result) => result.category === 'language')
    case 'frameworks':
      return results.filter((result) => result.category === 'framework')
    case 'compilers':
      return results.filter((result) => result.category === 'compiler')
    case 'databases':
      return results.filter((result) => result.category === 'database')
    case 'tools':
      return results.filter(
        (result) =>
          result.category === 'developer-tool' ||
          result.category === 'build-tool' ||
          result.category === 'runtime'
      )
    default:
      return results
  }
}
