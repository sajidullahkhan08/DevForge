import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Clock,
  FolderSync,
  Hourglass,
  Info,
  Loader2,
  ListOrdered,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  TriangleAlert,
  X,
  XCircle
} from 'lucide-react'
import type { QueueItem, QueueSnapshot } from '@shared/types'
import { api } from '@/lib/api'
import { formatDuration, formatRelative, humanize, methodLabels } from '@/lib/format'
import { notifyError, notifySuccess } from '@/lib/feedback'
import { queryKeys, useCatalogue, useQueue } from '@/hooks/useData'
import { PageHeader } from '@/components/common/PageHeader'
import { SoftwareIconTile } from '@/components/common/SoftwareIconTile'
import { StatusBadge } from '@/components/common/StatusBadge'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { StageList } from '@/components/common/StageList'
import { CopyButton } from '@/components/common/CopyButton'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export default function QueuePage(): ReactNode {
  const queryClient = useQueryClient()
  const queueQuery = useQueue()
  const catalogueQuery = useCatalogue()
  const [busy, setBusy] = useState<string | null>(null)

  const packageMap = new Map(
    (catalogueQuery.data ?? []).map((item) => [item.package.id, item.package])
  )

  const snapshot = queueQuery.data
  const items = snapshot?.items ?? []
  const activeItems = items.filter((item) => item.status === 'running' || item.status === 'pending')
  const pendingItems = items.filter((item) => item.status === 'pending')
  const finishedItems = items.filter((item) => item.status !== 'running' && item.status !== 'pending')
  const completedCount = items.filter(
    (item) => item.status === 'completed' || item.status === 'requires-restart'
  ).length
  const partialCount = items.filter((item) => item.status === 'partial').length
  const failedCount = items.filter((item) => item.status === 'failed').length

  const durations = items
    .filter((item) => item.startedAt && item.finishedAt && item.status !== 'cancelled')
    .map((item) => new Date(item.finishedAt as string).getTime() - new Date(item.startedAt as string).getTime())
    .filter((value) => Number.isFinite(value) && value > 0)
  const averageDurationMs =
    durations.length > 0 ? durations.reduce((total, value) => total + value, 0) / durations.length : null
  const etaLabel =
    averageDurationMs !== null && pendingItems.length > 0
      ? `~${formatEstimate(averageDurationMs * pendingItems.length)} remaining`
      : null

  const applySnapshot = (next: QueueSnapshot): void => {
    queryClient.setQueryData(queryKeys.queue, next)
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
  }

  const controlMutation = useMutation({
    mutationFn: (action: 'start' | 'pause' | 'resume' | 'clear') => {
      switch (action) {
        case 'start':
          return api.queue.start()
        case 'pause':
          return api.queue.pause()
        case 'resume':
          return api.queue.resume()
        default:
          return api.queue.clearCompleted()
      }
    },
    onSuccess: (next, action) => {
      applySnapshot(next)
      if (action === 'pause') notifySuccess('Queue paused', 'The current step is allowed to finish before the queue stops.')
      if (action === 'resume' || action === 'start') notifySuccess('Queue running', 'DevForge processes one installation at a time.')
      if (action === 'clear') notifySuccess('Finished items cleared', 'Installation history and logs are preserved.')
    },
    onError: notifyError,
    onSettled: () => setBusy(null)
  })

  const itemMutation = useMutation({
    mutationFn: ({
      action,
      itemId
    }: {
      action: 'cancel' | 'retry' | 'recover' | 'remove' | 'up' | 'down'
      itemId: string
    }) => {
      if (action === 'cancel') return api.queue.cancel(itemId)
      if (action === 'retry') return api.queue.retry(itemId)
      if (action === 'recover') return api.queue.retry(itemId, { recoverDirectory: true })
      if (action === 'up' || action === 'down') return api.queue.move(itemId, action)
      return api.queue.remove(itemId)
    },
    onSuccess: (next) => {
      applySnapshot(next)
      void queryClient.invalidateQueries({ queryKey: queryKeys.installations })
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
    },
    onError: notifyError,
    onSettled: () => setBusy(null)
  })

  const runControl = (action: 'start' | 'pause' | 'resume' | 'clear'): void => {
    setBusy(action)
    controlMutation.mutate(action)
  }

  const runItemAction = (
    action: 'cancel' | 'retry' | 'recover' | 'remove' | 'up' | 'down',
    itemId: string
  ): void => {
    setBusy(`${action}-${itemId}`)
    itemMutation.mutate({ action, itemId })
  }

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        eyebrow="Manage"
        title="Installation Queue"
        description="Installations are executed serially to protect shared installers, environment variables and the tools directory. Every stage below reflects a real operation."
        actions={
          <>
            {!snapshot?.paused ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => runControl('pause')}
                disabled={!snapshot?.running || busy === 'pause'}
              >
                {busy === 'pause' ? <Loader2 className="animate-spin" /> : <Pause />}
                Pause
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => runControl('resume')}
                disabled={busy === 'resume' || (snapshot?.pendingCount ?? 0) === 0}
              >
                {busy === 'resume' ? <Loader2 className="animate-spin" /> : <Play />}
                Resume
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => runControl('start')}
              disabled={!!snapshot?.running || (snapshot?.pendingCount ?? 0) === 0 || busy === 'start'}
            >
              {busy === 'start' ? <Loader2 className="animate-spin" /> : <Play />}
              Start queue
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <QueueStat label="Pending" value={snapshot?.pendingCount ?? 0} tone={snapshot?.pendingCount ? 'warning' : 'neutral'} />
        <QueueStat label="Running" value={snapshot?.running ? 1 : 0} tone={snapshot?.running ? 'primary' : 'neutral'} />
        <QueueStat label="Completed" value={completedCount} tone={completedCount ? 'success' : 'neutral'} />
        <QueueStat label="Partial" value={partialCount} tone={partialCount ? 'warning' : 'neutral'} />
        <QueueStat label="Failed" value={failedCount} tone={failedCount ? 'destructive' : 'neutral'} />
      </div>

      {snapshot && snapshot.items.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-card/50 px-3.5 py-2.5 text-[11px] text-muted-foreground">
          <span className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'size-1.5 rounded-full',
                snapshot.running ? 'animate-pulse bg-primary' : snapshot.paused ? 'bg-warning' : 'bg-muted-foreground/50'
              )}
            />
            {snapshot.running ? (snapshot.paused ? 'Pausing after the current step' : 'Queue is running') : 'Queue is idle'}
            {etaLabel ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground/80">
                <Hourglass className="size-3" />
                {etaLabel}
              </span>
            ) : null}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => runControl('clear')}
            disabled={finishedItems.length === 0 || busy === 'clear'}
          >
            {busy === 'clear' ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Clear finished
          </Button>
        </div>
      ) : null}

      {queueQuery.isError ? (
        <ErrorState error={queueQuery.error} onRetry={() => void queueQuery.refetch()} />
      ) : queueQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ListOrdered />}
          title="The queue is empty"
          description="Add a package from Discover Software, an installed update or an environment profile. You can review the full plan before starting."
          action={
            <Button size="sm" asChild>
              <Link to="/discover">Find software</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {activeItems.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Active
              </h2>
              {activeItems.map((item) => (
                <QueueCard
                  key={item.id}
                  item={item}
                  icon={packageMap.get(item.packageId)?.icon ?? 'terminal'}
                  busy={busy}
                  canMoveUp={pendingItems.length > 1 && pendingItems[0]?.id !== item.id}
                  canMoveDown={
                    pendingItems.length > 1 && pendingItems[pendingItems.length - 1]?.id !== item.id
                  }
                  onMove={(direction) => runItemAction(direction, item.id)}
                  onCancel={() => runItemAction('cancel', item.id)}
                  onRetry={() => runItemAction('retry', item.id)}
                  onRecover={() => runItemAction('recover', item.id)}
                  onRemove={() => runItemAction('remove', item.id)}
                />
              ))}
            </section>
          ) : null}

          {finishedItems.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Finished
              </h2>
              {finishedItems.map((item) => (
                <QueueCard
                  key={item.id}
                  item={item}
                  icon={packageMap.get(item.packageId)?.icon ?? 'terminal'}
                  busy={busy}
                  canMoveUp={false}
                  canMoveDown={false}
                  onCancel={() => runItemAction('cancel', item.id)}
                  onRetry={() => runItemAction('retry', item.id)}
                  onRecover={() => runItemAction('recover', item.id)}
                  onRemove={() => runItemAction('remove', item.id)}
                />
              ))}
            </section>
          ) : null}
        </div>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-card/50 px-3.5 py-3 text-[11px] leading-5 text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span>
          DevForge can stop processes it started, but third-party installers may continue finishing on their own after
          a cancel request. Pause takes effect after the current stage. Downloads and installers are never reported as
          complete unless the underlying process actually succeeded.
        </span>
      </div>
    </div>
  )
}

