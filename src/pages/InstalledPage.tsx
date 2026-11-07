import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Wrench
} from 'lucide-react'
import type { EnvPreview, InstallRequest, InstalledSummary, VerificationRun } from '@shared/types'
import { api } from '@/lib/api'
import { formatRelative, methodLabels, truncate } from '@/lib/format'
import { notifyError, notifyInfo, notifySuccess } from '@/lib/feedback'
import { queryKeys, useCatalogue, useInstallations } from '@/hooks/useData'
import { PageHeader } from '@/components/common/PageHeader'
import { SoftwareIconTile } from '@/components/common/SoftwareIconTile'
import { StatusBadge } from '@/components/common/StatusBadge'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { PlanDialog } from '@/components/common/PlanDialog'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { VerificationDialog } from '@/components/common/VerificationDialog'
import { CopyButton } from '@/components/common/CopyButton'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

type InstalledFilter = 'all' | 'updates' | 'external' | 'attention'

export default function InstalledPage(): ReactNode {
  const queryClient = useQueryClient()
  const installationsQuery = useInstallations()
  const catalogueQuery = useCatalogue()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<InstalledFilter>('all')
  const [planRequests, setPlanRequests] = useState<InstallRequest[]>([])
  const [verification, setVerification] = useState<VerificationRun | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<InstalledSummary | null>(null)
  const [removeDirectory, setRemoveDirectory] = useState(false)
  const [repairResult, setRepairResult] = useState<{ name: string; preview: EnvPreview } | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const catalogue = catalogueQuery.data ?? []
  const packageMap = useMemo(
    () => new Map(catalogue.map((item) => [item.package.id, item])),
    [catalogue]
  )

  const records = useMemo(() => {
    const all = installationsQuery.data ?? []
    const active = new Map<string, InstalledSummary>()
    for (const record of all) {
      const existing = active.get(record.packageId)
      if (!existing || (record.isActive && !existing.isActive)) active.set(record.packageId, record)
    }
    return [...active.values()].sort((a, b) => {
      const nameA = packageMap.get(a.packageId)?.package.name ?? a.packageId
      const nameB = packageMap.get(b.packageId)?.package.name ?? b.packageId
      return nameA.localeCompare(nameB)
    })
  }, [installationsQuery.data, packageMap])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return records.filter((record) => {
      const item = packageMap.get(record.packageId)
      if (filter === 'updates' && !item?.updateAvailable) return false
      if (filter === 'external' && record.source !== 'external') return false
      if (
        filter === 'attention' &&
        record.verificationStatus !== 'failed' &&
        record.envStatus !== 'not-configured'
      ) {
        return false
      }
      if (!query) return true
      return (
        record.packageId.includes(query) ||
        (item?.package.name.toLowerCase().includes(query) ?? false) ||
        (item?.package.publisher.toLowerCase().includes(query) ?? false)
      )
    })
  }, [records, packageMap, filter, search])

  const stats = useMemo(() => {
    return {
      verified: records.filter((record) => record.verificationStatus === 'verified').length,
      configured: records.filter((record) => record.envStatus === 'configured').length,
      updates: records.filter((record) => packageMap.get(record.packageId)?.updateAvailable).length,
      external: records.filter((record) => record.source === 'external').length
    }
  }, [records, packageMap])

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.installations })
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
    void queryClient.invalidateQueries({ queryKey: queryKeys.info })
  }

  const refreshMutation = useMutation({
    mutationFn: () => api.installations.refresh(),
    onSuccess: (installations) => {
      queryClient.setQueryData(queryKeys.installations, installations)
      invalidate()
      notifySuccess('Detection complete', `${installations.length} active installation(s) detected.`)
    },
    onError: notifyError
  })

  const updatesMutation = useMutation({
    mutationFn: () => api.installations.checkUpdates(),
    onSuccess: (updates) => {
      invalidate()
      const installable = updates.filter((update) => update.installable).length
      const upstreamOnly = updates.length - installable
      notifySuccess(
        installable > 0
          ? `${installable} verified update(s) available`
          : upstreamOnly > 0
            ? 'No installable updates yet'
            : 'No updates found',
        installable > 0
          ? 'Use the Update action on each package to review the install plan.'
          : upstreamOnly > 0
            ? `${upstreamOnly} newer release(s) are reported by vendor feeds but have no verified installation procedure yet. See the dashboard for provenance.`
            : 'Installed tools match the latest verified package versions.'
      )
    },
    onError: notifyError
  })

  const verifyMutation = useMutation({
    mutationFn: (packageId: string) => api.installations.verify(packageId),
    onSuccess: (run) => {
      setVerification(run)
      invalidate()
    },
    onError: notifyError,
    onSettled: () => setBusyAction(null)
  })

  const repairMutation = useMutation({
    mutationFn: (packageId: string) => api.installations.repair(packageId),
    onSuccess: (preview, packageId) => {
      const name = packageMap.get(packageId)?.package.name ?? packageId
      setRepairResult({ name, preview })
      invalidate()
      void queryClient.invalidateQueries({ queryKey: queryKeys.environment })
      void queryClient.invalidateQueries({ queryKey: queryKeys.environmentBackups })
    },
    onError: notifyError,
    onSettled: () => setBusyAction(null)
  })

  const openDirectoryMutation = useMutation({
    mutationFn: (packageId: string) => api.installations.openDirectory(packageId),
    onError: notifyError
  })

  const uninstallMutation = useMutation({
    mutationFn: ({ packageId, remove }: { packageId: string; remove: boolean }) =>
      api.installations.uninstall(packageId, { removeDirectory: remove }),
    onSuccess: (result) => {
      notifySuccess('Uninstallation finished', result.message)
      setUninstallTarget(null)
      setRemoveDirectory(false)
      invalidate()
      void queryClient.invalidateQueries({ queryKey: queryKeys.environment })
      void queryClient.invalidateQueries({ queryKey: queryKeys.environmentBackups })
      void queryClient.invalidateQueries({ queryKey: ['history'] })
    },
    onError: notifyError,
    onSettled: () => setBusyAction(null)
  })

  const updateAll = (): void => {
    const requests: InstallRequest[] = records
      .map((record) => ({ record, item: packageMap.get(record.packageId) }))
      .filter(({ item }) => item?.updateAvailable && item.availableVersion)
      .map(({ record, item }) => ({ packageId: record.packageId, version: item?.availableVersion ?? undefined }))
    if (requests.length === 0) {
      notifyInfo('Nothing to update', 'No newer registry versions were found for active installations.')
      return
    }
    setPlanRequests(requests)
  }

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        eyebrow="Manage"
        title="Installed Software"
        description="Everything DevForge can detect on this machine, including installations created outside DevForge. Verification and environment state are measured, never assumed."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
            >
              {refreshMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Detect again
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => updatesMutation.mutate()}
              disabled={updatesMutation.isPending}
            >
              {updatesMutation.isPending ? <Loader2 className="animate-spin" /> : <Download />}
              Check updates
            </Button>
            <Button size="sm" onClick={updateAll} disabled={stats.updates === 0}>
              <ArrowUpCircle />
              Update all ({stats.updates})
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <SummaryPill label="Tracked packages" value={records.length} tone="neutral" />
        <SummaryPill label="Verified" value={stats.verified} tone="success" />
        <SummaryPill label="Environment configured" value={stats.configured} tone="primary" />
        <SummaryPill label="Updates available" value={stats.updates} tone={stats.updates > 0 ? 'warning' : 'neutral'} />
      </div>

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search installed software…"
            className="pl-9"
            aria-label="Search installed software"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={(value) => setFilter(value as InstalledFilter)}>
            <SelectTrigger className="h-8 w-[190px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All installations</SelectItem>
              <SelectItem value="updates">Updates available</SelectItem>
              <SelectItem value="external">Detected externally</SelectItem>
              <SelectItem value="attention">Needs attention</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[11px] text-muted-foreground">
            {filtered.length} of {records.length}
          </span>
        </div>
      </div>

      {installationsQuery.isError ? (
        <ErrorState error={installationsQuery.error} onRetry={() => void installationsQuery.refetch()} />
      ) : installationsQuery.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : records.length === 0 ? (
        <EmptyState
          icon={<PackageCheck />}
          title="Nothing installed yet"
          description="Install a package from the catalogue or an environment profile. DevForge will also detect tools installed with WinGet or found on PATH."
          action={
            <Button size="sm" asChild>
              <Link to="/discover">Browse the catalogue</Link>
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="No installations match"
          description="Adjust the search or filter to see other installations."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearch('')
                setFilter('all')
              }}
            >
              Reset filters
            </Button>
          }
        />
      ) : (
        <Card>
          <div className="hidden items-center gap-3 border-b border-border/70 px-4 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground lg:flex">
            <span className="flex-1">Package</span>
            <span className="w-24">Version</span>
            <span className="w-28">State</span>
            <span className="w-[300px]">Installation directory</span>
            <span className="w-[204px] text-right">Actions</span>
          </div>
          <div className="divide-y divide-border/60">
            {filtered.map((record) => {
              const item = packageMap.get(record.packageId)
              const pkg = item?.package
              const busyVerify = busyAction === `verify-${record.packageId}`
              const busyRepair = busyAction === `repair-${record.packageId}`
              return (
                <div
                  key={`${record.packageId}-${record.id}`}
                  className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-secondary/20 lg:flex-row lg:items-center"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <SoftwareIconTile icon={pkg?.icon ?? 'terminal'} size="sm" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {pkg ? (
                          <Link
                            to={`/discover/${pkg.id}`}
                            className="truncate text-xs font-semibold hover:text-primary"
                          >
                            {pkg.name}
                          </Link>
                        ) : (
                          <span className="text-xs font-semibold">{record.packageId}</span>
                        )}
                        {record.source === 'external' ? <Badge variant="outline">External</Badge> : null}
                        {item?.updateAvailable ? (
                          <StatusBadge status="update" label={`${item.availableVersion} available`} />
                        ) : null}
                        {!record.isActive ? <Badge variant="muted">Inactive</Badge> : null}
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {pkg?.publisher ?? 'Unknown publisher'} · {methodLabels[record.method] ?? record.method} ·
                        installed {formatRelative(record.installedAt)}
                      </p>
                    </div>
                  </div>

                  <div className="w-24 shrink-0">
                    <p className="font-mono text-[11px] text-foreground/90">{record.version}</p>
                    {record.detectedVersion && record.detectedVersion !== record.version ? (
                      <p className="font-mono text-[10px] text-muted-foreground">detected {record.detectedVersion}</p>
                    ) : null}
                  </div>

                  <div className="flex w-28 shrink-0 flex-wrap gap-1">
                    <StatusBadge status={record.verificationStatus === 'verified' ? 'verified' : record.verificationStatus} label={record.verificationStatus === 'verified' ? 'Verified' : record.verificationStatus === 'pending' ? 'Unverified' : undefined} />
                    <StatusBadge status={record.envStatus} />
                  </div>

                  <div className="flex w-[300px] min-w-0 shrink-0 items-center gap-1">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[10px] leading-4 text-muted-foreground"
                      title={record.installDir ?? undefined}
                    >
                      {record.installDir ?? 'Not recorded'}
                    </span>
                    {record.installDir ? (
                      <>
                        <CopyButton value={record.installDir} />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Open installation directory"
                          onClick={() => openDirectoryMutation.mutate(record.packageId)}
                        >
                          <FolderOpen />
                        </Button>
                      </>
                    ) : null}
                  </div>

                  <div className="flex w-[204px] shrink-0 flex-wrap items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Verify installation"
                      disabled={busyVerify}
                      onClick={() => {
                        setBusyAction(`verify-${record.packageId}`)
                        verifyMutation.mutate(record.packageId)
                      }}
                    >
                      {busyVerify ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Repair environment configuration"
                      disabled={busyRepair || (pkg?.environment.length ?? 0) === 0}
                      onClick={() => {
                        setBusyAction(`repair-${record.packageId}`)
                        repairMutation.mutate(record.packageId)
                      }}
                    >
                      {busyRepair ? <Loader2 className="animate-spin" /> : <Wrench />}
                    </Button>
                    {item?.updateAvailable ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={`Update to ${item.availableVersion}`}
                        className="text-warning hover:text-warning"
                        onClick={() =>
                          setPlanRequests([
                            { packageId: record.packageId, version: item.availableVersion ?? undefined }
                          ])
                        }
                      >
                        <ArrowUpCircle />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Uninstall"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setUninstallTarget(record)
                        setRemoveDirectory(false)
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-card/50 px-3.5 py-3 text-[11px] leading-5 text-muted-foreground">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
        <span>
          Detection runs real command probes, checks the Windows uninstall registry, services and known install paths.
          An installation is only marked verified after every required verification check passes.
        </span>
      </div>

      <PlanDialog
        open={planRequests.length > 0}
        onOpenChange={(open) => !open && setPlanRequests([])}
        requests={planRequests}
        onQueued={() => setPlanRequests([])}
      />

      <VerificationDialog run={verification} onClose={() => setVerification(null)} />

      <ConfirmDialog
        open={Boolean(uninstallTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setUninstallTarget(null)
            setRemoveDirectory(false)
          }
        }}
        title={
          uninstallTarget
            ? `Uninstall ${packageMap.get(uninstallTarget.packageId)?.package.name ?? uninstallTarget.packageId}?`
            : 'Uninstall package?'
        }
        description="DevForge will use the package's documented uninstall method and then reverse only the environment entries it added. Installed user data is preserved unless you explicitly choose to remove the managed directory."
        confirmLabel="Uninstall"
        destructive
        loading={uninstallMutation.isPending}
        onConfirm={() =>
          uninstallTarget &&
          uninstallMutation.mutate({
            packageId: uninstallTarget.packageId,
            remove: removeDirectory
          })
        }
      >
        <div className="space-y-3">
          {uninstallTarget ? (
            <div className="rounded-lg border border-border/70 bg-secondary/25 px-3 py-2.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Installed version</span>
                <span className="font-mono text-foreground">{uninstallTarget.version}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Method</span>
                <span className="text-foreground">
                  {methodLabels[uninstallTarget.method] ?? uninstallTarget.method}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Directory</span>
                <span className="max-w-[240px] truncate font-mono text-foreground/80">
                  {truncate(uninstallTarget.installDir, 48)}
                </span>
              </div>
            </div>
          ) : null}

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 px-3 py-2.5">
            <input
              type="checkbox"
              checked={removeDirectory}
              onChange={(event) => setRemoveDirectory(event.target.checked)}
              className="mt-0.5 size-3.5 accent-[hsl(var(--primary))]"
            />
            <span className="text-[11px] leading-5">
              <span className="font-medium text-foreground">Also remove the managed installation directory</span>
              <span className="mt-0.5 block text-muted-foreground">
                Only folders inside the DevForge tools directory can be removed. Database files and directories
                outside that location are always preserved.
              </span>
            </span>
          </label>

          {uninstallTarget && packageMap.get(uninstallTarget.packageId)?.package.category === 'database' ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[11px] leading-5 text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              Running a database uninstaller may stop its service. Recorded data files are not deleted by DevForge,
              but review the vendor's uninstall behavior before continuing.
            </div>
          ) : null}
        </div>
      </ConfirmDialog>

      <Dialog open={Boolean(repairResult)} onOpenChange={(open) => !open && setRepairResult(null)}>
        <DialogContent className="max-w-lg gap-0 p-0">
          <DialogHeader className="border-b border-border/70 p-6 pb-4">
            <DialogTitle>Configuration repaired</DialogTitle>
            <p className="text-xs text-muted-foreground">
              {repairResult?.name} was re-applied to the environment using targeted changes.
            </p>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto p-6">
            {repairResult?.preview.changes.map((change, index) => (
              <div key={index} className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-foreground/90">{change.name}</span>
                  <Badge variant={change.operation === 'noop' ? 'muted' : 'success'}>{change.operation}</Badge>
                </div>
                <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                  {change.after ?? change.before ?? '—'}
                </p>
                {change.reason ? <p className="mt-1 text-[10px] text-muted-foreground">{change.reason}</p> : null}
              </div>
            ))}
            {repairResult?.preview.warnings.map((warning, index) => (
              <p key={index} className="text-[11px] text-warning">
                {warning}
              </p>
            ))}
            {repairResult && repairResult.preview.changes.length === 0 ? (
              <p className="text-xs text-muted-foreground">No changes were required; the environment was already valid.</p>
            ) : null}
            <Separator />
            <p className="text-[11px] text-muted-foreground">
              Open a new terminal for the updated environment to take effect. Existing terminals keep their current
              environment.
            </p>
          </div>
          <DialogFooter className="border-t border-border/70 p-4">
            <Button onClick={() => setRepairResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SummaryPill({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone: 'neutral' | 'success' | 'primary' | 'warning'
}): ReactNode {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'primary'
        ? 'text-primary'
        : tone === 'warning'
          ? 'text-warning'
          : 'text-foreground'
  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-3.5 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold tracking-tight ${toneClass}`}>{value}</p>
    </div>
  )
}
