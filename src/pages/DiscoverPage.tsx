import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  Clock,
  Compass,
  Download,
  ExternalLink,
  FileUp,
  Globe2,
  Info,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react'
import type { DiscoveryFilter, UnifiedDiscoveryResult } from '@shared/discovery'
import { filterDiscoveryResults } from '@shared/discovery'
import type { CatalogueItem, InstallRequest, PackageCategory, PackageDefinition } from '@shared/types'
import { api } from '@/lib/api'
import { categoryLabels, formatRelative, methodLabels } from '@/lib/format'
import { notifyError, notifyInfo, notifySuccess } from '@/lib/feedback'
import { queryKeys, useCatalogue, useDiscoverySearch, useProfiles } from '@/hooks/useData'
import { PageHeader } from '@/components/common/PageHeader'
import { SoftwareIconTile } from '@/components/common/SoftwareIconTile'
import { StatusBadge } from '@/components/common/StatusBadge'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { PlanDialog } from '@/components/common/PlanDialog'
import { RecipeDialog } from '@/components/common/RecipeDialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

type StatusFilter = 'all' | 'available' | 'installed' | 'updates'

const discoveryFilters: { value: DiscoveryFilter; label: string }[] = [
  { value: 'all', label: 'All software' },
  { value: 'verified', label: 'Verified installable' },
  { value: 'languages', label: 'Languages' },
  { value: 'frameworks', label: 'Frameworks' },
  { value: 'compilers', label: 'Compilers' },
  { value: 'databases', label: 'Databases' },
  { value: 'tools', label: 'Developer tools' }
]

const suggestions = ['Flutter', 'PHP', 'Ruby', 'LLVM', 'Dart']

function categoryMatchesFilter(category: PackageCategory, filter: DiscoveryFilter): boolean {
  switch (filter) {
    case 'all':
    case 'verified':
      return true
    case 'languages':
      return category === 'language'
    case 'frameworks':
      return category === 'framework'
    case 'compilers':
      return category === 'compiler'
    case 'databases':
      return category === 'database'
    case 'tools':
      return category === 'developer-tool' || category === 'build-tool' || category === 'runtime'
    default:
      return true
  }
}

function catalogueMatchesQuery(item: CatalogueItem, query: string): boolean {
  const target = query.toLowerCase()
  const pkg = item.package
  return (
    pkg.name.toLowerCase().includes(target) ||
    pkg.id.includes(target) ||
    pkg.description.toLowerCase().includes(target) ||
    pkg.publisher.toLowerCase().includes(target) ||
    pkg.tags.some((tag) => tag.toLowerCase().includes(target))
  )
}

function unifiedMatchesStatus(result: UnifiedDiscoveryResult, status: StatusFilter): boolean {
  if (status === 'installed') return Boolean(result.installedVersion)
  if (status === 'available') return !result.installedVersion
  if (status === 'updates') return result.updateAvailable
  return true
}

function catalogueMatchesStatus(item: CatalogueItem, status: StatusFilter): boolean {
  if (status === 'installed') return Boolean(item.installed)
  if (status === 'available') return !item.installed
  if (status === 'updates') return item.updateAvailable
  return true
}

