import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  History,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  TriangleAlert
} from 'lucide-react'
import type { LogEntry, TransactionRecord } from '@shared/types'
import { useHistory, useTransaction } from '@/hooks/useData'
import { formatDateTime, formatDuration, formatTime, methodLabels, truncate } from '@/lib/format'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/common/StatusBadge'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { CopyButton } from '@/components/common/CopyButton'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

type HistoryFilter = 'all' | 'completed' | 'failed' | 'cancelled' | 'running' | 'requires-restart'

export default function HistoryPage(): ReactNode {
  const historyQuery = useHistory(150)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailQuery = useTransaction(selectedId)

  const transactions = historyQuery.data ?? []

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return transactions.filter((record) => {
      if (filter !== 'all' && record.status !== filter) return false
      if (!query) return true
      return (
        record.packageName.toLowerCase().includes(query) ||
        record.packageId.includes(query) ||
        record.id.includes(query) ||
        record.version?.toLowerCase().includes(query) === true
      )
    })
  }, [transactions, search, filter])

  const stats = useMemo(
    () => ({
      completed: transactions.filter((record) => record.status === 'completed').length,
      failed: transactions.filter((record) => record.status === 'failed').length,
      cancelled: transactions.filter((record) => record.status === 'cancelled').length
    }),
    [transactions]
  )

  const logText = useMemo(() => {
    if (!detailQuery.data) return ''
    return detailQuery.data.logs
      .map(
        (log) =>
          `[${log.timestamp}] ${log.level.toUpperCase()} ${log.stage}: ${log.message}${
            log.stderr ? `\nSTDERR: ${log.stderr}` : ''
          }${log.stdout ? `\nSTDOUT: ${log.stdout}` : ''}`
      )
      .join('\n')
  }, [detailQuery.data])

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        eyebrow="Records"
        title="Installation History"
        description="Every transaction, stage and command executed by DevForge. Logs are written by the real processes that ran; failures stay visible after retries."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void historyQuery.refetch()}
            disabled={historyQuery.isFetching}
          >
            {historyQuery.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Summary label="Transactions" value={transactions.length} tone="neutral" />
        <Summary label="Completed" value={stats.completed} tone="success" />
        <Summary label="Failed" value={stats.failed} tone="destructive" />
        <Summary label="Cancelled" value={stats.cancelled} tone="warning" />
      </div>

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by package, version or transaction…"
            className="pl-9"
            aria-label="Search installation history"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={(value) => setFilter(value as HistoryFilter)}>
            <SelectTrigger className="h-8 w-[190px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="requires-restart">Restart required</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[11px] text-muted-foreground">
            {filtered.length} of {transactions.length}
          </span>
        </div>
      </div>

      {historyQuery.isError ? (
        <ErrorState error={historyQuery.error} onRetry={() => void historyQuery.refetch()} />
      ) : historyQuery.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : transactions.length === 0 ? (
        <EmptyState
          icon={<History />}
          title="No installation history"
          description="When DevForge installs, updates, verifies or removes software, the transaction and its logs are recorded here."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="No transactions match"
          description="Try another search term or a different status filter."
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
          <div className="hidden items-center gap-3 border-b border-border/70 px-4 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground lg:flex">
            <span className="w-[104px]">Status</span>
            <span className="flex-1">Package</span>
            <span className="w-24">Version</span>
            <span className="w-28">Method</span>
            <span className="w-[150px]">Started</span>
            <span className="w-[86px]">Duration</span>
            <span className="w-[72px]">Logs</span>
            <span className="w-[68px] text-right">Details</span>
          </div>
          <div className="divide-y divide-border/60">
            {filtered.map((record) => (
              <TransactionRow key={record.id} record={record} onSelect={() => setSelectedId(record.id)} />
            ))}
          </div>
        </Card>
      )}

      <Dialog
        open={Boolean(selectedId)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
      >
        <DialogContent className="max-w-4xl gap-0 p-0">
          <DialogHeader className="border-b border-border/70 p-6 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>
                {detailQuery.data?.packageName ?? 'Transaction details'}
              </DialogTitle>
              {detailQuery.data ? <StatusBadge status={detailQuery.data.status} /> : null}
            </div>
            <DialogDescription>
              {detailQuery.data ? (
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-[10px]">{detailQuery.data.id}</span>
                  <CopyButton value={detailQuery.data.id} />
                  <span>·</span>
                  <span>{detailQuery.data.version ?? 'no version'}</span>
                  <span>·</span>
                  <span>{methodLabels[detailQuery.data.method] ?? detailQuery.data.method}</span>
                  <span>·</span>
                  <span>{formatDateTime(detailQuery.data.startedAt)}</span>
                </span>
              ) : (
                'Loading transaction…'
              )}
            </DialogDescription>
          </DialogHeader>

          {detailQuery.isError ? (
            <div className="p-6">
              <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
            </div>
          ) : !detailQuery.data ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <>
              {detailQuery.data.errorMessage ? (
                <div className="mx-6 mt-4 rounded-lg border border-destructive/25 bg-destructive/5 px-3.5 py-2.5 text-[11px] leading-5 text-destructive">
                  <div className="flex items-center gap-1.5 font-medium">
                    <TriangleAlert className="size-3.5" />
                    {detailQuery.data.errorCode ?? 'ERROR'}
                  </div>
                  <p className="mt-0.5 text-muted-foreground">{detailQuery.data.errorMessage}</p>
                </div>
              ) : null}

              <Tabs defaultValue="logs" className="p-6 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <TabsList>
                    <TabsTrigger value="logs">
                      <Terminal className="mr-1 size-3" />
                      Logs ({detailQuery.data.logs.length})
                    </TabsTrigger>
                    <TabsTrigger value="environment">
                      <SlidersHorizontal className="mr-1 size-3" />
                      Environment ({detailQuery.data.envChanges.length})
                    </TabsTrigger>
                    <TabsTrigger value="verification">
                      <ShieldCheck className="mr-1 size-3" />
                      Verification
                    </TabsTrigger>
                  </TabsList>
                  {logText ? <CopyButton value={logText} label="Copy logs" size="sm" /> : null}
                </div>

                <TabsContent value="logs">
                  {detailQuery.data.logs.length === 0 ? (
                    <p className="py-8 text-center text-xs text-muted-foreground">No log entries were recorded.</p>
                  ) : (
                    <ScrollArea className="h-[48vh] rounded-lg border border-border/70">
                      <LogList logs={detailQuery.data.logs} />
                    </ScrollArea>
                  )}
                </TabsContent>

                <TabsContent value="environment">
                  {detailQuery.data.envChanges.length === 0 ? (
                    <p className="py-8 text-center text-xs text-muted-foreground">
                      This transaction did not modify environment variables.
                    </p>
                  ) : (
                    <ScrollArea className="h-[48vh] rounded-lg border border-border/70">
                      <div className="divide-y divide-border/60">
                        {detailQuery.data.envChanges.map((change) => (
                          <div key={change.id} className="px-4 py-3 text-[11px]">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono font-medium text-foreground/90">{change.name}</span>
                              <Badge variant="outline">{change.kind}</Badge>
                              <Badge variant="secondary">{change.changeType}</Badge>
                              <span className="ml-auto text-[10px] text-muted-foreground">
                                {formatDateTime(change.createdAt)}
                              </span>
                            </div>
                            <p className="mt-1.5 break-all font-mono text-[10px] leading-4 text-muted-foreground">
                              before: {change.previousValue ?? '(not set)'}
                            </p>
                            <p className="break-all font-mono text-[10px] leading-4 text-muted-foreground">
                              after: {change.newValue ?? '(removed)'}
                            </p>
                            {change.restoredAt ? (
                              <p className="mt-1 text-[10px] text-success">
                                Restored {formatDateTime(change.restoredAt)}
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </TabsContent>

                <TabsContent value="verification">
                  {!detailQuery.data.verification ? (
                    <p className="py-8 text-center text-xs text-muted-foreground">
                      No verification run is linked to this transaction.
                    </p>
                  ) : (
                    <ScrollArea className="h-[48vh] rounded-lg border border-border/70">
                      <div className="divide-y divide-border/60">
                        <div className="flex items-center justify-between px-4 py-3">
                          <div>
                            <p className="text-xs font-medium">Verification {detailQuery.data.verification.status}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {formatDateTime(detailQuery.data.verification.startedAt)}
                            </p>
                          </div>
                          <StatusBadge status={detailQuery.data.verification.status} />
                        </div>
                        {detailQuery.data.verification.checks.map((check) => (
                          <div key={check.id} className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {check.passed ? (
                                <CheckCircle2 className="size-3.5 text-success" />
                              ) : (
                                <TriangleAlert className="size-3.5 text-destructive" />
                              )}
                              <span className="text-xs font-medium">{check.label}</span>
                              {check.optional ? <Badge variant="outline">Optional</Badge> : null}
                            </div>
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground">{check.command}</p>
                            {check.error ? (
                              <p className="mt-1 text-[11px] text-destructive">{check.error}</p>
                            ) : check.output ? (
                              <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-secondary/30 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
                                {check.output}
                              </pre>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TransactionRow({ record, onSelect }: { record: TransactionRecord; onSelect: () => void }): ReactNode {
  const duration = formatDuration(record.startedAt, record.finishedAt)
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full flex-col gap-2 px-4 py-2.5 text-left transition-colors hover:bg-secondary/20 lg:flex-row lg:items-center lg:gap-3"
    >
      <div className="w-[104px] shrink-0">
        <StatusBadge status={record.status} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{record.packageName}</p>
        <p className="truncate text-[10px] text-muted-foreground">{record.packageId}</p>
      </div>
      <div className="w-24 shrink-0 font-mono text-[10px] text-muted-foreground">{record.version ?? '—'}</div>
      <div className="w-28 shrink-0 text-[10px] text-muted-foreground">
        {methodLabels[record.method] ?? record.method}
      </div>
      <div className="w-[150px] shrink-0 text-[10px] text-muted-foreground">{formatDateTime(record.startedAt)}</div>
      <div className="w-[86px] shrink-0 font-mono text-[10px] text-muted-foreground">{duration}</div>
      <div className="w-[72px] shrink-0 text-[10px] text-muted-foreground">{record.logCount} entries</div>
      <div className="flex w-[68px] shrink-0 justify-end">
        <span className="inline-flex items-center gap-0.5 text-[10px] text-primary">
          View
          <ChevronRight className="size-3" />
        </span>
      </div>
    </button>
  )
}

function LogList({ logs }: { logs: LogEntry[] }): ReactNode {
  return (
    <div className="divide-y divide-border/50">
      {logs.map((log) => (
        <details key={log.id} className="group px-4 py-2 open:bg-secondary/10">
          <summary className="flex cursor-pointer list-none items-start gap-2 text-[11px]">
            <span
              className={
                log.level === 'error'
                  ? 'mt-0.5 inline-flex w-12 shrink-0 justify-center rounded border border-destructive/25 bg-destructive/10 px-1 py-px text-[9px] uppercase text-destructive'
                  : log.level === 'warn'
                    ? 'mt-0.5 inline-flex w-12 shrink-0 justify-center rounded border border-warning/25 bg-warning/10 px-1 py-px text-[9px] uppercase text-warning'
                    : 'mt-0.5 inline-flex w-12 shrink-0 justify-center rounded border border-border bg-secondary/40 px-1 py-px text-[9px] uppercase text-muted-foreground'
              }
            >
              {log.level}
            </span>
            <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground/70">{formatTime(log.timestamp)}</span>
            <span className="w-24 shrink-0 truncate font-mono text-[10px] text-primary/80">{log.stage}</span>
            <span className="min-w-0 flex-1 break-words text-foreground/85">{log.message}</span>
            <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground/40 transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-2 space-y-1.5 pl-[72px]">
            {log.command ? (
              <p className="break-all font-mono text-[10px] text-foreground/70">
                {log.command} {log.args?.join(' ')}
              </p>
            ) : null}
            {log.exitCode !== null ? (
              <p className="text-[10px] text-muted-foreground">
                Exit code: <span className="font-mono text-foreground/80">{log.exitCode}</span>
              </p>
            ) : null}
            {log.stdout ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
                {log.stdout}
              </pre>
            ) : null}
            {log.stderr ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-destructive/20 bg-destructive/5 p-2 font-mono text-[10px] leading-4 text-destructive/90">
                {log.stderr}
              </pre>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  )
}

function Summary({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone: 'neutral' | 'success' | 'destructive' | 'warning'
}): ReactNode {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'destructive'
        ? 'text-destructive'
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
