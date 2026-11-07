import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  label: string
  value: ReactNode
  hint?: string
  icon: ReactNode
  tone?: 'primary' | 'success' | 'warning' | 'neutral'
  className?: string
}

const tones = {
  primary: 'text-primary bg-primary/10 border-primary/20',
  success: 'text-success bg-success/10 border-success/20',
  warning: 'text-warning bg-warning/10 border-warning/20',
  neutral: 'text-muted-foreground bg-secondary/60 border-border'
} as const

export function MetricCard({ label, value, hint, icon, tone = 'neutral', className }: MetricCardProps): ReactNode {
  return (
    <div
      className={cn(
        'metric-sheen relative overflow-hidden rounded-xl border border-border/80 bg-card p-4 shadow-card',
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
        </div>
        <div className={cn('flex size-8 items-center justify-center rounded-lg border [&_svg]:size-4', tones[tone])}>
          {icon}
        </div>
      </div>
      {hint ? <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
