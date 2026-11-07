import type { ReactNode } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as ChartTooltipPrimitive } from 'recharts'
import {
  ArrowRight,
  ArrowUpCircle,
  CalendarDays,
  Compass,
  Download,
  Layers,
  ListOrdered,
  Loader2,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles
} from 'lucide-react'
import type { InstallRequest, UpdateInfo } from '@shared/types'
import { api } from '@/lib/api'
import { categoryLabels, formatBytes, formatRelative, methodLabels } from '@/lib/format'
import { notifyError, notifySuccess } from '@/lib/feedback'
import { queryKeys, useDashboard, useSystemInfo } from '@/hooks/useData'
import { PageHeader } from '@/components/common/PageHeader'
import { MetricCard } from '@/components/common/MetricCard'
import { ActivityList } from '@/components/common/ActivityList'
import { HealthList } from '@/components/common/HealthList'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { StatusBadge } from '@/components/common/StatusBadge'
import { PlanDialog } from '@/components/common/PlanDialog'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

const chartColors = ['#8b9cff', '#5eead4', '#fbbf77', '#f472b6', '#67e8f9', '#a3e635', '#c4b5fd']

export default function DashboardPage(): ReactNode {
  const queryClient = useQueryClient()
  const dashboardQuery = useDashboard()
  const { data: info } = useSystemInfo()
  const [planRequests, setPlanRequests] = useState<InstallRequest[]>([])

  const refreshMutation = useMutation({
    mutationFn: () => api.installations.refresh(),
    onSuccess: (installations) => {
      queryClient.setQueryData(queryKeys.installations, installations)
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
      void queryClient.invalidateQueries({ queryKey: queryKeys.info })
      notifySuccess('Detection complete', `${installations.length} active installation(s) detected on this machine.`)
    },
    onError: notifyError
  })

  const checkUpdatesMutation = useMutation({
    mutationFn: () => api.installations.checkUpdates(),
    onSuccess: (updates) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
      notifySuccess(
        updates.length > 0 ? `${updates.length} update(s) available` : 'Everything is up to date',
        updates.length > 0 ? 'Review the available versions and install updates from the list.' : 'No newer stable versions were found in the registry.'
      )
    },
    onError: notifyError
  })

  const data = dashboardQuery.data
  const refreshing = refreshMutation.isPending
  const checkingUpdates = checkUpdatesMutation.isPending

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="A real-time view of your Windows development environment: installations, verification health, queue activity and available updates."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshing}
            >
              {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
            <Button size="sm" asChild>
              <Link to="/discover">
                <Compass />
                Browse software
              </Link>
            </Button>
          </>
        }
      />

      {dashboardQuery.isError ? (
        <ErrorState error={dashboardQuery.error} onRetry={() => void dashboardQuery.refetch()} />
      ) : !data ? (
        <DashboardSkeleton />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard
              label="Installed"
              value={data.stats.installedCount}
              hint={`${data.installations.filter((record) => record.verificationStatus === 'verified').length} verified · ${data.installations.filter((record) => record.envStatus === 'configured').length} configured`}
              icon={<PackageCheck />}
              tone="primary"
            />
            <MetricCard
              label="Updates available"
              value={data.stats.updatesCount}
              hint={data.stats.updatesCount > 0 ? 'Newer versions are available' : 'All tracked tools are current'}
              icon={<ArrowUpCircle />}
              tone={data.stats.updatesCount > 0 ? 'warning' : 'success'}
            />
            <MetricCard
              label="Active profiles"
              value={data.stats.activeProfiles}
              hint="Environment profiles matched by installed tools"
              icon={<Layers />}
            />
            <MetricCard
              label="Recent installs"
              value={data.stats.recentInstalls}
              hint={`${data.stats.pendingOperations} operation(s) pending in the queue`}
              icon={<CalendarDays />}
            />
          </section>

          {data.stats.installedCount === 0 && data.installations.length === 0 ? (
            <Card className="relative overflow-hidden border-primary/25 bg-gradient-to-r from-primary/12 via-primary/5 to-transparent">
              <div className="pointer-events-none absolute -right-16 -top-24 size-64 rounded-full bg-primary/10 blur-3xl" />
              <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
                    <Sparkles className="size-4" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Your machine is a blank slate</p>
                    <p className="mt-0.5 max-w-xl text-xs leading-5 text-muted-foreground">
                      Start with a curated environment profile such as JavaScript, Python or Java. DevForge resolves
                      dependencies, verifies downloads and configures environment variables for you.
                    </p>
                  </div>
                </div>
                <Button asChild size="sm" className="shrink-0">
                  <Link to="/environments">
                    Explore profiles
                    <ArrowRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : null}

          <section className="grid gap-4 xl:grid-cols-3">
            <div className="space-y-4 xl:col-span-2">
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-3">
                  <div>
                    <CardTitle>Updates available</CardTitle>
                    <CardDescription>
                      Verified package updates plus newer releases reported by authoritative vendor feeds.
                    </CardDescription>
                  </div>
                  {data.updates.some((update) => update.installable) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPlanRequests(
                          data.updates
                            .filter((update) => update.installable)
                            .map((update) => ({ packageId: update.packageId }))
                        )
                      }
                    >
                      <Download />
                      Update all
                    </Button>
                  ) : null}
                </CardHeader>
                <CardContent>
                  {data.updates.length === 0 ? (
                    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 px-3.5 py-3">
                      <ShieldCheck className="size-4 shrink-0 text-success" />
                      <div>
                        <p className="text-xs font-medium">Everything is up to date</p>
                        <p className="text-[11px] text-muted-foreground">
                          No newer verified package or vendor-reported release was found for the installed tools.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {data.updates.map((update) => (
                        <UpdateRow
                          key={`${update.packageId}-${update.source}`}
                          update={update}
                          onInstall={() => setPlanRequests([{ packageId: update.packageId, version: update.availableVersion }])}
                        />
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-3">
                  <div>
                    <CardTitle>Environment health</CardTitle>
                    <CardDescription>PATH validation, verification results and configuration checks.</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void dashboardQuery.refetch()}>
                    <RefreshCw />
                    Re-run
                  </Button>
                </CardHeader>
                <CardContent>
                  {data.health.length === 0 ? (
                    <div className="flex items-center gap-3 rounded-lg border border-success/20 bg-success/5 px-3.5 py-3">
                      <ShieldCheck className="size-4 shrink-0 text-success" />
                      <div>
                        <p className="text-xs font-medium text-success">All checks passed</p>
                        <p className="text-[11px] text-muted-foreground">
                          No environment problems were detected on this machine.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <HealthList checks={data.health} limit={6} />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <div>
                    <CardTitle>Recent activity</CardTitle>
                    <CardDescription>Real events written by the installation engine.</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link to="/history">
                      View history
                      <ArrowRight />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {data.activity.length === 0 ? (
                    <EmptyState
                      icon={<Download />}
                      title="No activity yet"
                      description="Installations, configuration changes and verification runs will appear here."
                      className="border-0 bg-transparent py-8"
                    />
                  ) : (
                    <ActivityList entries={data.activity} limit={6} />
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>Quick actions</CardTitle>
                  <CardDescription>Jump straight into common workflows.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  <QuickAction to="/discover" icon={<Compass />} title="Discover software" hint="Browse the curated registry" />
                  <QuickAction to="/environments" icon={<Layers />} title="Set up an environment" hint="Install a profile in one plan" />
                  <QuickAction
                    to="/environment-variables"
                    icon={<SlidersHorizontal />}
                    title="Manage environment variables"
                    hint="Review PATH entries and backups"
                  />
                  <QuickAction
                    to="/queue"
                    icon={<ListOrdered />}
                    title="Installation queue"
                    hint={
                      data.queue.pendingCount > 0 || data.queue.running
                        ? `${data.queue.pendingCount} pending${data.queue.running ? ' · running' : ''}`
                        : 'Nothing queued'
                    }
                  />
                  <button
                    type="button"
                    onClick={() => checkUpdatesMutation.mutate()}
                    disabled={checkingUpdates}
                    className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-secondary/60 disabled:opacity-60"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/40 text-muted-foreground [&_svg]:size-3.5">
                      {checkingUpdates ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-foreground">Check for updates</span>
                      <span className="block text-[11px] text-muted-foreground">Compare against the registry</span>
                    </span>
                  </button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>Queue status</CardTitle>
                  <CardDescription>Installations run one at a time to protect shared state.</CardDescription>
                </CardHeader>
                <CardContent>
                  <QueuePreview
                    items={data.queue.items}
                    running={data.queue.running}
                    paused={data.queue.paused}
                    pendingCount={data.queue.pendingCount}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-1">
                  <CardTitle>Installed coverage</CardTitle>
                  <CardDescription>Packages tracked by category.</CardDescription>
                </CardHeader>
                <CardContent>
                  {data.categoryBreakdown.length === 0 ? (
                    <p className="py-8 text-center text-xs text-muted-foreground">No packages installed yet.</p>
                  ) : (
                    <CategoryChart data={data.categoryBreakdown} />
                  )}
                </CardContent>
              </Card>

              <div className="rounded-lg border border-border/70 bg-card/60 px-3.5 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                  Tools directory
                </p>
                <p className="mt-1 break-all font-mono text-[11px] leading-4 text-foreground/80">
                  {info?.toolsDir ?? '—'}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {formatBytes(info?.freeDiskBytes ?? null)} free · {info?.windowsVersion ?? 'Windows'}
                </p>
              </div>
            </div>
          </section>
        </>
      )}

      <PlanDialog
        open={planRequests.length > 0}
        onOpenChange={(open) => !open && setPlanRequests([])}
        requests={planRequests}
        onQueued={() => setPlanRequests([])}
      />
    </div>
  )
}

function UpdateRow({ update, onInstall }: { update: UpdateInfo; onInstall: () => void }): ReactNode {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-warning/25 bg-warning/10 text-warning">
        <ArrowUpCircle className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-xs font-medium">{update.name}</p>
          <Badge variant="outline">{methodLabels[update.method] ?? update.method}</Badge>
          {update.source === 'upstream' ? <Badge variant="warning">Upstream</Badge> : null}
          {update.channel ? <Badge variant="secondary">{update.channel.toUpperCase()}</Badge> : null}
        </div>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {update.currentVersion} → <span className="text-warning">{update.availableVersion}</span>
          {update.provenance ? <span className="ml-2 font-sans text-muted-foreground/80">via {update.provenance}</span> : null}
        </p>
        {update.reason ? (
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{update.reason}</p>
        ) : null}
      </div>
      {update.installable ? (
        <Button variant="outline" size="sm" onClick={onInstall}>
          Update
        </Button>
      ) : (
        <Badge variant="muted" title={update.reason ?? 'No verified installation procedure is available yet.'}>
          Manual
        </Badge>
      )}
    </li>
  )
}

function QuickAction({
  to,
  icon,
  title,
  hint
}: {
  to: string
  icon: ReactNode
  title: string
  hint: string
}): ReactNode {
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-secondary/60"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/40 text-muted-foreground transition-colors group-hover:text-primary [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{hint}</span>
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
    </Link>
  )
}

function QueuePreview({
  items,
  running,
  paused,
  pendingCount
}: {
  items: Array<{ id: string; name: string; status: string; progress: number | null; message: string | null; version: string | null }>
  running: boolean
  paused: boolean
  pendingCount: number
}): ReactNode {
  if (items.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-lg bg-secondary/25 px-3 py-2.5 text-[11px] text-muted-foreground">
          <ListOrdered className="size-3.5" />
          No installations are queued.
        </div>
        <Button variant="outline" size="sm" className="w-full" asChild>
          <Link to="/discover">Find software to install</Link>
        </Button>
      </div>
    )
  }

  const active = items.filter((item) => item.status === 'running' || item.status === 'pending').slice(0, 3)
  const visible = active.length > 0 ? active : items.slice(0, 3)

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {running ? (paused ? 'Paused' : 'Installing') : 'Idle'} · {pendingCount} pending
        </span>
        <Link to="/queue" className="text-primary hover:underline">
          Open
        </Link>
      </div>
      {visible.map((item) => (
        <div key={item.id} className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-xs font-medium">
              {item.name} {item.version ? <span className="font-mono text-[10px] text-muted-foreground">{item.version}</span> : null}
            </p>
            <StatusBadge status={item.status} />
          </div>
          {item.status === 'running' ? (
            <Progress className="mt-2" value={item.progress} indeterminate={item.progress === null} />
          ) : null}
          {item.message ? (
            <p className="mt-1 line-clamp-1 text-[10px] text-muted-foreground">{item.message}</p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function CategoryChart({ data }: { data: Array<{ category: string; count: number }> }): ReactNode {
  const total = data.reduce((sum, entry) => sum + entry.count, 0)
  return (
    <div>
      <div className="relative">
        <ResponsiveContainer width="100%" height={170}>
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="category"
              innerRadius={52}
              outerRadius={72}
              paddingAngle={3}
              stroke="none"
            >
              {data.map((entry, index) => (
                <Cell key={entry.category} fill={chartColors[index % chartColors.length]} />
              ))}
            </Pie>
            <ChartTooltipPrimitive cursor={false} content={<CategoryTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold tracking-tight">{total}</span>
          <span className="text-[10px] text-muted-foreground">installed</span>
        </div>
      </div>
      <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
        {data.map((entry, index) => (
          <li key={entry.category} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: chartColors[index % chartColors.length] }}
            />
            <span className="truncate">{categoryLabels[entry.category] ?? entry.category}</span>
            <span className="ml-auto font-mono text-foreground/70">{entry.count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface TooltipPayload {
  payload?: { category: string; count: number }
  value?: number | string
}

function CategoryTooltip({
  active,
  payload
}: {
  active?: boolean
  payload?: TooltipPayload[]
}): ReactNode {
  if (!active || !payload?.length) return null
  const entry = payload[0]?.payload
  if (!entry) return null
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-xl">
      <span className="text-muted-foreground">{categoryLabels[entry.category] ?? entry.category}</span>
      <span className="ml-2 font-medium text-foreground">{entry.count}</span>
    </div>
  )
}

function DashboardSkeleton(): ReactNode {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      </div>
    </div>
  )
}
