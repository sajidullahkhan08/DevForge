import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftRight,
  CheckCircle2,
  Download,
  FolderOpen,
  GitBranch,
  Info,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type {
  CatalogueItem,
  InstallRequest,
  InstalledSummary,
  ProjectGenerateResult,
  ProjectInspection
} from '@shared/types'
import { sortVersionRecordsDescending } from '@shared/version'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { notifyError, notifySuccess } from '@/lib/feedback'
import { queryKeys, useCatalogue, useInstallations } from '@/hooks/useData'
import { PageHeader } from '@/components/common/PageHeader'
import { SoftwareIconTile } from '@/components/common/SoftwareIconTile'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { PlanDialog } from '@/components/common/PlanDialog'
import { CopyButton } from '@/components/common/CopyButton'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

export default function VersionsPage(): ReactNode {
  const queryClient = useQueryClient()
  const catalogueQuery = useCatalogue()
  const installationsQuery = useInstallations()
  const [search, setSearch] = useState('')
  const [planRequests, setPlanRequests] = useState<InstallRequest[]>([])
  const [switching, setSwitching] = useState<string | null>(null)

  const records = installationsQuery.data ?? []
  const catalogue = catalogueQuery.data ?? []

  const installedByPackage = useMemo(() => {
    const map = new Map<string, InstalledSummary[]>()
    for (const record of records) {
      if (record.status !== 'installed') continue
      const list = map.get(record.packageId) ?? []
      list.push(record)
      map.set(record.packageId, list)
    }
    return map
  }, [records])

  const relevant = useMemo(() => {
    const query = search.trim().toLowerCase()
    return catalogue
      .filter((item) => {
        const installed = installedByPackage.get(item.package.id) ?? []
        return item.package.versions.length > 1 || item.package.supportsVersionSwitching || installed.length > 0
      })
      .filter((item) => {
        if (!query) return true
        return (
          item.package.name.toLowerCase().includes(query) ||
          item.package.id.includes(query) ||
          item.package.tags.some((tag) => tag.toLowerCase().includes(query))
        )
      })
      .sort((a, b) => {
        const aInstalled = (installedByPackage.get(a.package.id)?.length ?? 0) > 0
        const bInstalled = (installedByPackage.get(b.package.id)?.length ?? 0) > 0
        if (aInstalled !== bInstalled) return aInstalled ? -1 : 1
        return a.package.name.localeCompare(b.package.name)
      })
  }, [catalogue, installedByPackage, search])

  const switchMutation = useMutation({
    mutationFn: ({ packageId, version }: { packageId: string; version: string }) =>
      api.versions.switch(packageId, version),
    onSuccess: (result) => {
      notifySuccess('Active version switched', result.message)
      void queryClient.invalidateQueries({ queryKey: queryKeys.installations })
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      void queryClient.invalidateQueries({ queryKey: queryKeys.environment })
      void queryClient.invalidateQueries({ queryKey: queryKeys.environmentBackups })
    },
    onError: notifyError,
    onSettled: () => setSwitching(null)
  })

  const installedMultiVersion = relevant.filter(
    (item) => (installedByPackage.get(item.package.id)?.length ?? 0) > 1
  ).length

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        eyebrow="Manage"
        title="Version Manager"
        description="Keep multiple versions installed and switch the active one. Switching re-applies the package's environment entries to the selected installation, with targeted backups."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: queryKeys.installations })
                void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
              }}
            >
              <RefreshCw />
              Refresh
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/discover">
                <Download />
                Install another version
              </Link>
            </Button>
          </>
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-3 text-[11px] leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span>
          Only packages marked as switchable can change their active version. For all other tools, install the
          desired version from the catalogue and follow the vendor's guidance for selecting between installations.
          DevForge never edits tool configuration files behind your back.
        </span>
      </div>

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search versioned packages…"
            className="pl-9"
            aria-label="Search versioned packages"
          />
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline">{relevant.length} packages</Badge>
          <Badge variant={installedMultiVersion > 0 ? 'warning' : 'muted'}>
            {installedMultiVersion} with multiple versions installed
          </Badge>
        </div>
      </div>

      {catalogueQuery.isError || installationsQuery.isError ? (
        <ErrorState
          error={catalogueQuery.error ?? installationsQuery.error}
          onRetry={() => {
            void catalogueQuery.refetch()
            void installationsQuery.refetch()
          }}
        />
      ) : catalogueQuery.isLoading || installationsQuery.isLoading ? (
        <div className="grid gap-3 xl:grid-cols-2">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : relevant.length === 0 ? (
        <EmptyState
          icon={<GitBranch />}
          title={search ? 'No packages match' : 'No versioned packages available'}
          description={
            search
              ? 'Try a different search term.'
              : 'The registry does not contain packages with multiple versions, and nothing versioned is installed.'
          }
          action={
            search ? (
              <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                Clear search
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {relevant.map((item) => (
            <VersionCard
              key={item.package.id}
              item={item}
              installations={installedByPackage.get(item.package.id) ?? []}
              switching={switching}
              onSwitch={(version) => {
                setSwitching(`${item.package.id}@${version}`)
                switchMutation.mutate({ packageId: item.package.id, version })
              }}
              onInstall={(version) =>
                setPlanRequests([{ packageId: item.package.id, version }])
              }
            />
          ))}
        </div>
      )}

      <ProjectEnvironmentCard />

      <PlanDialog
        open={planRequests.length > 0}
        onOpenChange={(open) => !open && setPlanRequests([])}
        requests={planRequests}
        onQueued={() => setPlanRequests([])}
      />
    </div>
  )
}

function ProjectEnvironmentCard(): ReactNode {
  const [inspection, setInspection] = useState<ProjectInspection | null>(null)
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ProjectGenerateResult | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [loading, setLoading] = useState(false)

  const choose = async (): Promise<void> => {
    setLoading(true)
    try {
      const path = await api.projects.choose()
      if (!path) return
      const next = await api.projects.inspect(path)
      setInspection(next)
      setResult(null)
      setSelected(
        next.config?.packages ??
          Object.fromEntries(
            [...new Set(next.options.map((option) => option.packageId))].map((packageId) => {
              const options = next.options.filter((option) => option.packageId === packageId)
              const preferred = options.find((option) => option.active) ?? options[0]
              return [packageId, preferred?.version ?? '']
            })
          )
      )
      if (next.warnings.length > 0) {
        notifyError(new Error(next.warnings.join(' ')))
      }
    } catch (error) {
      notifyError(error)
    } finally {
      setLoading(false)
    }
  }

  const generate = useMutation({
    mutationFn: () => api.projects.generate({ path: inspection?.path ?? '', packages: selected }),
    onSuccess: (generated) => {
      setResult(generated)
      notifySuccess(
        'Project environment generated',
        `Activate it with ${generated.command}. Only the current shell is changed.`
      )
      if (generated.warnings.length > 0) {
        notifyError(new Error(generated.warnings.join(' ')))
      }
    },
    onError: notifyError
  })

  const remove = useMutation({
    mutationFn: () => api.projects.remove(inspection?.path ?? ''),
    onSuccess: (removed) => {
      setResult(null)
      setConfirmRemove(false)
      notifySuccess(
        'Project environment removed',
        removed.removed.length > 0
          ? `Deleted ${removed.removed.length} generated file(s). Your project files were untouched.`
          : 'No generated files were found.'
      )
    },
    onError: notifyError
  })

  const grouped = useMemo(() => {
    const map = new Map<string, ProjectInspection['options']>()
    for (const option of inspection?.options ?? []) {
      const list = map.get(option.packageId) ?? []
      list.push(option)
      map.set(option.packageId, list)
    }
    return [...map.entries()].sort((left, right) =>
      (left[1][0]?.name ?? left[0]).localeCompare(right[1][0]?.name ?? right[0])
    )
  }, [inspection])

  return (
    <Card className="border-primary/20 bg-primary/[0.03]">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div>
          <p className="text-sm font-semibold">Project environments</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
            Pin installed versions to one folder. DevForge writes a PowerShell activation script that changes only
            the current shell, so different projects can use different runtimes without touching the machine PATH.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void choose()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          {inspection ? 'Change folder' : 'Choose project folder'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!inspection ? (
          <div className="rounded-lg border border-border/60 bg-secondary/20 px-3.5 py-3 text-[11px] text-muted-foreground">
            Choose a project folder to inspect its existing DevForge environment file, if any.
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border/60 bg-secondary/20 px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">{inspection.name}</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {inspection.path}
                </Badge>
                <Badge variant={inspection.configExists ? 'success' : 'muted'}>
                  {inspection.configExists ? 'Environment file present' : 'New environment file'}
                </Badge>
              </div>
              {inspection.warnings.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5 text-[10px] leading-4 text-warning">
                  {inspection.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            {grouped.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No installed tool has a recorded installation folder. Install packages through DevForge first.
              </p>
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">
                {grouped.map(([packageId, options]) => (
                  <div key={packageId} className="rounded-lg border border-border/60 bg-card/50 px-3 py-2.5">
                    <p className="text-[11px] font-medium">{options[0]?.name ?? packageId}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {options.map((option) => {
                        const active = selected[packageId] === option.version
                        return (
                          <button
                            key={`${option.packageId}-${option.version}`}
                            type="button"
                            onClick={() => setSelected((current) => ({ ...current, [packageId]: option.version }))}
                            className={`rounded-md border px-2 py-1 font-mono text-[10px] transition-colors ${
                              active
                                ? 'border-primary/40 bg-primary/15 text-primary'
                                : 'border-border bg-secondary/30 text-muted-foreground hover:border-primary/30 hover:text-foreground'
                            }`}
                            aria-pressed={active}
                          >
                            {option.version}
                            {option.active ? ' · active' : ''}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => generate.mutate()}
                disabled={grouped.length === 0 || generate.isPending}
              >
                {generate.isPending ? <Loader2 className="animate-spin" /> : <GitBranch />}
                Generate activation script
              </Button>
              {inspection.configExists ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmRemove(true)}
                  disabled={remove.isPending}
                >
                  {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Remove generated files
                </Button>
              ) : null}
            </div>

            {result ? (
              <div className="rounded-lg border border-success/25 bg-success/5 px-3.5 py-3 text-[11px] leading-5">
                <p className="font-medium text-success">Project environment generated</p>
                <p className="mt-1 text-muted-foreground">
                  Open PowerShell in the project folder and run:
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="rounded bg-background/70 px-2 py-1 font-mono text-[11px]">{result.command}</code>
                  <CopyButton value={result.command} />
                </div>
                <p className="mt-1.5 break-all font-mono text-[10px] text-muted-foreground">{result.scriptPath}</p>
                {result.warnings.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 text-[10px] text-warning">
                    {result.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the generated project environment?"
        description="Only the files inside the project's .devforge folder are removed. Project files and installed software are untouched."
        confirmLabel="Remove files"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  )
}

interface VersionCardProps {
  item: CatalogueItem
  installations: InstalledSummary[]
  switching: string | null
  onSwitch: (version: string) => void
  onInstall: (version: string) => void
}

function VersionCard({ item, installations, switching, onSwitch, onInstall }: VersionCardProps): ReactNode {
  const pkg = item.package
  const versions = sortVersionRecordsDescending(pkg.versions)
  const active = installations.find((record) => record.isActive) ?? installations[0]
  const hasInstalled = installations.length > 0
  const supportsSwitch = pkg.supportsVersionSwitching

  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <SoftwareIconTile icon={pkg.icon} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link to={`/discover/${pkg.id}`} className="text-sm font-semibold hover:text-primary">
              {pkg.name}
            </Link>
            {hasInstalled ? (
              <Badge variant="success">{active?.version ?? 'installed'}</Badge>
            ) : (
              <Badge variant="muted">Not installed</Badge>
            )}
            {supportsSwitch ? (
              <Badge variant="outline">Switchable</Badge>
            ) : (
              <Badge variant="muted">Manual switching</Badge>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {installations.length} installation(s) recorded · {versions.length} version(s) in registry
          </p>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="divide-y divide-border/60 border-t border-border/60">
          {versions.map((version) => {
            const installedRecord = installations.find((record) => record.version === version.version)
            const isActive = Boolean(installedRecord?.isActive)
            const busy = switching === `${pkg.id}@${version.version}`
            return (
              <div key={version.version} className="flex items-center gap-2 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] text-foreground/90">{version.version}</span>
                    {version.channel === 'lts' ? <Badge variant="success">LTS</Badge> : null}
                    {version.isDefault ? <Badge variant="outline">Default</Badge> : null}
                    {installedRecord ? (
                      isActive ? (
                        <Badge variant="success">
                          <CheckCircle2 className="size-2.5" /> Active
                        </Badge>
                      ) : (
                        <Badge variant="default">Installed</Badge>
                      )
                    ) : null}
                  </div>
                  {installedRecord?.installDir ? (
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={installedRecord.installDir}>
                      {installedRecord.installDir}
                    </p>
                  ) : installedRecord ? (
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      installed {formatRelative(installedRecord.installedAt)}
                    </p>
                  ) : null}
                </div>
                {installedRecord ? (
                  isActive ? (
                    <span className="text-[10px] text-muted-foreground">Active version</span>
                  ) : supportsSwitch ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onSwitch(version.version)}
                      disabled={Boolean(switching)}
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <ArrowLeftRight />}
                      Switch
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" disabled title="This package does not support automatic switching">
                      <TriangleAlert />
                      Manual
                    </Button>
                  )
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => onInstall(version.version)}>
                    <Download />
                    Install
                  </Button>
                )}
              </div>
            )
          })}
        </div>
        <div className="flex items-start gap-2 border-t border-border/60 px-4 py-2.5 text-[10px] leading-4 text-muted-foreground">
          <Info className="mt-0.5 size-3 shrink-0" />
          {supportsSwitch ? (
            <span>
              Switching reverts this package's previous environment entries, applies the selected version's entries,
              and records a backup. Open a new terminal afterwards.
            </span>
          ) : (
            <span>
              This tool does not support automatic version switching. Multiple versions can be installed, but
              selecting the active one is managed by the tool itself.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
