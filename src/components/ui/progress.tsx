import type { ReactElement } from 'react'
import { clamp, cn } from '@/lib/utils'

interface ProgressProps {
  value: number | null | undefined
  className?: string
  indicatorClassName?: string
  indeterminate?: boolean
}

export function Progress({ value, className, indicatorClassName, indeterminate }: ProgressProps): ReactElement {
  const percent = typeof value === 'number' ? clamp(value, 0, 100) : null
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-secondary', className)}
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-[width] duration-500 ease-out',
          indeterminate && 'w-1/3 animate-shimmer bg-gradient-to-r from-primary/40 via-primary to-primary/40',
          indicatorClassName
        )}
        style={indeterminate ? undefined : { width: `${percent ?? 0}%` }}
      />
    </div>
  )
}
