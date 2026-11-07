import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Boxes,
  Download,
  HardDrive,
  Info,
  ListPlus,
  Loader2,
  Play,
  RotateCcw,
  ShieldAlert,
  TriangleAlert
} from 'lucide-react'
import type { InstallRequest } from '@shared/types'
import { api } from '@/lib/api'
import { queryKeys } from '@/hooks/useData'
import { formatBytes, humanize, methodLabels } from '@/lib/format'
import { notifyError, notifySuccess } from '@/lib/feedback'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from './ErrorState'

interface PlanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  requests: InstallRequest[]
  onQueued?: () => void
}

export function PlanDialog({ open, onOpenChange, requests, onQueued }: PlanDialogProps): ReactNode {
  const queryClient = useQueryClient()
  const planKey = ['plan', requests.map((request) => `${request.packageId}@${request.version ?? 'latest'}`).join('|')]

  const planQuery = useQuery({
    queryKey: planKey,
    queryFn: () => api.plans.preview(requests),
    enabled: open && requests.length > 0,
    staleTime: 0,
    retry: false
  })

  const enqueueMutation = useMutation({
    mutationFn: async (mode: 'queue' | 'start') => {
      const result = await api.queue.enqueue(requests)
      const queue = mode === 'start' ? await api.queue.start() : result.queue
      return { result, queue, mode }
    },
    onSuccess: ({ queue, mode }) => {
      queryClient.setQueryData(queryKeys.queue, queue)
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
      void queryClient.invalidateQueries({ queryKey: queryKeys.installations })
      notifySuccess(
        mode === 'start' ? 'Installation started' : 'Added to the installation queue',
        mode === 'start'
          ? 'Track real progress in the Installation Queue.'
          : 'Open the Installation Queue to start the operation.'
      )
      onOpenChange(false)
      onQueued?.()
    },
    onError: notifyError
  })

  const plan = planQuery.data
  const installable =
    plan?.steps.filter(
      (step) => step.action === 'install' || step.action === 'upgrade' || step.action === 'configure'
    ) ?? []
  const onlyConfiguration = installable.length > 0 && installable.every((step) => step.action === 'configure')
  const hasErrors = Boolean(plan && plan.errors.length > 0)
  const canEnqueue = Boolean(plan) && !hasErrors && installable.length > 0 && !enqueueMutation.isPending
  const busy = enqueueMutation.isPending

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-2xl gap-0 p-0">
        <DialogHeader className="border-b border-border/70 p-6 pb-4">
          <DialogTitle>Review installation plan</DialogTitle>
          <DialogDescription>
            DevForge resolves dependencies and validates the operation before anything is downloaded or executed.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[54vh] overflow-y-auto p-6">
          {planQuery.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : planQuery.isError ? (
            <ErrorState error={planQuery.error} onRetry={() => void planQuery.refetch()} />
          ) : plan ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <PlanMetric icon={<Boxes />} label="Steps" value={String(plan.steps.length)} />
                <PlanMetric
                  icon={<Download />}
                  label="Download"
                  value={plan.totalEstimatedSizeBytes > 0 ? formatBytes(plan.totalEstimatedSizeBytes) : 'Unknown'}
                />
                <PlanMetric icon={<HardDrive />} label="Disk free" value={formatBytes(plan.diskFreeBytes)} />
                <PlanMetric
                  icon={<ShieldAlert />}
                  label="Elevation"
                  value={plan.requiresAdmin ? 'Required' : 'Not required'}
                />
              </div>

              {plan.errors.length > 0 ? (
                <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-xs font-medium text-destructive">
                    <TriangleAlert className="size-3.5" />
                    This plan cannot be started
                  </div>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                    {plan.errors.map((error, index) => (
                      <li key={index}>{error}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {plan.warnings.length > 0 ? (
                <div className="rounded-lg border border-warning/25 bg-warning/5 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-xs font-medium text-warning">
                    <Info className="size-3.5" />
                    Notes
                  </div>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                    {plan.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Execution order
                </p>
                <ul className="overflow-hidden rounded-lg border border-border/70">
                  {plan.steps.map((step, index) => (
                    <li
                      key={`${step.packageId}-${step.order}`}
                      className={index > 0 ? 'border-t border-border/60' : undefined}
                    >
                      <div className="flex items-start gap-3 bg-secondary/20 px-3.5 py-3">
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card font-mono text-[10px] text-muted-foreground">
                          {step.order}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-semibold text-foreground">{step.name}</span>
                            {step.version ? (
                              <span className="font-mono text-[11px] text-muted-foreground">{step.version}</span>
                            ) : null}
                            <Badge
                              variant={
                                step.action === 'upgrade'
                                  ? 'warning'
                                  : step.action === 'configure'
                                    ? 'info'
                                    : step.action === 'skip'
                                      ? 'muted'
                                      : step.action === 'project-recipe'
                                        ? 'outline'
                                        : 'secondary'
                              }
                            >
                              {humanize(step.action)}
                            </Badge>
                            {step.isDependency ? <Badge variant="outline">Dependency</Badge> : null}
                            {step.requiresRestart ? (
                              <Badge variant="warning">
                                <RotateCcw className="size-2.5" /> Restart
                              </Badge>
                            ) : null}
                            {step.requiresAdmin ? (
                              <Badge variant="warning">
                                <ShieldAlert className="size-2.5" /> Admin
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span>{methodLabels[step.method] ?? step.method}</span>
                            {step.environmentChanges.length > 0 ? (
                              <span>{step.environmentChanges.length} environment change(s)</span>
                            ) : null}
                            {step.verificationChecks.length > 0 ? (
                              <span>{step.verificationChecks.length} verification check(s)</span>
                            ) : null}
                            {step.estimatedSizeBytes ? <span>{formatBytes(step.estimatedSizeBytes)}</span> : null}
                          </div>
                          {step.reason ? (
                            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{step.reason}</p>
                          ) : null}
                          {step.warnings.length > 0 ? (
                            <ul className="mt-1 space-y-0.5 text-[11px] leading-4 text-warning/90">
                              {step.warnings.map((warning, warningIndex) => (
                                <li key={warningIndex}>{warning}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              {installable.length === 0 && !hasErrors ? (
                <div className="rounded-lg border border-success/25 bg-success/5 px-3 py-2.5 text-xs text-success">
                  Everything selected is already installed and configured. There is nothing to queue.
                </div>
              ) : null}

              <div className="flex items-start gap-2 rounded-lg bg-secondary/30 px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>{plan.serializedReason}</span>
              </div>
            </div>
          ) : null}
        </div>

        <Separator />
        <DialogFooter className="p-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => enqueueMutation.mutate('queue')}
            disabled={!canEnqueue}
          >
            {busy && enqueueMutation.variables === 'queue' ? (
              <Loader2 className="animate-spin" />
            ) : (
              <ListPlus />
            )}
            Add to queue
          </Button>
          <Button onClick={() => enqueueMutation.mutate('start')} disabled={!canEnqueue}>
            {busy && enqueueMutation.variables === 'start' ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Play />
            )}
            {onlyConfiguration ? 'Apply configuration' : 'Install now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PlanMetric({
  icon,
  label,
  value
}: {
  icon: ReactNode
  label: string
  value: string
}): ReactNode {
  return (
    <div className="rounded-lg border border-border/70 bg-secondary/25 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground [&_svg]:size-3">
        {icon}
        {label}
      </div>
      <p className="mt-1 truncate text-xs font-semibold text-foreground">{value}</p>
    </div>
  )
}
