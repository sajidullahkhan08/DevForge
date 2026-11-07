import type {
  DiscoveryCompatibility,
  DiscoveryMatchTier,
  DiscoveryProviderReport,
  DiscoveryRefreshResult,
  DiscoverySearchResponse,
  DiscoverySourceRef,
  DiscoveryVersionInfo,
  PrepareDiscoveryResponse,
  UnifiedDiscoveryResult
} from '@shared/discovery'
import type { InstallationAdapterKind, IdentityMatch } from '@shared/identity'
import {
  matchIdentities,
  matchProviderIdentity,
  normalizeSoftwareText,
  resolveIntent,
  scoreTextMatch
} from '@shared/identity'
import { buildOfficialArchivePackage, isOfficialArchiveInstallable } from '@shared/official'
import type { InstallationMethod, PackageDefinition } from '@shared/registry'
import { validatePackageDefinition, validatePackageSemantics } from '@shared/registry'
import { isVersionNewer, type VersionResolution } from '@shared/releases'
import { compareVersions } from '@shared/version'
import {
  buildWinGetPackage,
  isHttpsUrl,
  managerIdForPackage,
  normalizeWinGetVersion
} from '@shared/winget'
import type { AppDatabase } from '../database/Database'
import { AppError } from '../errors'
import type { IdentityRegistry } from '../identities/IdentityRegistry'
import type { Logger } from '../logging/Logger'
import type { ProcessExecutor } from '../process/ProcessExecutor'
import type { RegistryService } from '../registry/RegistryService'
import type { ReleaseResolver } from '../releases/ReleaseResolver'
import { mapLimit } from './concurrency'
import type { DiscoveryStore } from './DiscoveryStore'
import { fetchWinGetShow, WinGetProvider } from './providers/WinGetProvider'
import type {
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryProviderOutcome,
  ProviderDiscoveryResult
} from './types'

const cacheTtlMs = 10 * 60 * 1000
const maxCacheEntries = 40
const maxIndexEntries = 500
const metadataRefreshIntervalMs = 12 * 60 * 60 * 1000
const maxResults = 12
const maxRelated = 8
const minIdentityScore = 55
const primaryIdentityScore = 80

const tierPriority: Record<DiscoveryMatchTier, number> = {
  exact: 0,
  executable: 1,
  package: 2,
  alias: 3,
  related: 4,
  other: 5
}

interface CacheEntry {
  response: DiscoverySearchResponse
  candidates: Map<string, PackageDefinition>
  expiresAt: number
}

interface IndexEntry {
  result: UnifiedDiscoveryResult
  candidate: PackageDefinition | null
  packageId: string | null
  expiresAt: number
}

interface PackageIndex {
  byIdentity: Map<string, PackageDefinition[]>
  identityByPackageId: Map<string, string>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultVersion(pkg: PackageDefinition): string | null {
  return (
    pkg.versions.find((version) => version.isDefault)?.version ??
    pkg.versions[0]?.version ??
    null
  )
}

function newestVersion(values: (string | null)[]): string | null {
  return values
    .filter((value): value is string => Boolean(value))
    .reduce<string | null>(
      (newest, value) => (!newest || compareVersions(value, newest) > 0 ? value : newest),
      null
    )
}

/**
 * Unified discovery pipeline. A query is resolved against the canonical
 * identity registry first, then enriched with validated WinGet manifests and
 * authoritative release feeds. Every software product is returned once, and an
 * install action is only exposed when a validated package procedure exists.
 */
export class DiscoveryService {
  private readonly providers: DiscoveryProvider[]
  private readonly cache = new Map<string, CacheEntry>()
  private readonly resultIndex = new Map<string, IndexEntry>()
  private refreshedAt: Record<string, string>

  constructor(
    private readonly registry: RegistryService,
    private readonly db: AppDatabase,
    private readonly logger: Logger,
    private readonly store: DiscoveryStore,
    private readonly identities: IdentityRegistry,
    private readonly releases: ReleaseResolver,
    private readonly executor: ProcessExecutor,
    refreshedAt: Record<string, string> = {},
    providers?: DiscoveryProvider[]
  ) {
    this.refreshedAt = { ...refreshedAt }
    this.providers = providers ?? [new WinGetProvider(executor, logger)]
    this.releases.setOnChange(() => this.saveState())
  }

  refreshedAtSnapshot(): Record<string, string> {
    return { ...this.refreshedAt }
  }

