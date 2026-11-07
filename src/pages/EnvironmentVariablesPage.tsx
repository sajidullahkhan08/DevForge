import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
  Trash2,
  Wrench
} from 'lucide-react'
import type {
  DoctorAction,
  EnvBackup,
  EnvPreview,
  EnvScope,
  EnvVariable,
  EnvironmentMutation,
  HealthCheck,
  PathEntry
} from '@shared/types'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative, truncate } from '@/lib/format'
import { notifyError, notifyInfo, notifySuccess } from '@/lib/feedback'
import {
  queryKeys,
  useEnvironmentBackups,
  useEnvironmentVariables,
  useSystemInfo
} from '@/hooks/useData'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/common/StatusBadge'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { HealthList } from '@/components/common/HealthList'
import { CopyButton } from '@/components/common/CopyButton'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

function isSensitive(name: string): boolean {
  return /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name)
}

export default function EnvironmentVariablesPage(): ReactNode {
  const queryClient = useQueryClient()
  const { data: info } = useSystemInfo()
  const variablesQuery = useEnvironmentVariables()
  const backupsQuery = useEnvironmentBackups()
  const [scope, setScope] = useState<EnvScope>('user')
  const [search, setSearch] = useState('')
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [variableDialog, setVariableDialog] = useState<{ mode: 'create' | 'edit'; variable: EnvVariable | null } | null>(null)
  const [pathDialogOpen, setPathDialogOpen] = useState(false)
  const [removeVariable, setRemoveVariable] = useState<EnvVariable | null>(null)
  const [removeEntry, setRemoveEntry] = useState<PathEntry | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<EnvBackup | null>(null)
  const [health, setHealth] = useState<HealthCheck[] | null>(null)
  const [doctorAction, setDoctorAction] = useState<DoctorAction | null>(null)
  const [doctorPreview, setDoctorPreview] = useState<EnvPreview | null>(null)

  const userPathQuery = useQuery({
    queryKey: ['env-path', 'user'],
    queryFn: () => api.environment.pathEntries('user', 'Path'),
    staleTime: 10_000
  })
  const systemPathQuery = useQuery({
    queryKey: ['env-path', 'system'],
    queryFn: () => api.environment.pathEntries('system', 'Path'),
    staleTime: 10_000
  })

  const variables = variablesQuery.data ?? []
  const scopedVariables = useMemo(
    () =>
      variables
        .filter((variable) => variable.scope === scope && variable.kind !== 'path')
        .filter((variable) => {
          const query = search.trim().toLowerCase()
          if (!query) return true
          return variable.name.toLowerCase().includes(query) || variable.value.toLowerCase().includes(query)
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    [variables, scope, search]
  )

  const pathQuery = scope === 'user' ? userPathQuery : systemPathQuery
  const pathEntries = pathQuery.data ?? []
  const duplicateCount = pathEntries.filter((entry) => entry.duplicate).length
  const missingCount = pathEntries.filter((entry) => !entry.exists).length

  const invalidateEnvironment = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.environment })
    void queryClient.invalidateQueries({ queryKey: queryKeys.environmentBackups })
    void queryClient.invalidateQueries({ queryKey: ['env-path'] })
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
  }

  const removeVariableMutation = useMutation({
    mutationFn: (variable: EnvVariable) =>
      api.environment.apply([
        { action: 'remove-variable', scope: variable.scope, name: variable.name }
      ]),
    onSuccess: (preview) => {
      invalidateEnvironment()
      notifySuccess('Variable removed', `${preview.changes.length} environment change(s) applied with a backup.`)
      setRemoveVariable(null)
    },
    onError: notifyError
  })

  const removePathMutation = useMutation({
    mutationFn: (entry: PathEntry) =>
      api.environment.apply([{ action: 'remove-path', scope, entries: [entry.raw] }]),
    onSuccess: (preview) => {
      invalidateEnvironment()
      notifySuccess('PATH entry removed', `${preview.changes.length} environment change(s) applied with a backup.`)
      setRemoveEntry(null)
    },
    onError: notifyError
  })

  const restoreMutation = useMutation({
    mutationFn: (backupId: number) => api.environment.restore(backupId),
    onSuccess: (result) => {
      invalidateEnvironment()
      if (result.success) {
        notifySuccess('Backup restored', result.message)
      } else {
        notifyError(result.message)
      }
      setRestoreTarget(null)
    },
    onError: notifyError
  })

  const refreshMutation = useMutation({
    mutationFn: () => api.environment.refreshEnvironment(),
    onSuccess: (result) => {
      invalidateEnvironment()
      notifyInfo(result.refreshed ? 'Environment refresh requested' : 'Refresh not available', result.message)
    },
    onError: notifyError
  })

  const validateMutation = useMutation({
    mutationFn: () => api.environment.validate(),
    onSuccess: (checks) => setHealth(checks),
    onError: notifyError
  })

  const doctorQuery = useQuery({
    queryKey: ['env-doctor'],
    queryFn: () => api.environment.doctor(),
    staleTime: 30_000
  })

  const doctorPreviewMutation = useMutation({
    mutationFn: (action: DoctorAction) => api.environment.preview(action.mutations),
    onSuccess: (preview, action) => {
      setDoctorAction(action)
      setDoctorPreview(preview)
    },
    onError: notifyError
  })

  const doctorApplyMutation = useMutation({
    mutationFn: (action: DoctorAction) => api.environment.apply(action.mutations),
    onSuccess: (preview) => {
      invalidateEnvironment()
      void queryClient.invalidateQueries({ queryKey: ['env-doctor'] })
      notifySuccess(
        'Environment fixed',
        `${preview.changes.length} targeted change(s) applied and recorded in backups.`
      )
      setDoctorAction(null)
      setDoctorPreview(null)
    },
    onError: notifyError
  })

  const toggleReveal = (key: string): void => {
    setRevealed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const backups = backupsQuery.data ?? []
  const canEditSystem = scope === 'user' || Boolean(info?.isElevated)

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        eyebrow="Manage"
        title="Environment Variables"
        description="Inspect and change user or system environment variables with targeted previews and backups. DevForge never overwrites the entire PATH."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => validateMutation.mutate()}
              disabled={validateMutation.isPending}
            >
              {validateMutation.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Validate
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
            >
              {refreshMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh processes
            </Button>
            <Button
              size="sm"
              onClick={() => setVariableDialog({ mode: 'create', variable: null })}
              disabled={!canEditSystem}
            >
              <Plus />
              Add variable
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={scope} onValueChange={(value) => setScope(value as EnvScope)}>
          <TabsList>
            <TabsTrigger value="user">User variables</TabsTrigger>
            <TabsTrigger value="system">System variables</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full max-w-xs">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search variables…"
            className="h-8 text-xs"
            aria-label="Search environment variables"
          />
        </div>
      </div>

      {scope === 'system' && !info?.isElevated ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3.5 py-2.5 text-[11px] leading-5 text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            System variables require an elevated operation. DevForge runs as a standard user; applying a system change
            will only succeed if Windows grants the required permission. Review the preview before applying.
          </span>
        </div>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
              <Stethoscope className="size-4" />
            </span>
            <div>
              <CardTitle>Environment doctor</CardTitle>
              <CardDescription className="mt-1">
                Guided, reversible fixes for duplicate PATH entries and stale variables. Every fix is previewed before
                anything is written.
              </CardDescription>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={doctorQuery.data?.actions.length ? 'warning' : 'success'}>
              {doctorQuery.data?.actions.length ?? 0} fix(es)
            </Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Scan the environment again"
              aria-label="Scan the environment again"
              onClick={() => void doctorQuery.refetch()}
              disabled={doctorQuery.isFetching}
            >
              <RefreshCw className={doctorQuery.isFetching ? 'animate-spin' : undefined} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {doctorQuery.isError ? (
            <div className="px-5 pb-5">
              <ErrorState error={doctorQuery.error} onRetry={() => void doctorQuery.refetch()} />
            </div>
          ) : doctorQuery.isLoading ? (
            <div className="space-y-2 px-5 pb-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (doctorQuery.data?.actions.length ?? 0) === 0 &&
            (doctorQuery.data?.warnings.length ?? 0) === 0 ? (
            <div className="flex items-center gap-2 px-5 py-4 text-[11px] text-success">
              <CheckCircle2 className="size-3.5" />
              No environment problems were detected.
            </div>
          ) : (
            <div className="divide-y divide-border/60 border-t border-border/60">
              {(doctorQuery.data?.actions ?? []).map((action) => (
                <div key={action.id} className="flex items-start gap-3 px-5 py-3">
                  <Wrench className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-xs font-medium">{action.label}</p>
                      <Badge variant="outline">{action.scope}</Badge>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{action.description}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => doctorPreviewMutation.mutate(action)}
                    disabled={doctorPreviewMutation.isPending || doctorApplyMutation.isPending}
                  >
                    {doctorPreviewMutation.isPending && doctorPreviewMutation.variables?.id === action.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Wrench />
                    )}
                    Review fix
                  </Button>
                </div>
              ))}
              {(doctorQuery.data?.warnings ?? []).map((warning) => (
                <div
                  key={warning}
                  className="flex items-start gap-2 px-5 py-2.5 text-[11px] leading-4 text-muted-foreground"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle>{scope === 'user' ? 'User' : 'System'} variables</CardTitle>
            <CardDescription>Values marked as managed were added or updated by DevForge.</CardDescription>
          </div>
          <Badge variant="outline">{scopedVariables.length}</Badge>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {variablesQuery.isError ? (
            <div className="px-5 pb-5">
              <ErrorState error={variablesQuery.error} onRetry={() => void variablesQuery.refetch()} />
            </div>
          ) : variablesQuery.isLoading ? (
            <div className="space-y-2 px-5 pb-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : scopedVariables.length === 0 ? (
            <EmptyState
              icon={<KeyRound />}
              title={search ? 'No variables match' : 'No variables in this scope'}
              description={search ? 'Try a different search term.' : 'DevForge will list variables reported by Windows for this scope.'}
              className="mx-5 mb-5 border-0 bg-transparent py-8"
            />
          ) : (
            <div className="divide-y divide-border/60">
              <div className="hidden items-center gap-3 px-5 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground md:flex">
                <span className="w-[220px]">Name</span>
                <span className="flex-1">Value</span>
                <span className="w-[104px]">Managed</span>
                <span className="w-[88px]">Updated</span>
                <span className="w-[80px] text-right">Actions</span>
              </div>
              {scopedVariables.map((variable) => {
                const sensitive = isSensitive(variable.name)
                const key = `${variable.scope}-${variable.name}`
                const showValue = !sensitive || revealed.has(key)
                return (
                  <div key={key} className="flex flex-col gap-2 px-5 py-2.5 hover:bg-secondary/20 md:flex-row md:items-center md:gap-3">
                    <div className="w-[220px] shrink-0">
                      <p className="font-mono text-[11px] text-foreground/90">{variable.name}</p>
                      <p className="text-[10px] text-muted-foreground">{variable.scope} scope</p>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      <span className="min-w-0 flex-1 break-all font-mono text-[10px] leading-4 text-muted-foreground">
                        {showValue ? truncate(variable.value, 150) : '••••••••••••••••'}
                      </span>
                      {sensitive ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={showValue ? 'Hide value' : 'Reveal value'}
                          onClick={() => toggleReveal(key)}
                        >
                          {showValue ? <EyeOff /> : <Eye />}
                        </Button>
                      ) : null}
                      <CopyButton value={variable.value} />
                    </div>
                    <div className="w-[104px] shrink-0">
                      {variable.managedByDevForge ? (
                        <Badge variant="success">DevForge</Badge>
                      ) : (
                        <Badge variant="muted">External</Badge>
                      )}
                    </div>
                    <div className="w-[88px] shrink-0 text-[10px] text-muted-foreground">
                      {variable.updatedAt ? formatRelative(variable.updatedAt) : '—'}
                    </div>
                    <div className="flex w-[80px] shrink-0 justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Edit variable"
                        onClick={() => setVariableDialog({ mode: 'edit', variable })}
                        disabled={!canEditSystem}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Remove variable"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setRemoveVariable(variable)}
                        disabled={!canEditSystem}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle>PATH · {scope === 'user' ? 'user' : 'system'}</CardTitle>
            <CardDescription>
              Ordered entries exactly as reported by Windows. Existing entries are preserved; DevForge only adds,
              removes or deduplicates targeted entries.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {duplicateCount > 0 ? <Badge variant="warning">{duplicateCount} duplicate(s)</Badge> : null}
            {missingCount > 0 ? <Badge variant="outline">{missingCount} missing</Badge> : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPathDialogOpen(true)}
              disabled={!canEditSystem}
            >
              <Plus />
              Add entry
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {pathQuery.isError ? (
            <div className="px-5 pb-5">
              <ErrorState error={pathQuery.error} onRetry={() => void pathQuery.refetch()} />
            </div>
          ) : pathQuery.isLoading ? (
            <div className="space-y-2 px-5 pb-5">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : pathEntries.length === 0 ? (
            <EmptyState
              icon={<SlidersHorizontal />}
              title="PATH is empty for this scope"
              description="No PATH entries were reported. Add an entry only if you know it is needed."
              className="mx-5 mb-5 border-0 bg-transparent py-8"
            />
          ) : (
            <div className="divide-y divide-border/60">
              {pathEntries.map((entry) => (
                <div key={`${entry.index}-${entry.raw}`} className="flex items-start gap-3 px-5 py-2.5 hover:bg-secondary/20">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border border-border bg-secondary/40 font-mono text-[9px] text-muted-foreground">
                    {entry.index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-mono text-[10px] leading-4 text-foreground/85">{entry.raw}</p>
                    {entry.resolved !== entry.raw ? (
                      <p className="break-all font-mono text-[10px] leading-4 text-muted-foreground">
                        → {entry.resolved}
                      </p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant={entry.exists ? 'success' : 'warning'}>{entry.exists ? 'Exists' : 'Missing'}</Badge>
                      {entry.duplicate ? <Badge variant="warning">Duplicate</Badge> : null}
                      {entry.managed ? <Badge variant="default">Managed</Badge> : <Badge variant="muted">External</Badge>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <CopyButton value={entry.raw} />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Remove this PATH entry"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setRemoveEntry(entry)}
                      disabled={!canEditSystem}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle>Environment backups</CardTitle>
            <CardDescription>
              Every applied change saves a targeted backup. Restoring reverts only the stored entries, never the whole
              PATH.
            </CardDescription>
          </div>
          <Badge variant="outline">{backups.length}</Badge>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {backupsQuery.isError ? (
            <div className="px-5 pb-5">
              <ErrorState error={backupsQuery.error} onRetry={() => void backupsQuery.refetch()} />
            </div>
          ) : backupsQuery.isLoading ? (
            <div className="space-y-2 px-5 pb-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : backups.length === 0 ? (
            <EmptyState
              icon={<RotateCcw />}
              title="No environment backups yet"
              description="Backups are created automatically before DevForge changes a variable or PATH entry."
              className="mx-5 mb-5 border-0 bg-transparent py-8"
            />
          ) : (
            <div className="max-h-[360px] overflow-y-auto">
              <div className="sticky top-0 z-10 hidden items-center gap-3 border-b border-border/70 bg-card px-5 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground md:flex">
                <span className="w-[150px]">Variable</span>
                <span className="w-[120px]">Change</span>
                <span className="flex-1">Previous → new</span>
                <span className="w-[92px]">Package</span>
                <span className="w-[104px]">Created</span>
                <span className="w-[100px] text-right">Action</span>
              </div>
              <div className="divide-y divide-border/60">
                {backups.map((backup) => (
                  <div key={backup.id} className="flex flex-col gap-2 px-5 py-2.5 hover:bg-secondary/20 md:flex-row md:items-center md:gap-3">
                    <div className="w-[150px] shrink-0">
                      <p className="truncate font-mono text-[10px] text-foreground/90">{backup.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {backup.kind === 'path' ? 'PATH' : 'Variable'} · {backup.scope}
                      </p>
                    </div>
                    <div className="w-[120px] shrink-0">
                      <Badge variant="outline">{backup.changeType}</Badge>
                    </div>
                    <div className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">
                      <p className="break-all">prev: {truncate(backup.previousValue, 84)}</p>
                      <p className="break-all">new: {truncate(backup.newValue, 84)}</p>
                      {backup.restoredAt ? (
                        <p className="text-success">restored {formatRelative(backup.restoredAt)}</p>
                      ) : null}
                    </div>
                    <div className="w-[92px] shrink-0 truncate text-[10px] text-muted-foreground">
                      {backup.packageName ?? 'Manual'}
                    </div>
                    <div className="w-[104px] shrink-0 text-[10px] text-muted-foreground">
                      {formatDateTime(backup.createdAt)}
                    </div>
                    <div className="flex w-[100px] shrink-0 justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRestoreTarget(backup)}
                        disabled={Boolean(backup.restoredAt)}
                      >
                        <RotateCcw />
                        Restore
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-card/50 px-3.5 py-3 text-[11px] leading-5 text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span>
          Changes to user environment variables are broadcast to Windows after applying, but already-open terminals
          keep their existing environment. Open a new terminal to see updates. System-scope changes may require
          elevation and are not applied silently.
        </span>
      </div>

      <Dialog
        open={Boolean(doctorAction && doctorPreview)}
        onOpenChange={(open) => {
          if (open) return
          if (doctorApplyMutation.isPending) return
          setDoctorAction(null)
          setDoctorPreview(null)
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{doctorAction?.label ?? 'Review environment fix'}</DialogTitle>
            <DialogDescription>
              DevForge prepared {doctorPreview?.changes.length ?? 0} targeted change(s). Nothing has been written yet,
              and a backup is created for every change.
            </DialogDescription>
          </DialogHeader>
          {doctorPreview && doctorPreview.errors.length > 0 ? (
            <div className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[11px] leading-5 text-destructive">
              {doctorPreview.errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          ) : (
            <div className="max-h-[42vh] space-y-2 overflow-y-auto">
              {(doctorPreview?.changes ?? []).map((change, index) => (
                <div
                  key={`${change.scope}-${change.name}-${index}`}
                  className="rounded-lg border border-border/70 bg-secondary/20 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] text-foreground/90">{change.name}</span>
                    <Badge variant="outline">{change.operation}</Badge>
                    <Badge variant="muted">{change.scope}</Badge>
                  </div>
                  {change.removedEntries.length > 0 ? (
                    <p className="mt-1 break-all text-[10px] leading-4 text-muted-foreground">
                      removing: {change.removedEntries.join('; ')}
                    </p>
                  ) : null}
                  <p className="mt-1 break-all text-[10px] leading-4 text-muted-foreground">
                    before: {truncate(change.before, 120)}
                  </p>
                  <p className="break-all text-[10px] leading-4 text-muted-foreground">
                    after: {truncate(change.after, 120)}
                  </p>
                </div>
              ))}
              {doctorPreview && doctorPreview.warnings.length > 0 ? (
                <div className="space-y-1 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[10px] leading-4 text-warning">
                  {doctorPreview.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDoctorAction(null)
                setDoctorPreview(null)
              }}
              disabled={doctorApplyMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => doctorAction && doctorApplyMutation.mutate(doctorAction)}
              disabled={!doctorPreview?.canApply || doctorApplyMutation.isPending}
            >
              {doctorApplyMutation.isPending ? <Loader2 className="animate-spin" /> : <Wrench />}
              Apply fix
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VariableDialog
        open={Boolean(variableDialog)}
        onOpenChange={(open) => !open && setVariableDialog(null)}
        mode="variable"
        scope={scope}
        existing={variableDialog?.variable ?? null}
        onApplied={invalidateEnvironment}
      />

      <VariableDialog
        open={pathDialogOpen}
        onOpenChange={setPathDialogOpen}
        mode="path"
        scope={scope}
        existing={null}
        onApplied={invalidateEnvironment}
      />

      <ConfirmDialog
        open={Boolean(removeVariable)}
        onOpenChange={(open) => !open && setRemoveVariable(null)}
        title={`Remove ${removeVariable?.name ?? 'variable'}?`}
        description="The variable will be removed from the selected scope. A targeted backup is stored first, and you can restore it later."
        confirmLabel="Remove variable"
        destructive
        loading={removeVariableMutation.isPending}
        onConfirm={() => removeVariable && removeVariableMutation.mutate(removeVariable)}
      >
        {removeVariable ? (
          <div className="rounded-lg border border-border/70 bg-secondary/25 px-3 py-2.5 text-[11px]">
            <p className="font-mono text-foreground/80">{removeVariable.name}</p>
            <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
              {truncate(removeVariable.value, 140)}
            </p>
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(removeEntry)}
        onOpenChange={(open) => !open && setRemoveEntry(null)}
        title="Remove this PATH entry?"
        description={
          removeEntry?.managed
            ? 'This entry is managed by DevForge. Removing it affects only this exact entry and other PATH entries are preserved.'
            : 'This entry was not added by DevForge. Removing it affects only this exact entry and other PATH entries are preserved.'
        }
        confirmLabel="Remove entry"
        destructive
        loading={removePathMutation.isPending}
        onConfirm={() => removeEntry && removePathMutation.mutate(removeEntry)}
      >
        {removeEntry ? (
          <div className="rounded-lg border border-border/70 bg-secondary/25 px-3 py-2.5">
            <p className="break-all font-mono text-[10px] text-foreground/85">{removeEntry.raw}</p>
            {!removeEntry.exists ? (
              <p className="mt-1 text-[10px] text-warning">This directory does not currently exist.</p>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(restoreTarget)}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Restore this environment backup?"
        description="DevForge will re-apply the stored previous value for this variable without replacing unrelated current changes. Review the restored result in the activity log."
        confirmLabel="Restore backup"
        loading={restoreMutation.isPending}
        onConfirm={() => restoreTarget && restoreMutation.mutate(restoreTarget.id)}
      >
        {restoreTarget ? (
          <div className="space-y-1 rounded-lg border border-border/70 bg-secondary/25 px-3 py-2.5 text-[11px]">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Variable</span>
              <span className="font-mono text-foreground/85">{restoreTarget.name}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Scope</span>
              <span className="text-foreground/85">{restoreTarget.scope}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Created</span>
              <span className="text-foreground/85">{formatDateTime(restoreTarget.createdAt)}</span>
            </div>
          </div>
        ) : null}
      </ConfirmDialog>

      <Dialog open={Boolean(health)} onOpenChange={(open) => !open && setHealth(null)}>
        <DialogContent className="max-w-xl gap-0 p-0">
          <DialogHeader className="border-b border-border/70 p-6 pb-4">
            <DialogTitle>Environment validation</DialogTitle>
            <DialogDescription>
              Real checks performed against the current user and system environment.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] overflow-y-auto p-6">
            {health && health.length === 0 ? (
              <div className="flex items-center gap-3 rounded-lg border border-success/20 bg-success/5 px-3.5 py-3">
                <CheckCircle2 className="size-4 shrink-0 text-success" />
                <div>
                  <p className="text-xs font-medium text-success">All checks passed</p>
                  <p className="text-[11px] text-muted-foreground">No environment problems were detected.</p>
                </div>
              </div>
            ) : (
              <HealthList checks={health ?? []} />
            )}
          </div>
          <DialogFooter className="border-t border-border/70 p-4">
            <Button onClick={() => setHealth(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface VariableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'variable' | 'path'
  scope: EnvScope
  existing: EnvVariable | null
  onApplied: () => void
}

function VariableDialog({ open, onOpenChange, mode, scope, existing, onApplied }: VariableDialogProps): ReactNode {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [pathEntry, setPathEntry] = useState('')
  const [strategy, setStrategy] = useState<'append' | 'prepend'>('append')
  const [step, setStep] = useState<'form' | 'preview'>('form')
  const [preview, setPreview] = useState<EnvPreview | null>(null)
  const [pendingMutation, setPendingMutation] = useState<EnvironmentMutation | null>(null)

  useEffect(() => {
    if (!open) return
    setName(existing?.name ?? '')
    setValue(existing?.value ?? '')
    setPathEntry('')
    setStrategy('append')
    setStep('form')
    setPreview(null)
    setPendingMutation(null)
  }, [open, existing])

  const previewMutation = useMutation({
    mutationFn: (mutation: EnvironmentMutation) => api.environment.preview([mutation]),
    onSuccess: (result) => {
      setPreview(result)
      setStep('preview')
    },
    onError: notifyError
  })

  const applyMutation = useMutation({
    mutationFn: (mutation: EnvironmentMutation) => api.environment.apply([mutation]),
    onSuccess: (result) => {
      notifySuccess(
        existing ? 'Environment variable updated' : mode === 'path' ? 'PATH entry added' : 'Environment variable created',
        `${result.changes.length} change(s) applied and recorded in backups.`
      )
      setPreview(result)
      onApplied()
      onOpenChange(false)
    },
    onError: notifyError
  })

  const readOnlyName = Boolean(existing)

  const buildMutation = (): EnvironmentMutation | null => {
    if (mode === 'path') {
      const entry = pathEntry.trim()
      if (!entry) {
        notifyError('Enter a directory path to add.')
        return null
      }
      return { action: 'add-path', scope, entries: [entry], strategy }
    }
    if (!/^[A-Za-z_][A-Za-z0-9_()]*$/.test(name.trim())) {
      notifyError('Variable names must start with a letter or underscore and contain only letters, numbers, underscores or parentheses.')
      return null
    }
    if (!value.trim()) {
      notifyError('Enter a value for the variable.')
      return null
    }
    return { action: 'set-variable', scope, name: name.trim(), value }
  }

  const handleReview = (): void => {
    const mutation = buildMutation()
    if (!mutation) return
    setPendingMutation(mutation)
    previewMutation.mutate(mutation)
  }

  const busy = previewMutation.isPending || applyMutation.isPending

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="border-b border-border/70 p-6 pb-4">
          <DialogTitle>
            {step === 'preview'
              ? 'Review environment change'
              : mode === 'path'
                ? existing
                  ? 'Edit PATH entry'
                  : 'Add PATH entry'
                : existing
                  ? 'Edit environment variable'
                  : 'Create environment variable'}
          </DialogTitle>
          <DialogDescription>
            {step === 'preview'
              ? 'DevForge prepared targeted changes. Nothing has been written yet.'
              : `Scope: ${scope === 'user' ? 'current user' : 'all users (system)'}. Existing unrelated entries are preserved.`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[56vh] overflow-y-auto p-6">
          {step === 'form' ? (
            <div className="space-y-4">
              {mode === 'variable' ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="env-name">Name</Label>
                    <Input
                      id="env-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="MY_TOOL_HOME"
                      disabled={readOnlyName}
                      className="font-mono"
                      maxLength={120}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="env-value">Value</Label>
                    <Input
                      id="env-value"
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      placeholder="C:\DevForge\Tools\MyTool"
                      className="font-mono"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="path-entry">Directory path</Label>
                    <Input
                      id="path-entry"
                      value={pathEntry}
                      onChange={(event) => setPathEntry(event.target.value)}
                      placeholder="C:\DevForge\Tools\mytool\bin"
                      className="font-mono"
                    />
                    <p className="text-[10px] leading-4 text-muted-foreground">
                      Environment variables in the path such as <span className="font-mono">%USERPROFILE%</span> are
                      preserved exactly as entered.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="path-strategy">Position</Label>
                    <Select value={strategy} onValueChange={(next) => setStrategy(next as 'append' | 'prepend')}>
                      <SelectTrigger id="path-strategy">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="append">Append to the end of PATH</SelectItem>
                        <SelectItem value="prepend">Prepend to the start of PATH</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] leading-4 text-muted-foreground">
                      Appending is recommended unless the tool must shadow another installation.
                    </p>
                  </div>
                </>
              )}
              <div className="flex items-start gap-2 rounded-lg bg-secondary/30 px-3 py-2.5 text-[10px] leading-4 text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                A targeted backup is created automatically before the change is applied. You can preview the exact
                difference in the next step.
              </div>
            </div>
          ) : preview ? (
            <div className="space-y-3">
              {preview.changes.map((change, index) => (
                <div key={index} className="rounded-lg border border-border/70 bg-secondary/20 px-3 py-2.5 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-medium text-foreground/90">{change.name}</span>
                    <Badge variant={change.operation === 'noop' ? 'muted' : 'success'}>{change.operation}</Badge>
                  </div>
                  {change.before !== null || change.after !== null ? (
                    <div className="mt-1.5 space-y-1 font-mono text-[10px] leading-4 text-muted-foreground">
                      <p className="break-all">
                        <span className="text-muted-foreground/70">before: </span>
                        {change.before ?? '(not set)'}
                      </p>
                      <p className="break-all">
                        <span className="text-muted-foreground/70">after: </span>
                        {change.after ?? '(removed)'}
                      </p>
                    </div>
                  ) : null}
                  {change.addedEntries.length > 0 ? (
                    <p className="mt-1 break-all font-mono text-[10px] text-success">+ {change.addedEntries.join('; ')}</p>
                  ) : null}
                  {change.removedEntries.length > 0 ? (
                    <p className="mt-1 break-all font-mono text-[10px] text-destructive">
                      − {change.removedEntries.join('; ')}
                    </p>
                  ) : null}
                  {change.reason ? <p className="mt-1 text-[10px] text-muted-foreground">{change.reason}</p> : null}
                </div>
              ))}
              {preview.warnings.map((warning, index) => (
                <div
                  key={index}
                  className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[11px] leading-4 text-warning"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {warning}
                </div>
              ))}
              {preview.errors.map((error, index) => (
                <div
                  key={index}
                  className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] leading-4 text-destructive"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {error}
                </div>
              ))}
              {preview.requiresAdmin ? (
                <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[11px] leading-4 text-warning">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                  This change targets the machine-wide environment and may require administrator permission. If
                  Windows denies the change, DevForge reports the failure instead of claiming success.
                </div>
              ) : null}
              <p className="text-[10px] text-muted-foreground">
                {preview.changes.length} targeted change(s). Unrelated environment entries are never replaced.
              </p>
            </div>
          ) : null}
        </div>

        <Separator />
        <DialogFooter className="p-4">
          {step === 'preview' ? (
            <>
              <Button variant="ghost" onClick={() => setStep('form')} disabled={busy}>
                Back
              </Button>
              <Button
                onClick={() => pendingMutation && applyMutation.mutate(pendingMutation)}
                disabled={!preview?.canApply || busy}
              >
                {applyMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                Apply changes
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={handleReview} disabled={busy}>
                {previewMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                Preview changes
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