interface QueueCardProps {
  item: QueueItem
  icon: string
  busy: string | null
  canMoveUp: boolean
  canMoveDown: boolean
  onMove?: (direction: 'up' | 'down') => void
  onCancel: () => void
  onRetry: () => void
  onRecover: () => void
  onRemove: () => void
}

function QueueCard({
  item,
  icon,
  busy,
  canMoveUp,
  canMoveDown,
  onMove,
  onCancel,
  onRetry,
  onRecover,
  onRemove
}: QueueCardProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [confirmRecovery, setConfirmRecovery] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const isRunning = item.status === 'running'
  const isPending = item.status === 'pending'
  const showStages = expanded || isRunning || item.status === 'failed' || item.status === 'partial'

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isRunning])

  return (
    <Card className={cn(isRunning && 'border-primary/30 shadow-glow')}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <SoftwareIconTile icon={icon} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold">{item.name}</span>
              {item.version ? <span className="font-mono text-[11px] text-muted-foreground">{item.version}</span> : null}
              <Badge variant="outline">{methodLabels[item.method] ?? item.method}</Badge>
              {item.isDependency ? <Badge variant="secondary">Dependency</Badge> : null}
              <StatusBadge status={item.status} />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                added {formatRelative(item.addedAt)}
              </span>
              {item.startedAt ? <span>started {formatRelative(item.startedAt)}</span> : null}
              {isRunning && item.startedAt ? (
                <span className="inline-flex items-center gap-1 font-mono">
                  <Hourglass className="size-3" />
                  elapsed {formatDuration(item.startedAt, new Date(now).toISOString())}
                </span>
              ) : null}
              {item.transactionId ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="font-mono">{item.transactionId.slice(0, 18)}…</span>
                  <CopyButton value={item.transactionId} />
                </span>
              ) : null}
            </div>
            {item.reason ? (
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{item.reason}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {isPending && onMove ? (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Move earlier"
                  aria-label="Move earlier in the queue"
                  onClick={() => onMove('up')}
                  disabled={!canMoveUp || busy === `up-${item.id}`}
                >
                  {busy === `up-${item.id}` ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Move later"
                  aria-label="Move later in the queue"
                  onClick={() => onMove('down')}
                  disabled={!canMoveDown || busy === `down-${item.id}`}
                >
                  {busy === `down-${item.id}` ? <Loader2 className="animate-spin" /> : <ArrowDown />}
                </Button>
              </>
            ) : null}
            {isPending ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                disabled={busy === `cancel-${item.id}`}
              >
                {busy === `cancel-${item.id}` ? <Loader2 className="animate-spin" /> : <X />}
                Cancel
              </Button>
            ) : null}
            {isRunning ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                disabled={busy === `cancel-${item.id}`}
              >
                {busy === `cancel-${item.id}` ? <Loader2 className="animate-spin" /> : <XCircle />}
                Cancel
              </Button>
            ) : null}
            {!isPending && !isRunning ? (
              <Button variant="outline" size="sm" onClick={onRetry} disabled={busy === `retry-${item.id}`}>
                {busy === `retry-${item.id}` ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                Retry
              </Button>
            ) : null}
            {!isRunning ? (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Remove from queue"
                onClick={onRemove}
                disabled={busy === `remove-${item.id}`}
              >
                {busy === `remove-${item.id}` ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
            ) : null}
          </div>
        </div>

        {item.summary ? (
          <div className="mt-2 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2">
            <p className="text-[11px] leading-4 text-muted-foreground">{item.summary.summary}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Badge variant={item.summary.outcome === 'partial' ? 'warning' : 'success'}>
                {humanize(item.summary.outcome)}
              </Badge>
              <Badge variant="outline">Installation: {humanize(item.summary.installation)}</Badge>
              <Badge variant="outline">Config: {humanize(item.summary.configuration)}</Badge>
              <Badge variant="outline">Verification: {humanize(item.summary.verification)}</Badge>
            </div>
          </div>
        ) : null}

        {isRunning || isPending ? (
          <div className="mt-3">
            <Progress value={item.progress} indeterminate={isRunning && item.progress === null} />
            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span className="truncate">{item.message ?? (isPending ? 'Waiting for the queue' : 'Starting…')}</span>
              <span className="font-mono">{item.progress !== null ? `${Math.round(item.progress)}%` : ''}</span>
            </div>
          </div>
        ) : item.message ? (
          <p className="mt-2 text-[11px] text-muted-foreground">{item.message}</p>
        ) : null}

        {item.error ? (
          <div className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <TriangleAlert className="size-3.5" />
              {item.error.code}: {item.error.message}
            </div>
            {item.error.hint ? (
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{item.error.hint}</p>
            ) : null}
            {item.error.details ? (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                  Technical details
                </summary>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
                  {item.error.details}
                </pre>
              </details>
            ) : null}
            {item.error.code === 'DIRECTORY_CONFLICT' ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => setConfirmRecovery(true)}
                disabled={busy === `recover-${item.id}`}
              >
                {busy === `recover-${item.id}` ? <Loader2 className="animate-spin" /> : <FolderSync />}
                Retry with folder recovery
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            {showStages ? 'Hide stages' : 'Show stages'}
          </button>
          {showStages ? (
            <div className="mt-2 rounded-lg border border-border/50 bg-secondary/15 p-3">
              <StageList stages={item.stages} />
            </div>
          ) : null}
        </div>

        <Dialog open={confirmRecovery} onOpenChange={setConfirmRecovery}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Recover the existing folder?</DialogTitle>
              <DialogDescription>
                DevForge will move the existing installation folder aside instead of deleting it, then install a fresh
                copy. Folders DevForge cannot verify as its own are never modified.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmRecovery(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setConfirmRecovery(false)
                  onRecover()
                }}
              >
                <FolderSync />
                Move folder and retry
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}

function formatEstimate(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`
}

function QueueStat({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone: 'neutral' | 'success' | 'primary' | 'warning' | 'destructive'
}): ReactNode {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'primary'
        ? 'text-primary'
        : tone === 'warning'
          ? 'text-warning'
          : tone === 'destructive'
            ? 'text-destructive'
            : 'text-foreground'
  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-3.5 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold tracking-tight ${toneClass}`}>{value}</p>
    </div>
  )
}