  /**
   * Imports a user-supplied package definition. The same schema and semantic
   * validation used for the built-in registry applies, and only proven
   * installation methods (WinGet manifests or checksum-verified official
   * archives) are accepted. The accepted package is persisted with the
   * discovery cache so it survives restarts.
   */
  importCustomPackage(input: unknown): { package: PackageDefinition; warnings: string[] } {
    const result = validatePackageDefinition(input, 'custom-package.json')
    if (!result.ok) {
      throw new AppError(
        'VALIDATION',
        result.issues[0]?.message ?? 'The package definition is not valid.',
        { details: result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n') }
      )
    }
    const pkg = result.value
    const semantics = validatePackageSemantics(pkg)
    if (semantics.length > 0) {
      throw new AppError('VALIDATION', semantics[0].message, {
        details: semantics.map((issue) => `${issue.path}: ${issue.message}`).join('\n')
      })
    }
    const existing = this.registry.getPackage(pkg.id)
    if (existing) {
      throw new AppError('VALIDATION', `A package with the id "${pkg.id}" already exists.`, {
        hint: 'Remove the existing package or choose a different id in the package definition.'
      })
    }
    try {
      this.registry.registerDynamicPackage(pkg)
    } catch (error) {
      throw new AppError('VALIDATION', errorMessage(error), {
        hint: 'Only WinGet packages with a package manager id, or official archives with a checksum for every version, can be imported.'
      })
    }
    this.registry.syncDatabase()
    this.saveState()
    this.cache.clear()
    this.resultIndex.clear()
    this.logger.info('Custom package imported', {
      packageId: pkg.id,
      method: pkg.installationMethod,
      versions: pkg.versions.length
    })
    const warnings: string[] = [
      'Remember to review the installation plan before installing an imported package.'
    ]
    if (pkg.installationMethod === 'winget') {
      warnings.push(
        'WinGet packages trust the upstream manifest. Confirm that the package manager id belongs to the intended publisher.'
      )
    }
    return { package: this.registry.getPackage(pkg.id) ?? pkg, warnings }
  }

  private providerContext(): DiscoveryProviderContext {
    return {
      knownPackages: this.registry.listPackages(),
      installations: this.db.listInstallations().filter((record) => record.status !== 'removed')
    }
  }

  private async runProvider(
    provider: DiscoveryProvider,
    query: string,
    context: DiscoveryProviderContext
  ): Promise<DiscoveryProviderOutcome> {
    const timeoutMs = provider.id === 'winget' ? 45000 : 20000
    let timer: NodeJS.Timeout | null = null
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(
                'PROCESS_TIMEOUT',
                `${provider.label} discovery did not finish within ${Math.round(timeoutMs / 1000)} seconds.`
              )
            ),
          timeoutMs
        )
      })
      return await Promise.race([provider.search(query, context), timeout])
    } catch (error) {
      this.logger.warn('Discovery provider failed', {
        provider: provider.id,
        error: errorMessage(error)
      })
      return {
        results: [],
        candidates: new Map(),
        report: {
          id: provider.id,
          label: provider.label,
          status: 'error',
          message: `${provider.label} could not complete this search. ${errorMessage(error)}`,
          count: 0
        }
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key)
    }
    while (this.cache.size >= maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    for (const [key, entry] of this.resultIndex) {
      if (entry.expiresAt <= now) this.resultIndex.delete(key)
    }
    while (this.resultIndex.size > maxIndexEntries) {
      const oldest = this.resultIndex.keys().next().value
      if (oldest === undefined) break
      this.resultIndex.delete(oldest)
    }
  }

  /**
   * Maps every known package onto its canonical identity. Curated packages
   * declare their ids explicitly; dynamic packages are matched through their
   * package or WinGet identifier and, as a last resort, an exact name plus
   * publisher match.
   */
  private buildPackageIndex(): PackageIndex {
    const byIdentity = new Map<string, PackageDefinition[]>()
    const identityByPackageId = new Map<string, string>()

    for (const pkg of this.registry.listPackages()) {
      const identity = this.identities.forPackage(pkg)
      if (!identity) continue
      const list = byIdentity.get(identity.id) ?? []
      list.push(pkg)
      byIdentity.set(identity.id, list)
      identityByPackageId.set(pkg.id, identity.id)
    }

    return { byIdentity, identityByPackageId }
  }

  private installedVersions(): Map<string, string> {
    const map = new Map<string, string>()
    for (const record of this.db.listInstallations()) {
      if (record.status !== 'installed') continue
      const version = record.detectedVersion ?? record.version
      if (!version) continue
      if (!map.has(record.packageId) || record.isActive) map.set(record.packageId, version)
    }
    return map
  }

  private preferredPackages(packages: PackageDefinition[]): PackageDefinition[] {
    const rank = (pkg: PackageDefinition): number => {
      if (pkg.origin === 'winget') return 2
      if (pkg.origin === 'official') return 1
      return 0
    }
    return [...packages].sort((left, right) => rank(left) - rank(right))
  }

  private manifestVersion(packages: PackageDefinition[]): string | null {
    for (const pkg of this.preferredPackages(packages)) {
      const version = defaultVersion(pkg)
      if (version) return version
    }
    return null
  }

  private manifestResolution(packages: PackageDefinition[], error: string | null): VersionResolution {
    const version = this.manifestVersion(packages)
    return {
      latestStable: null,
      latestLts: null,
      latestPreview: null,
      others: [],
      source: {
        id: 'devforge-manifest',
        label: 'DevForge package manifest',
        url: null,
        kind: version ? 'package' : 'catalogue'
      },
      retrievedAt: new Date().toISOString(),
      stale: false,
      error
    }
  }

  private async resolveVersions(
    matches: IdentityMatch[],
    packageIndex: PackageIndex
  ): Promise<Map<string, VersionResolution>> {
    const outcomes = await mapLimit(matches, 4, async (match) => {
      const packages = packageIndex.byIdentity.get(match.identity.id) ?? []
      const catalogueVersion = this.manifestVersion(packages)
      try {
        const resolution = await this.releases.resolve(match.identity, catalogueVersion)
        return [match.identity.id, resolution] as const
      } catch (error) {
        return [
          match.identity.id,
          this.manifestResolution(packages, errorMessage(error))
        ] as const
      }
    })
    return new Map(outcomes)
  }

  private buildIdentityResult(
    match: IdentityMatch,
    packages: PackageDefinition[],
    resolution: VersionResolution,
    installed: Map<string, string>,
    now: number
  ): { result: UnifiedDiscoveryResult; candidate: PackageDefinition | null } {
    const identity = match.identity
    const preferred = this.preferredPackages(packages)
    const curated = preferred.filter(
      (pkg) => pkg.origin !== 'winget' && pkg.origin !== 'official'
    )
    const official = preferred.filter((pkg) => pkg.origin === 'official')
    const wingetPackages = preferred.filter((pkg) => pkg.origin === 'winget')

    let candidate: PackageDefinition | null = null
    if (
      curated.length === 0 &&
      identity.installationAdapters.includes('official-archive') &&
      isOfficialArchiveInstallable(identity, resolution)
    ) {
      candidate = buildOfficialArchivePackage(identity, resolution)
    }

    let packageId: string | null = null
    let installationAdapter: InstallationAdapterKind | null = null
    let installationMethod: InstallationMethod | null = null
    let requiresAdmin = false
    let compatibility: DiscoveryCompatibility = 'metadata-only'
    let note: string | null = null
    let chosen: PackageDefinition | null = null

    if (curated.length > 0) {
      chosen = curated[0]
      packageId = chosen.id
      installationAdapter = 'catalogue'
      installationMethod = chosen.installationMethod
      requiresAdmin = chosen.requiresAdmin
      compatibility = 'installable'
      note = `Uses the DevForge catalog package "${chosen.name}".`
    } else if (candidate) {
      installationAdapter = 'official-archive'
      installationMethod = 'archive'
      compatibility = 'installable'
      note = `Installs the official ${identity.name} SDK archive with a verified SHA-256 checksum.`
      if (official.length > 0) {
        chosen = official[0]
        packageId = chosen.id
        note = 'Uses the existing DevForge official SDK package. Its version list is refreshed from the official release feed.'
      }
    } else if (official.length > 0) {
      chosen = official[0]
      packageId = chosen.id
      installationAdapter = 'official-archive'
      installationMethod = chosen.installationMethod
      compatibility = 'installable'
      note =
        'Uses the existing DevForge official SDK package. Upstream versions could not be resolved right now.'
    } else if (wingetPackages.length > 0) {
      chosen = wingetPackages[0]
      packageId = chosen.id
      installationAdapter = 'winget'
      installationMethod = 'winget'
      compatibility = 'installable'
      note = 'Uses the validated WinGet manifest already present in the DevForge catalog.'
    } else {
      note = identity.installationAdapters.includes('winget')
        ? 'DevForge can install this product through WinGet once a validated manifest is found for this search.'
        : 'No validated installation procedure is available for this product yet.'
    }

    let installedVersion: string | null = null
    for (const pkg of preferred) {
      const version = installed.get(pkg.id)
      if (version) {
        installedVersion = version
        break
      }
    }

    const versions: DiscoveryVersionInfo = {
      stable: resolution.latestStable?.version ?? null,
      lts: resolution.latestLts?.version ?? null,
      preview: resolution.latestPreview?.version ?? null,
      source: resolution.source,
      retrievedAt: resolution.retrievedAt,
      stale: resolution.stale,
      error: resolution.error
    }

    const manifestVersion = this.manifestVersion(packages)
    const availableVersion =
      (chosen ? defaultVersion(chosen) : null) ??
      (candidate ? defaultVersion(candidate) : null)

    const notes: string[] = []
    if (note) notes.push(note)
    if (resolution.stale) {
      notes.push('Cached version information is shown because the release source could not be refreshed.')
    }
    if (
      versions.stable &&
      manifestVersion &&
      curated.length > 0 &&
      isVersionNewer(versions.stable, manifestVersion)
    ) {
      notes.push(
        `The DevForge catalog currently pins ${manifestVersion}; ${versions.stable} is available upstream. Install actions use the vetted DevForge definition.`
      )
    }
    if (
      resolution.error &&
      !versions.stable &&
      !versions.lts &&
      !versions.preview &&
      resolution.source.kind === 'official'
    ) {
      notes.push(`Latest versions could not be resolved: ${resolution.error}`)
    }

    const sources: DiscoverySourceRef[] = []
    if (packages.length > 0) {
      sources.push({
        id: 'devforge-catalogue',
        label: 'DevForge catalog',
        kind: 'catalogue',
        url: null
      })
    }
    if (resolution.source.kind === 'official') {
      sources.push({
        id: resolution.source.id,
        label: resolution.source.label,
        kind: 'official',
        url: resolution.source.url
      })
    } else if (candidate || official.length > 0) {
      sources.push({
        id: 'official-archive',
        label: 'Official release archive',
        kind: 'official',
        url: identity.homepage
      })
    }
    if (wingetPackages.length > 0) {
      sources.push({ id: 'winget', label: 'WinGet', kind: 'winget', url: null })
    }

    const tags = [...new Set([...identity.tags, ...preferred.flatMap((pkg) => pkg.tags)])].slice(0, 8)
    const verified = compatibility === 'installable'
    const resultId = `identity:${identity.id}`
    const installableVersion = availableVersion ?? manifestVersion

    const result: UnifiedDiscoveryResult = {
      id: resultId,
      identityId: identity.id,
      name: identity.name,
      publisher: identity.publisher,
      description: identity.description,
      category: identity.category,
      homepage: identity.homepage,
      license: chosen?.license ?? candidate?.license ?? null,
      icon: identity.icon,
      tags,
      match: {
        tier: match.tier,
        score: match.score,
        reason: match.reason
      },
      sources,
      versions,
      manifestVersion,
      availableVersion,
      installedVersion,
      updateAvailable: isVersionNewer(installableVersion, installedVersion),
      compatibility,
      compatibilityNote: notes.length > 0 ? notes.join(' ') : null,
      packageId,
      installationAdapter,
      installationMethod,
      requiresAdmin,
      verified,
      candidateId: candidate ? resultId : null,
      metadataUrl: identity.homepage
    }

    return { result, candidate }
  }

  private refreshUpdateState(result: UnifiedDiscoveryResult): void {
    const latest = newestVersion([result.availableVersion, result.manifestVersion])
    result.updateAvailable = isVersionNewer(latest, result.installedVersion)
  }

  private addSource(result: UnifiedDiscoveryResult, source: DiscoverySourceRef): void {
    if (!result.sources.some((entry) => entry.id === source.id)) result.sources.push(source)
  }

  private mergeWinGetRow(result: UnifiedDiscoveryResult, row: ProviderDiscoveryResult): void {
    this.addSource(result, {
      id: 'winget',
      label: 'WinGet',
      kind: 'winget',
      url: row.metadataUrl
    })
    if (!result.manifestVersion && row.version) result.manifestVersion = row.version
    if (!result.installedVersion && row.installedVersion) result.installedVersion = row.installedVersion
    if (!result.license && row.license) result.license = row.license
    if (!result.metadataUrl && row.metadataUrl) result.metadataUrl = row.metadataUrl
    result.tags = [...new Set([...result.tags, ...row.tags])].slice(0, 8)
    this.refreshUpdateState(result)
  }

  private applyWinGetInstallation(
    result: UnifiedDiscoveryResult,
    row: ProviderDiscoveryResult,
    hasCandidate: boolean
  ): void {
    if (result.compatibility === 'installable') return
    if (row.packageId) {
      result.packageId = row.packageId
      result.installationAdapter = 'winget'
      result.installationMethod = 'winget'
      result.verified = true
      result.compatibility = 'installable'
      result.availableVersion = row.version ?? result.availableVersion
      result.compatibilityNote =
        'Uses a validated WinGet package already present in the DevForge catalog.'
    } else if (hasCandidate && row.compatibility === 'installable') {
      result.installationAdapter = 'winget'
      result.installationMethod = 'winget'
      result.verified = true
      result.compatibility = 'installable'
      result.availableVersion = row.version ?? result.availableVersion
      result.compatibilityNote =
        'Installs from a validated WinGet manifest after DevForge adds it to the catalog.'
    } else {
      if (row.compatibilityNote) result.compatibilityNote = row.compatibilityNote
      if (!result.metadataUrl && row.metadataUrl) result.metadataUrl = row.metadataUrl
    }
    this.refreshUpdateState(result)
  }

  private buildStandaloneResult(
    row: ProviderDiscoveryResult,
    candidate: PackageDefinition | null,
    query: string,
    now: number
  ): UnifiedDiscoveryResult {
    const managerTail = row.managerId?.split('.').pop() ?? ''
    const score = Math.max(
      scoreTextMatch(row.name, query),
      managerTail ? scoreTextMatch(managerTail, query) : 0
    )
    const matchScore = score > 0 ? score : 40
    const tier: DiscoveryMatchTier =
      matchScore >= 98 ? 'exact' : matchScore >= 80 ? 'alias' : matchScore > 40 ? 'related' : 'other'
    const reason =
      matchScore >= 98
        ? 'Exact WinGet package name match'
        : matchScore >= 80
          ? 'WinGet package name match'
          : 'Related WinGet package'

    const installable =
      row.compatibility === 'installable' && (Boolean(row.packageId) || candidate !== null)

    return {
      id: row.id,
      identityId: null,
      name: row.name,
      publisher: row.publisher,
      description: row.description,
      category: row.category,
      homepage: row.homepage,
      license: row.license,
      icon: row.icon,
      tags: row.tags,
      match: { tier, score: matchScore, reason },
      sources: [{ id: 'winget', label: 'WinGet', kind: 'winget', url: row.metadataUrl }],
      versions: {
        stable: null,
        lts: null,
        preview: null,
        source: {
          id: 'winget-manifest',
          label: 'WinGet manifest',
          url: row.metadataUrl,
          kind: 'package'
        },
        retrievedAt: new Date(now).toISOString(),
        stale: false,
        error: null
      },
      manifestVersion: row.version,
      availableVersion: installable ? row.version : null,
      installedVersion: row.installedVersion,
      updateAvailable: row.updateAvailable,
      compatibility: installable ? 'installable' : 'metadata-only',
      compatibilityNote: row.compatibilityNote,
      packageId: row.packageId,
      installationAdapter: installable ? 'winget' : null,
      installationMethod: installable ? 'winget' : null,
      requiresAdmin: false,
      verified: installable,
      candidateId: candidate ? row.id : null,
      metadataUrl: row.metadataUrl ?? row.homepage
    }
  }

  private packageMatchScore(pkg: PackageDefinition, query: string): number {
    const managerTail = managerIdForPackage(pkg)?.split('.').pop() ?? ''
    const values = [pkg.name, pkg.id, ...pkg.tags, ...pkg.expectedExecutables, managerTail]
    return values.reduce((highest, value) => Math.max(highest, scoreTextMatch(value, query)), 0)
  }

  private buildCatalogueResult(
    pkg: PackageDefinition,
    score: number,
    installed: Map<string, string>,
    now: number
  ): UnifiedDiscoveryResult {
    const manifestVersion = defaultVersion(pkg)
    const installedVersion = installed.get(pkg.id) ?? null
    const adapter: InstallationAdapterKind = pkg.origin === 'winget' ? 'winget' : 'catalogue'
    return {
      id: `package:${pkg.id}`,
      identityId: null,
      name: pkg.name,
      publisher: pkg.publisher,
      description: pkg.description,
      category: pkg.category,
      homepage: pkg.homepage,
      license: pkg.license,
      icon: pkg.icon,
      tags: pkg.tags,
      match: {
        tier: score >= 98 ? 'exact' : score >= 80 ? 'alias' : 'related',
        score,
        reason: 'Matches a package already in the DevForge catalog'
      },
      sources: [
        { id: 'devforge-catalogue', label: 'DevForge catalog', kind: 'catalogue', url: null }
      ],
      versions: {
        stable: null,
        lts: null,
        preview: null,
        source: {
          id: 'devforge-catalogue',
          label: 'DevForge catalog definition',
          url: null,
          kind: 'catalogue'
        },
        retrievedAt: new Date(now).toISOString(),
        stale: false,
        error: null
      },
      manifestVersion,
      availableVersion: manifestVersion,
      installedVersion,
      updateAvailable: isVersionNewer(manifestVersion, installedVersion),
      compatibility: 'installable',
      compatibilityNote: `Uses the DevForge catalog package "${pkg.name}".`,
      packageId: pkg.id,
      installationAdapter: adapter,
      installationMethod: pkg.installationMethod,
      requiresAdmin: pkg.requiresAdmin,
      verified: true,
      candidateId: null,
      metadataUrl: pkg.homepage
    }
  }

  private dedupe(list: UnifiedDiscoveryResult[]): UnifiedDiscoveryResult[] {
    const seen = new Map<string, UnifiedDiscoveryResult>()
    for (const result of list) {
      const key = result.identityId
        ? `identity:${result.identityId}`
        : `name:${normalizeSoftwareText(result.name)}`
      const existing = seen.get(key)
      if (!existing) {
        seen.set(key, result)
        continue
      }
      if (
        result.match.score > existing.match.score ||
        (result.match.score === existing.match.score &&
          result.compatibility === 'installable' &&
          existing.compatibility !== 'installable')
      ) {
        for (const source of existing.sources) this.addSource(result, source)
        seen.set(key, result)
      } else {
        for (const source of result.sources) this.addSource(existing, source)
      }
    }
    return [...seen.values()]
  }

  private sortResults(list: UnifiedDiscoveryResult[]): UnifiedDiscoveryResult[] {
    return [...list].sort(
      (left, right) =>
        right.match.score - left.match.score ||
        tierPriority[left.match.tier] - tierPriority[right.match.tier] ||
        Number(right.verified) - Number(left.verified) ||
        left.name.localeCompare(right.name)
    )
  }

  private rememberCandidates(
    results: UnifiedDiscoveryResult[],
    candidates: Map<string, PackageDefinition>,
    expiresAt: number
  ): void {
    for (const result of results) {
      const candidate = candidates.get(result.id) ?? null
      this.resultIndex.set(result.id, {
        result,
        candidate,
        packageId: result.packageId,
        expiresAt
      })
    }
  }

  async search(rawQuery: string): Promise<DiscoverySearchResponse> {
    const query = rawQuery.trim().replace(/\s+/g, ' ')
    if (query.length < 2 || query.length > 80) {
      throw new AppError('VALIDATION', 'Enter a search term between 2 and 80 characters.')
    }

    const now = Date.now()
    const key = query.toLowerCase()
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > now) {
      return { ...cached.response, cached: true }
    }

    const identities = this.identities.list()
    const matches = matchIdentities(identities, query, minIdentityScore)
    const intentMatch = resolveIntent(identities, query)
    const packageIndex = this.buildPackageIndex()
    const primaryMatches = matches
      .filter((match) => match.score >= primaryIdentityScore)
      .slice(0, maxResults)
    const relatedMatches = matches
      .filter((match) => match.score < primaryIdentityScore)
      .slice(0, maxRelated)
    const displayedMatches = [...primaryMatches, ...relatedMatches]
    const installed = this.installedVersions()

    const context = this.providerContext()
    const [outcomes, resolutions] = await Promise.all([
      Promise.all(this.providers.map((provider) => this.runProvider(provider, query, context))),
      this.resolveVersions(displayedMatches, packageIndex)
    ])

    const results: UnifiedDiscoveryResult[] = []
    const related: UnifiedDiscoveryResult[] = []
    const standalone: UnifiedDiscoveryResult[] = []
    const reports: DiscoveryProviderReport[] = []
    const candidateMap = new Map<string, PackageDefinition>()
    const resultsByIdentity = new Map<string, UnifiedDiscoveryResult>()
    const resultsByPackageId = new Map<string, UnifiedDiscoveryResult>()

    const addIdentityResult = (match: IdentityMatch, target: UnifiedDiscoveryResult[]): void => {
      const packages = packageIndex.byIdentity.get(match.identity.id) ?? []
      const resolution =
        resolutions.get(match.identity.id) ?? this.manifestResolution(packages, null)
      const built = this.buildIdentityResult(match, packages, resolution, installed, now)
      target.push(built.result)
      resultsByIdentity.set(match.identity.id, built.result)
      if (built.result.packageId) {
        resultsByPackageId.set(built.result.packageId, built.result)
      }
      if (built.candidate) candidateMap.set(built.result.id, built.candidate)
    }

    primaryMatches.forEach((match) => addIdentityResult(match, results))
    relatedMatches.forEach((match) => addIdentityResult(match, related))

    for (const outcome of outcomes) {
      reports.push(outcome.report)
      for (const row of outcome.results) {
        const providerCandidate = outcome.candidates.get(row.id) ?? null
        const providerMatch = matchProviderIdentity(identities, {
          name: row.name,
          publisher: row.publisher,
          wingetId: row.managerId,
          packageId: row.packageId
        })
        const canonical = providerMatch
          ? resultsByIdentity.get(providerMatch.identity.id) ?? null
          : null

        if (canonical) {
          const wasInstallable = canonical.compatibility === 'installable'
          this.mergeWinGetRow(canonical, row)
          if (providerCandidate && !wasInstallable) {
            candidateMap.set(canonical.id, providerCandidate)
            canonical.candidateId = canonical.id
          }
          this.applyWinGetInstallation(canonical, row, Boolean(providerCandidate))
          if (canonical.packageId && !resultsByPackageId.has(canonical.packageId)) {
            resultsByPackageId.set(canonical.packageId, canonical)
          }
          continue
        }

        const packageCanonical = row.packageId
          ? resultsByPackageId.get(row.packageId) ?? null
          : null
        if (packageCanonical) {
          const wasInstallable = packageCanonical.compatibility === 'installable'
          this.mergeWinGetRow(packageCanonical, row)
          if (providerCandidate && !wasInstallable) {
            candidateMap.set(packageCanonical.id, providerCandidate)
            packageCanonical.candidateId = packageCanonical.id
          }
          this.applyWinGetInstallation(packageCanonical, row, Boolean(providerCandidate))
          continue
        }

        const built = this.buildStandaloneResult(row, providerCandidate, query, now)
        standalone.push(built)
        if (providerCandidate) candidateMap.set(built.id, providerCandidate)
        if (built.packageId) resultsByPackageId.set(built.packageId, built)
      }
    }

    const surfacedPackageIds = new Set(resultsByPackageId.keys())
    const surfacedManagerIds = new Set(
      outcomes.flatMap((outcome) =>
        outcome.results
          .map((row) => row.managerId?.toLowerCase() ?? '')
          .filter(Boolean)
      )
    )
    for (const pkg of this.registry.listDynamicPackages()) {
      if (packageIndex.identityByPackageId.has(pkg.id)) continue
      if (surfacedPackageIds.has(pkg.id)) continue
      const managerId = managerIdForPackage(pkg)
      if (managerId && surfacedManagerIds.has(managerId.toLowerCase())) continue
      const score = this.packageMatchScore(pkg, query)
      if (score < minIdentityScore) continue
      const built = this.buildCatalogueResult(pkg, score, installed, now)
      standalone.push(built)
      resultsByPackageId.set(pkg.id, built)
    }

    if (results.length === 0) {
      const installableStandalone = standalone.filter(
        (result) => result.compatibility === 'installable'
      )
      if (installableStandalone.length > 0) {
        results.push(...installableStandalone)
      } else {
        results.push(...standalone.slice(0, maxResults))
        standalone.length = 0
      }
    }
    for (const result of standalone) {
      if (!results.includes(result) && !related.includes(result)) related.push(result)
    }

    const primary = this.sortResults(this.dedupe(results)).slice(0, maxResults)
    const relatedResults = this.sortResults(
      this.dedupe(related.filter((result) => !primary.some((entry) => entry.id === result.id)))
    ).slice(0, maxRelated)

    const response: DiscoverySearchResponse = {
      query,
      results: primary,
      related: relatedResults,
      providers: reports,
      cached: false,
      searchedAt: new Date(now).toISOString(),
      intent: intentMatch
        ? {
            identityId: intentMatch.identity.id,
            name: intentMatch.identity.name,
            score: intentMatch.score
          }
        : null
    }

    this.prune(now)
    const expiresAt = now + cacheTtlMs
    this.cache.set(key, { response, candidates: candidateMap, expiresAt })
    this.rememberCandidates(primary, candidateMap, expiresAt)
    this.rememberCandidates(relatedResults, candidateMap, expiresAt)

    this.logger.info('Discovery search complete', {
      query,
      results: primary.length,
      related: relatedResults.length,
      installable: primary.filter((result) => result.compatibility === 'installable').length,
      intent: intentMatch?.identity.id ?? null,
      providers: reports.map((report) => `${report.id}:${report.status}`)
    })

    return response
  }

  private saveState(): void {
    this.store.save(
      this.registry.listDynamicPackages(),
      this.refreshedAt,
      this.releases.snapshot()
    )
  }

  private updateCachedPackageId(resultId: string, packageId: string): void {
    for (const cached of this.cache.values()) {
      for (const result of [...cached.response.results, ...cached.response.related]) {
        if (result.id === resultId) {
          result.packageId = packageId
          result.candidateId = null
          result.verified = true
          result.compatibility = 'installable'
        }
      }
    }
  }

  async prepare(resultId: string): Promise<PrepareDiscoveryResponse> {
    const entry = this.resultIndex.get(resultId)
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new AppError('NOT_FOUND', 'This discovery result has expired.', {
        hint: 'Run the search again, then review the result before adding it.'
      })
    }

    const resolvedId = entry.packageId ?? entry.result.packageId
    if (!entry.candidate) {
      if (resolvedId) return { packageId: resolvedId, created: false }
      throw new AppError(
        'VALIDATION',
        'This result is metadata-only and cannot be installed by DevForge.',
        {
          hint:
            entry.result.compatibilityNote ??
            'Open the official source to review its installation instructions.'
        }
      )
    }

    const existing = this.registry.getPackage(entry.candidate.id)
    if (existing && existing.origin !== 'official') {
      entry.packageId = existing.id
      entry.result.packageId = existing.id
      this.updateCachedPackageId(resultId, existing.id)
      return { packageId: existing.id, created: false }
    }

    try {
      this.registry.registerDynamicPackage(entry.candidate)
    } catch (error) {
      throw new AppError('VALIDATION', 'The discovered package could not be added to the catalogue.', {
        details: errorMessage(error)
      })
    }

    this.registry.syncDatabase()
    this.saveState()

    entry.packageId = entry.candidate.id
    entry.result.packageId = entry.candidate.id
    this.updateCachedPackageId(resultId, entry.candidate.id)

    this.logger.info('Discovered package prepared', {
      packageId: entry.candidate.id,
      identityId: entry.result.identityId,
      wingetId: entry.candidate.packageManagerId,
      origin: entry.candidate.origin
    })
    return { packageId: entry.candidate.id, created: true }
  }

  private isStale(lastRefresh: string | undefined, now: number): boolean {
    return !lastRefresh || now - Date.parse(lastRefresh) > metadataRefreshIntervalMs
  }

  private async refreshWinGetPackages(
    packages: PackageDefinition[],
    outcome: { updated: string[]; failed: number }
  ): Promise<void> {
    if (packages.length === 0) return
    await mapLimit(packages, 2, async (pkg) => {
      const managerId = managerIdForPackage(pkg)
      if (!managerId) {
        outcome.failed += 1
        return
      }
      const { info } = await fetchWinGetShow(this.executor, managerId, 20000)
      this.refreshedAt[managerId.toLowerCase()] = new Date().toISOString()
      if (!info) {
        outcome.failed += 1
        return
      }

      const version = normalizeWinGetVersion(info.version)
      if (!version) {
        outcome.failed += 1
        return
      }

      const publisherHomepage = isHttpsUrl(info.publisherUrl) ? info.publisherUrl : null
      const homepage = isHttpsUrl(info.homepage)
        ? info.homepage
        : publisherHomepage ?? pkg.homepage

      const next = buildWinGetPackage({
        wingetId: managerId,
        name: info.name ?? pkg.name,
        version,
        publisher: info.publisher ?? pkg.publisher,
        description: info.description ?? pkg.description,
        homepage,
        license: info.license ?? pkg.license,
        tags: info.tags.length > 0 ? info.tags : pkg.tags,
        category: pkg.category,
        icon: pkg.icon,
        packageId: pkg.id
      })

      if (JSON.stringify(next) === JSON.stringify(pkg)) return
      try {
        this.registry.registerDynamicPackage(next)
        outcome.updated.push(pkg.id)
      } catch (error) {
        this.logger.warn('Could not update discovered package metadata', {
          packageId: pkg.id,
          error: errorMessage(error)
        })
        outcome.failed += 1
      }
    })
  }

  private async refreshOfficialPackages(
    packages: PackageDefinition[],
    outcome: { updated: string[]; failed: number }
  ): Promise<void> {
    if (packages.length === 0) return
    await mapLimit(packages, 2, async (pkg) => {
      const identity = this.identities.forPackage(pkg)
      if (!identity || !identity.officialArchive) {
        outcome.failed += 1
        return
      }
      const currentVersion = defaultVersion(pkg)
      const resolution = await this.releases.resolve(identity, currentVersion)
      const next = buildOfficialArchivePackage(identity, resolution)
      this.refreshedAt[`official:${identity.id}`] = new Date().toISOString()
      if (!next) {
        outcome.failed += 1
        return
      }
      if (JSON.stringify(next) === JSON.stringify(pkg)) return
      try {
        this.registry.registerDynamicPackage(next)
        outcome.updated.push(pkg.id)
      } catch (error) {
        this.logger.warn('Could not update official package metadata', {
          packageId: pkg.id,
          error: errorMessage(error)
        })
        outcome.failed += 1
      }
    })
  }

  async refreshManagedPackages(force = false): Promise<DiscoveryRefreshResult> {
    const packages = this.registry.listDynamicPackages()
    if (packages.length === 0) {
      return { checked: 0, updated: [], failed: 0, skipped: false }
    }

    const now = Date.now()
    const wingetPackages = packages.filter((pkg) => pkg.origin === 'winget')
    const officialPackages = packages.filter((pkg) => pkg.origin === 'official')

    const staleWinGet = wingetPackages.filter((pkg) => {
      if (force) return true
      const managerId = managerIdForPackage(pkg)
      if (!managerId) return false
      return this.isStale(this.refreshedAt[managerId.toLowerCase()], now)
    })
    const staleOfficial = officialPackages.filter((pkg) => {
      if (force) return true
      return this.isStale(this.refreshedAt[`official:${pkg.id}`], now)
    })

    if (staleWinGet.length === 0 && staleOfficial.length === 0) {
      return { checked: 0, updated: [], failed: 0, skipped: false }
    }

    const outcome = { updated: [] as string[], failed: 0 }
    let skipped = false

    if (staleWinGet.length > 0) {
      try {
        const result = await this.executor.run('winget', ['--version'], {
          timeoutMs: 10000,
          maxOutputBytes: 64 * 1024
        })
        if (result.exitCode !== 0) throw new Error('WinGet is not available.')
      } catch (error) {
        this.logger.warn('Skipped discovered WinGet package metadata refresh', {
          error: errorMessage(error)
        })
        skipped = true
      }
    }

    this.logger.info('Refreshing discovered package metadata', {
      winget: skipped ? 0 : staleWinGet.length,
      official: staleOfficial.length
    })

    if (!skipped) await this.refreshWinGetPackages(staleWinGet, outcome)
    await this.refreshOfficialPackages(staleOfficial, outcome)

    if (outcome.updated.length > 0) {
      this.registry.syncDatabase()
      this.cache.clear()
      this.resultIndex.clear()
    }
    this.saveState()

    const checked = (skipped ? 0 : staleWinGet.length) + staleOfficial.length
    this.logger.info('Discovered package metadata refresh complete', {
      checked,
      updated: outcome.updated.length,
      failed: outcome.failed,
      skipped
    })
    return {
      checked,
      updated: outcome.updated,
      failed: outcome.failed,
      skipped
    }
  }
}
