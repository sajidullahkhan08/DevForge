import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { HealthCheck } from '@shared/types'
import { cn } from '@/lib/utils'

const meta = {
  ok: { Icon: CheckCircle2, className: 'text-success bg-success/10 border-success/20' },
  warning: { Icon: AlertTriangle, className: 'text-warning bg-warning/10 border-warning/20' },
  error: { Icon: XCircle, className: 'text-destructive bg-destructive/10 border-destructive/20' },
  info: { Icon: Info, className: 'text-primary bg-primary/10 border-primary/20' }
} as const

interface HealthListProps {
  checks: HealthCheck[]
  limit?: number
  className?: string
}

export function HealthList({ checks, limit, className }: HealthListProps): ReactNode {
  const visible = typeof limit === 'number' ? checks.slice(0, limit) : checks
  return (
    <ul className={cn('space-y-1', className)}>
      {visible.map((check) => {
        const { Icon, className: iconClass } = meta[check.status]
        return (
          <li key={check.id} className="flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-secondary/40">
            <div
              className={cn(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border [&_svg]:size-3.5',
                iconClass
              )}
            >
              <Icon />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground/90">{check.label}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{check.detail}</p>
              {check.fixHint ? (
                <p className="mt-1 text-[11px] leading-4 text-warning/90">{check.fixHint}</p>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