export default function DiscoverPage(): ReactNode {
  const queryClient = useQueryClient()
  const catalogueQuery = useCatalogue()
  const profilesQuery = useProfiles()
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<DiscoveryFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [planRequests, setPlanRequests] = useState<InstallRequest[]>([])
  const [recipePackage, setRecipePackage] = useState<PackageDefinition | null>(null)
  const [preparingId, setPreparingId] = useState<string | null>(null)
  const [refreshingMetadata, setRefreshingMetadata] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const items = catalogueQuery.data ?? []
  const profiles = profilesQuery.data ?? []
  const search = useDiscoverySearch(query)

  const importMutation = useMutation({
    mutationFn: () => api.registry.importPackage(),
    onSuccess: (result) => {
      if (result.canceled) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      notifySuccess(
        'Package imported',
        `${result.package?.name ?? 'The package'} was added to the local catalogue. Review the installation plan before installing it.`
      )
    },
    onError: notifyError
  })

  useEffect(() => {
    const trimmed = input.trim()
    if (trimmed.length < 2) {
      setQuery('')
      return
    }
    const timer = window.setTimeout(() => setQuery(trimmed), 320)
    return () => window.clearTimeout(timer)
  }, [input])

  const rawQuery = input.trim()
  const debouncing = rawQuery.length >= 2 && rawQuery !== query

  const filteredCatalogue = useMemo(() => {
    return items
      .filter(
        (item) =>
          categoryMatchesFilter(item.package.category, filter) &&
          catalogueMatchesStatus(item, status) &&
          (rawQuery.length === 0 || catalogueMatchesQuery(item, rawQuery))
      )
      .sort((left, right) => left.package.name.localeCompare(right.package.name))
  }, [items, filter, status, rawQuery])

  const instantMatches = useMemo(() => filteredCatalogue.slice(0, 8), [filteredCatalogue])

  const data = search.data
  const unifiedResults = useMemo(
    () =>
      data
        ? filterDiscoveryResults(data.results, filter).filter((result) =>
            unifiedMatchesStatus(result, status)
          )
        : [],
    [data, filter, status]
  )
  const unifiedRelated = useMemo(
    () =>
      data
        ? filterDiscoveryResults(data.related, filter).filter((result) =>
            unifiedMatchesStatus(result, status)
          )
        : [],
    [data, filter, status]
  )

  const searchingForQuery = query.length >= 2
  const showInstantMatches =
    rawQuery.length >= 2 && (debouncing || search.isLoading || (!data && search.isFetching))
  const meta = data
  const providerErrors = data?.providers.filter((provider) => provider.status === 'error') ?? []

  const filtersActive = filter !== 'all' || status !== 'all'

  const handleCatalogueInstall = (item: CatalogueItem): void => {
    if (item.package.installationMethod === 'project-recipe') {
      setRecipePackage(item.package)
      return
    }
    setPlanRequests([{ packageId: item.package.id }])
  }

  const handleUnifiedInstall = async (result: UnifiedDiscoveryResult): Promise<void> => {
    if (result.compatibility !== 'installable') return
    setPreparingId(result.id)
    try {
      let packageId = result.packageId
      if (!packageId) {
        const prepared = await api.discovery.prepare(result.id)
        packageId = prepared.packageId
        await queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
        await queryClient.invalidateQueries({ queryKey: queryKeys.installations })
        await queryClient.invalidateQueries({ queryKey: ['discovery'] })
      }
      setPlanRequests([{ packageId }])
    } catch (error) {
      notifyError(error)
    } finally {
      setPreparingId(null)
    }
  }

  const openSource = async (url: string | null): Promise<void> => {
    if (!url) {
      notifyInfo('No official page', 'This source did not provide an HTTPS homepage.')
      return
    }
    try {
      await api.system.openExternal(url)
    } catch (error) {
      notifyError(error)
    }
  }

  const refreshMetadata = async (): Promise<void> => {
    setRefreshingMetadata(true)
    try {
      const result = await api.discovery.refreshManaged(true)
      if (result.skipped) {
        notifyInfo(
          'WinGet is unavailable',
          'WinGet metadata could not be refreshed. Official SDK packages were refreshed when possible.'
        )
      } else if (result.updated.length > 0) {
        notifySuccess(
          'Software metadata refreshed',
          `${result.updated.length} package definition${result.updated.length === 1 ? '' : 's'} updated${
            result.failed > 0 ? `, ${result.failed} could not be refreshed` : ''
          }.`
        )
        await queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
        await queryClient.invalidateQueries({ queryKey: ['discovery'] })
      } else {
        notifySuccess(
          'Software metadata is current',
          result.checked === 0
            ? 'No packages added from discovery yet.'
            : `Checked ${result.checked} package definition${result.checked === 1 ? '' : 's'}; nothing changed.`
        )
      }
    } catch (error) {
      notifyError(error)
    } finally {
      setRefreshingMetadata(false)
    }
  }

  const resetFilters = (): void => {
    setFilter('all')
    setStatus('all')
  }

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        eyebrow="Discovery"
        title="Discover Software"
        description="One search across the DevForge catalog, validated WinGet manifests and official release feeds. Results are merged per product, and Install only appears when a verified procedure exists."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending}
              title="Import a validated package definition from JSON"
            >
              {importMutation.isPending ? <Loader2 className="animate-spin" /> : <FileUp />}
              Import package
            </Button>
            <Button variant="outline" size="sm" onClick={() => void refreshMetadata()} disabled={refreshingMetadata}>
              {refreshingMetadata ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh metadata
            </Button>
          </>
        }
      />

      <section className="rounded-xl border border-border/70 bg-card/50 p-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault()
            const next = input.trim()
            if (next.length >= 2) setQuery(next)
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Search for a language, framework, compiler, database or command…"
              className="h-10 pl-10 pr-10 text-sm"
              aria-label="Search software"
              autoFocus
            />
            {input ? (
              <button
                type="button"
                onClick={() => setInput('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
          <Button type="submit" disabled={rawQuery.length < 2 || search.isFetching} className="h-10">
            {search.isFetching ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {search.isFetching ? 'Searching…' : 'Search'}
          </Button>
        </form>

        {rawQuery.length === 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] text-muted-foreground">Try</span>
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => {
                  setInput(suggestion)
                  setQuery(suggestion)
                }}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        ) : rawQuery.length === 1 ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Keep typing to search WinGet and official release feeds. Catalog matches are shown below.
          </p>
        ) : null}

        {data ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <span className="text-[11px] text-muted-foreground">
              {data.results.length} {data.results.length === 1 ? 'result' : 'results'}
              {data.related.length > 0 ? ` · ${data.related.length} related` : ''} for{' '}
              <span className="font-medium text-foreground">“{data.query}”</span>
            </span>
            {data.cached ? <Badge variant="outline">Cached</Badge> : null}
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock className="size-3" />
              {formatRelative(data.searchedAt)}
            </span>
            {data.intent ? (
              <Badge variant="muted" className="normal-case tracking-normal">
                Identified as {data.intent.name}
              </Badge>
            ) : null}
            {providerErrors.length > 0 ? (
              <Badge
                variant="warning"
                title={providerErrors.map((provider) => provider.message).join(' ')}
              >
                <ShieldAlert className="size-3" />
                {providerErrors.map((provider) => provider.label).join(', ')} unavailable
              </Badge>
            ) : null}
          </div>
        ) : null}

        {data?.providers
          .filter((provider) => provider.status === 'error')
          .map((provider) => (
            <p key={provider.id} className="mt-2 text-[11px] leading-4 text-warning">
              {provider.label}: {provider.message}
            </p>
          ))}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filter} onValueChange={(value) => setFilter(value as DiscoveryFilter)}>
            <SelectTrigger className="h-8 w-[188px] text-xs" aria-label="Filter software">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {discoveryFilters.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tabs value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
            <TabsList className="h-8">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="available">Available</TabsTrigger>
              <TabsTrigger value="installed">Installed</TabsTrigger>
              <TabsTrigger value="updates">Updates</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {filtersActive ? (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            Reset filters
          </Button>
        ) : null}
      </div>

      {!searchingForQuery ? (
        <>
          {profiles.length > 0 ? (
            <section>
              <div className="mb-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="size-4 text-primary" />
                  <h2 className="text-sm font-semibold">Start with an environment profile</h2>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/environments">
                    View all profiles
                    <ChevronRight />
                  </Link>
                </Button>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                {profiles.slice(0, 4).map((profile) => (
                  <Link
                    key={profile.id}
                    to="/environments"
                    className="group flex items-center gap-3 rounded-xl border border-border/70 bg-card/70 px-3.5 py-3 transition-colors hover:border-primary/30 hover:bg-card"
                  >
                    <SoftwareIconTile icon={profile.icon} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium group-hover:text-primary">
                        {profile.name}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {profile.components.length} packages · {profile.audience}
                      </p>
                    </div>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="flex items-end justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">DevForge catalog</h2>
                <p className="text-[11px] text-muted-foreground">
                  Curated definitions with dependency-aware plans and environment configuration.
                </p>
              </div>
              <span className="text-[11px] text-muted-foreground">
                {filteredCatalogue.length} {filteredCatalogue.length === 1 ? 'package' : 'packages'}
              </span>
            </div>

            {catalogueQuery.isError ? (
              <ErrorState error={catalogueQuery.error} onRetry={() => void catalogueQuery.refetch()} />
            ) : catalogueQuery.isLoading ? (
              <CardGridSkeleton count={8} height={212} />
            ) : filteredCatalogue.length === 0 ? (
              <EmptyState
                icon={<Search />}
                title={rawQuery ? 'No catalog packages match your search' : 'No packages match these filters'}
                description={
                  rawQuery
                    ? 'Keep typing to search WinGet and official release feeds, or clear the search to browse the catalog.'
                    : 'Try a different category or status filter.'
                }
                action={
                  filtersActive || rawQuery ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        resetFilters()
                        setInput('')
                      }}
                    >
                      Reset
                    </Button>
                  ) : null
                }
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {filteredCatalogue.map((item) => (
                  <CatalogueCard
                    key={item.package.id}
                    item={item}
                    onInstall={() => handleCatalogueInstall(item)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="space-y-4">
          {showInstantMatches ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">Instant catalog matches</h2>
                  <p className="text-[11px] text-muted-foreground">
                    Local results appear immediately while WinGet and official release feeds are checked.
                  </p>
                </div>
                <Badge variant="info">
                  <Loader2 className="size-3 animate-spin" />
                  Searching sources
                </Badge>
              </div>
              {instantMatches.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {instantMatches.map((item) => (
                    <CatalogueCard
                      key={item.package.id}
                      item={item}
                      onInstall={() => handleCatalogueInstall(item)}
                    />
                  ))}
                </div>
              ) : (
                <CardGridSkeleton count={3} height={212} />
              )}
              <CardGridSkeleton count={3} height={196} />
            </div>
          ) : search.isError ? (
            <div className="space-y-3">
              <ErrorState error={search.error} onRetry={() => void search.refetch()} />
              {filteredCatalogue.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {filteredCatalogue.map((item) => (
                    <CatalogueCard
                      key={item.package.id}
                      item={item}
                      onInstall={() => handleCatalogueInstall(item)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : data ? (
            <>
              {unifiedResults.length === 0 ? (
                <EmptyState
                  icon={<Compass />}
                  title={
                    data.results.length === 0
                      ? `No verified software found for “${data.query}”`
                      : 'No results match these filters'
                  }
                  description={
                    data.results.length === 0
                      ? 'Try a product name, command such as kotlinc, a publisher, or another spelling. Only validated installation procedures appear as installable.'
                      : 'Choose another category, status or clear the verified filter.'
                  }
                  action={
                    data.results.length === 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setInput('')
                          resetFilters()
                        }}
                      >
                        Clear search
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        Reset filters
                      </Button>
                    )
                  }
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {unifiedResults.map((result) => (
                    <UnifiedResultCard
                      key={result.id}
                      result={result}
                      expanded={expandedId === result.id}
                      preparing={preparingId === result.id}
                      onInstall={() => void handleUnifiedInstall(result)}
                      onToggleDetails={() =>
                        setExpandedId((current) => (current === result.id ? null : result.id))
                      }
                      onOpenSource={() => void openSource(result.metadataUrl ?? result.homepage)}
                    />
                  ))}
                </div>
              )}

              {unifiedRelated.length > 0 ? (
                <div className="space-y-3 border-t border-border/70 pt-5">
                  <div>
                    <h2 className="text-sm font-semibold">Related software</h2>
                    <p className="text-[11px] text-muted-foreground">
                      Lower-confidence matches. Review the publisher and source before installing.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {unifiedRelated.map((result) => (
                      <UnifiedResultCard
                        key={result.id}
                        result={result}
                        expanded={expandedId === result.id}
                        preparing={preparingId === result.id}
                        onInstall={() => void handleUnifiedInstall(result)}
                        onToggleDetails={() =>
                          setExpandedId((current) => (current === result.id ? null : result.id))
                        }
                        onOpenSource={() => void openSource(result.metadataUrl ?? result.homepage)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <CardGridSkeleton count={6} height={196} />
          )}
        </section>
      )}

      <PlanDialog
        open={planRequests.length > 0}
        onOpenChange={(open) => !open && setPlanRequests([])}
        requests={planRequests}
        onQueued={() => setPlanRequests([])}
      />
      <RecipeDialog pkg={recipePackage} onOpenChange={(open) => !open && setRecipePackage(null)} />
    </div>
  )
}

function CardGridSkeleton({ count, height }: { count: number; height: number }): ReactNode {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <Skeleton key={index} className="rounded-xl" style={{ height }} />
      ))}
    </div>
  )
}

function UnifiedResultCard({
  result,
  expanded,
  preparing,
  onInstall,
  onToggleDetails,
  onOpenSource
}: {
  result: UnifiedDiscoveryResult
  expanded: boolean
  preparing: boolean
  onInstall: () => void
  onToggleDetails: () => void
  onOpenSource: () => void
}): ReactNode {
  const installable = result.compatibility === 'installable'
  const installed = Boolean(result.installedVersion)
  const officialVersions = result.versions.source.kind === 'official'
  const sourceUrl = result.metadataUrl ?? result.homepage
  const detailsId = `details-${result.id.replace(/[^a-z0-9-]/gi, '-')}`
  const matchLabel =
    result.match.tier === 'executable'
      ? 'Command match'
      : result.match.tier === 'package'
        ? 'Package match'
        : result.match.tier === 'alias'
          ? 'Alias match'
          : result.match.tier === 'related'
            ? 'Related match'
            : null

  return (
    <Card className="group flex flex-col border-border/70 transition-colors hover:border-primary/30 hover:bg-card/90">
      <CardContent className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <SoftwareIconTile icon={result.icon} />
            <div className="min-w-0">
              {result.packageId ? (
                <Link
                  to={`/discover/${result.packageId}`}
                  className="text-sm font-semibold tracking-tight text-foreground transition-colors hover:text-primary"
                >
                  {result.name}
                </Link>
              ) : (
                <p className="text-sm font-semibold tracking-tight">{result.name}</p>
              )}
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {result.publisher} · {categoryLabels[result.category] ?? result.category}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {installed ? (
              <StatusBadge
                status={result.updateAvailable ? 'update' : 'installed'}
                label={result.updateAvailable ? 'Update' : 'Installed'}
              />
            ) : null}
            {installable ? (
              <Badge variant="success" title="A validated installation procedure is available.">
                <ShieldCheck className="size-3" />
                Verified
              </Badge>
            ) : (
              <Badge variant="warning" title={result.compatibilityNote ?? undefined}>
                <ShieldAlert className="size-3" />
                Metadata only
              </Badge>
            )}
          </div>
        </div>

        <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {result.description}
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          {officialVersions && result.versions.lts ? (
            <Badge variant="outline">LTS {result.versions.lts}</Badge>
          ) : null}
          {officialVersions && result.versions.stable ? (
            <Badge variant="outline">Latest stable {result.versions.stable}</Badge>
          ) : null}
          {officialVersions && result.versions.preview ? (
            <Badge variant="muted">Preview {result.versions.preview}</Badge>
          ) : null}
          {!officialVersions && result.manifestVersion ? (
            <Badge variant="outline">Manifest {result.manifestVersion}</Badge>
          ) : null}
          {result.versions.stale ? <Badge variant="warning">Cached versions</Badge> : null}
          {matchLabel ? (
            <Badge variant="muted" className="normal-case tracking-normal">
              {matchLabel}
            </Badge>
          ) : null}
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] leading-4 text-muted-foreground">
          <p className="truncate">
            <span className="text-foreground/70">Install:</span>{' '}
            {result.availableVersion ? `v${result.availableVersion}` : 'Not available'}
          </p>
          <p className="truncate">
            <span className="text-foreground/70">Method:</span>{' '}
            {result.installationMethod
              ? methodLabels[result.installationMethod] ?? result.installationMethod
              : 'None'}
          </p>
          <p className="truncate">
            <span className="text-foreground/70">Platform:</span> Windows x64
          </p>
          <p className="truncate">
            <span className="text-foreground/70">Status:</span>{' '}
            {installed ? `Installed ${result.installedVersion}` : 'Not installed'}
          </p>
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <div className="flex min-w-0 flex-wrap gap-1">
            {result.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant="muted" className="normal-case tracking-normal">
                {tag}
              </Badge>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {result.packageId ? (
              <Button variant="ghost" size="icon-sm" asChild title="View package details">
                <Link to={`/discover/${result.packageId}`} aria-label={`View ${result.name} details`}>
                  <ChevronRight />
                </Link>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={onToggleDetails}
              aria-expanded={expanded}
              aria-controls={detailsId}
            >
              <Info />
              Details
            </Button>
            {installable ? (
              installed && !result.updateAvailable ? (
                result.packageId ? (
                  <Button size="sm" variant="outline" asChild>
                    <Link to={`/discover/${result.packageId}`}>Manage</Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled>
                    Installed
                  </Button>
                )
              ) : (
                <Button size="sm" onClick={onInstall} disabled={preparing}>
                  {preparing ? <Loader2 className="animate-spin" /> : <Download />}
                  {result.updateAvailable ? 'Update' : 'Install'}
                </Button>
              )
            ) : sourceUrl ? (
              <Button variant="outline" size="sm" onClick={onOpenSource}>
                <ExternalLink />
                View source
              </Button>
            ) : (
              <Badge variant="outline">No verified installer</Badge>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleDetails}
              aria-label={`More options for ${result.name}`}
              aria-expanded={expanded}
              aria-controls={detailsId}
              title="More options"
            >
              <MoreHorizontal />
            </Button>
          </div>
        </div>

        {expanded ? (
          <div
            id={detailsId}
            className="mt-3 space-y-2 rounded-lg border border-border/70 bg-background/50 p-3 text-[11px]"
          >
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <DetailItem label="Match" value={result.match.reason} />
              <DetailItem
                label="Sources"
                value={result.sources.map((source) => source.label).join(', ') || 'None'}
              />
              <DetailItem label="Version source" value={result.versions.source.label} />
              <DetailItem
                label="Checked"
                value={formatRelative(result.versions.retrievedAt)}
                warning={result.versions.stale}
              />
              <DetailItem
                label="Catalog manifest"
                value={result.manifestVersion ? `v${result.manifestVersion}` : 'None'}
              />
              <DetailItem
                label="Install versions"
                value={
                  result.availableVersion
                    ? `Up to v${result.availableVersion}`
                    : 'No verified procedure'
                }
              />
            </dl>
            {result.versions.error ? (
              <p className="text-warning">Version source: {result.versions.error}</p>
            ) : null}
            {result.compatibilityNote ? (
              <p className="text-muted-foreground">{result.compatibilityNote}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Globe2 className="size-3" />
                {result.sources.map((source) => source.kind).filter((kind, index, list) => list.indexOf(kind) === index).join(' · ')}
              </span>
              {sourceUrl ? (
                <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onOpenSource}>
                  Open official page
                  <ExternalLink />
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function DetailItem({
  label,
  value,
  warning = false
}: {
  label: string
  value: string
  warning?: boolean
}): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground/80">{label}</dt>
      <dd className={warning ? 'truncate text-warning' : 'truncate text-foreground/80'} title={value}>
        {value}
      </dd>
    </div>
  )
}

function CatalogueCard({ item, onInstall }: { item: CatalogueItem; onInstall: () => void }): ReactNode {
  const pkg = item.package
  const installed = item.installed
  const recipe = pkg.installationMethod === 'project-recipe'
  const version =
    item.updateAvailable && item.availableVersion
      ? item.availableVersion
      : item.defaultVersion ?? item.latestVersion

  return (
    <Card className="group flex flex-col transition-colors hover:border-primary/30 hover:bg-card/90">
      <CardContent className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <SoftwareIconTile icon={pkg.icon} />
          <div className="flex flex-wrap justify-end gap-1">
            {installed ? <StatusBadge status="installed" /> : null}
            {item.updateAvailable ? <StatusBadge status="update" label="Update" /> : null}
            {pkg.advanced ? <Badge variant="outline">Advanced</Badge> : null}
          </div>
        </div>

        <div className="mt-3">
          <Link
            to={`/discover/${pkg.id}`}
            className="text-sm font-semibold tracking-tight text-foreground transition-colors hover:text-primary"
          >
            {pkg.name}
          </Link>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {pkg.publisher} · {categoryLabels[pkg.category] ?? pkg.category}
          </p>
        </div>

        <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{pkg.description}</p>

        <div className="mt-2.5 flex flex-wrap gap-1">
          {pkg.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="muted" className="normal-case tracking-normal">
              {tag}
            </Badge>
          ))}
        </div>

        <div className="mt-auto flex items-end justify-between gap-2 pt-4">
          <div className="min-w-0 text-[10px] leading-4 text-muted-foreground">
            <p className="truncate font-mono">{version ? `v${version}` : 'Project setup'}</p>
            <p className="truncate">{methodLabels[pkg.installationMethod] ?? pkg.installationMethod}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon-sm" asChild title="View details">
              <Link to={`/discover/${pkg.id}`} aria-label={`View ${pkg.name} details`}>
                <ChevronRight />
              </Link>
            </Button>
            {recipe ? (
              <Button size="sm" variant="outline" onClick={onInstall}>
                Setup
              </Button>
            ) : item.updateAvailable ? (
              <Button size="sm" onClick={onInstall}>
                <Download />
                Update
              </Button>
            ) : installed ? (
              <Button size="sm" variant="outline" asChild>
                <Link to={`/discover/${pkg.id}`}>Manage</Link>
              </Button>
            ) : (
              <Button size="sm" onClick={onInstall}>
                <Download />
                Install
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
