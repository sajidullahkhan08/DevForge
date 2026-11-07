import type { ReactNode } from 'react'
import {
  ArrowUpCircle,
  Download,
  Info,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type { ActivityEntry } from '@shared/types'
import { formatRelative, humanize } from '@/lib/format'
import { cn } from '@/lib/utils'

const typeIcons = {
  install: Download,
  configure: SlidersHorizontal,
  verify: ShieldCheck,
  detect: RefreshCw,
  update: ArrowUpCircle,
  uninstall: Trash2,
  error: TriangleAlert,
  system: Info
} as const

const levelStyles: Record<string, string> = {
  info: 'text-primary bg-primary/10 border-primary/20',
  success: 'text-success bg-success/10 border-success/20',
  warning: 'text-warning bg-warning/10 border-warning/20',
  error: 'text-destructive bg-destructive/10 border-destructive/20'
}

interface ActivityListProps {
  entries: ActivityEntry[]
  limit?: number
  className?: string
}

export function ActivityList({ entries, limit = 8, className }: ActivityListProps): ReactNode {
  return (
    <ul className={cn('space-y-0.5', className)}>
      {entries.slice(0, limit).map((entry) => {
        const Icon = typeIcons[entry.type] ?? Info
        return (
          <li key={entry.id} className="group flex gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-secondary/40">
            <div
              className={cn(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border [&_svg]:size-3',
                levelStyles[entry.level] ?? levelStyles.info
              )}
            >
              <Icon />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-xs font-medium text-foreground/90">{entry.title}</p>
                <span className="shrink-0 text-[10px] text-muted-foreground/70">{formatRelative(entry.createdAt)}</span>
              </div>
              {entry.message ? (
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{entry.message}</p>
              ) : (
                <p className="mt-0.5 text-[11px] text-muted-foreground/60">{humanize(entry.type)}</p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
