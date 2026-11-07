import type { ReactNode } from 'react'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { humanize } from '@/lib/format'
import { cn } from '@/lib/utils'

const statusMap: Record<string, { variant: BadgeProps['variant']; label?: string; pulse?: boolean }> = {
  installed: { variant: 'success' },
  verified: { variant: 'success' },
  configured: { variant: 'success' },
  passed: { variant: 'success' },
  completed: { variant: 'success' },
  success: { variant: 'success' },
  ok: { variant: 'success' },
  valid: { variant: 'success' },
  running: { variant: 'info', pulse: true },
  'in-progress': { variant: 'info', label: 'In progress', pulse: true },
  installing: { variant: 'info', pulse: true },
  downloading: { variant: 'info', pulse: true },
  verifying: { variant: 'info', pulse: true },
  'needs-test': { variant: 'warning' },
  pending: { variant: 'warning' },
  paused: { variant: 'warning' },
  partial: { variant: 'warning', label: 'Partial' },
  incomplete: { variant: 'warning' },
  'already-configured': { variant: 'success', label: 'Configured' },
  'configured-only': { variant: 'info', label: 'Configured' },
  'requires-restart': { variant: 'warning', label: 'Restart required' },
  warning: { variant: 'warning' },
  update: { variant: 'warning' },
  outdated: { variant: 'warning' },
  failed: { variant: 'destructive' },
  error: { variant: 'destructive' },
  invalid: { variant: 'destructive' },
  missing: { variant: 'destructive' },
  cancelled: { variant: 'muted' },
  canceled: { variant: 'muted' },
  removed: { variant: 'muted' },
  skipped: { variant: 'muted' },
  unknown: { variant: 'muted' },
  external: { variant: 'outline' },
  'not-configured': { variant: 'outline', label: 'Not configured' }
}

interface StatusBadgeProps {
  status: string
  label?: string
  className?: string
  showDot?: boolean
}

export function StatusBadge({ status, label, className, showDot = true }: StatusBadgeProps): ReactNode {
  const meta = statusMap[status] ?? { variant: 'secondary' as const }
  const text = label ?? meta.label ?? humanize(status)
  return (
    <Badge variant={meta.variant} className={cn('capitalize', className)}>
      {showDot ? (
        <span
          className={cn(
            'size-1.5 rounded-full bg-current opacity-80',
            meta.pulse && 'animate-pulse'
          )}
        />
      ) : null}
      {text}
    </Badge>
  )
}
