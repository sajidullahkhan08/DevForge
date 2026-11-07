import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from 'lucide-react'
import type { QueueStageState } from '@shared/types'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'

interface StageListProps {
  stages: QueueStageState[]
  className?: string
}

export function StageList({ stages, className }: StageListProps): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  const hasActiveStage = stages.some((stage) => stage.status === 'in-progress' && stage.startedAt)

  useEffect(() => {
    if (!hasActiveStage) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasActiveStage])

  return (
    <ol className={cn('space-y-2', className)}>
      {stages.map((stage) => {
        const Icon =
          stage.status === 'completed'
            ? CheckCircle2
            : stage.status === 'failed'
              ? XCircle
              : stage.status === 'in-progress'
                ? Loader2
                : stage.status === 'skipped'
                  ? MinusCircle
                  : Circle
        const color =
          stage.status === 'completed'
            ? 'text-success'
            : stage.status === 'failed'
              ? 'text-destructive'
              : stage.status === 'in-progress'
                ? 'text-primary'
                : 'text-muted-foreground/50'
        return (
          <li key={stage.stage} className="flex items-start gap-2.5">
            <Icon
              className={cn(
                'mt-0.5 size-3.5 shrink-0',
                color,
                stage.status === 'in-progress' && 'animate-spin'
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    'text-xs',
                    stage.status === 'pending' ? 'text-muted-foreground/60' : 'text-foreground/90',
                    stage.status === 'in-progress' && 'font-medium'
                  )}
                >
                  {stage.label}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                  {stage.status === 'in-progress'
                    ? `${stage.progress !== null ? `${Math.round(stage.progress)}%` : 'running'}${
                        stage.startedAt
                          ? ` · ${formatDuration(stage.startedAt, new Date(now).toISOString())}`
                          : ''
                      }`
                    : stage.startedAt && stage.finishedAt
                      ? formatDuration(stage.startedAt, stage.finishedAt)
                      : ''}
                </span>
              </div>
              {stage.detail ? (
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{stage.detail}</p>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
