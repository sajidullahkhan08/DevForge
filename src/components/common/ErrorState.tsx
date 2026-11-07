import type { ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { parseIpcError } from '@/lib/format'

interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
  compact?: boolean
}

export function ErrorState({ error, onRetry, compact }: ErrorStateProps): ReactNode {
  const parsed = parseIpcError(error)
  return (
    <div
      className={
        compact
          ? 'flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs'
          : 'flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-6 py-12 text-center'
      }
    >
      <AlertTriangle className={compact ? 'mt-0.5 size-4 shrink-0 text-destructive' : 'size-6 text-destructive'} />
      <div className={compact ? 'min-w-0 flex-1 text-left' : 'max-w-lg space-y-1'}>
        <p className={compact ? 'font-medium text-foreground' : 'text-sm font-medium text-foreground'}>
          {parsed.message}
        </p>
        {parsed.hint ? <p className="text-xs leading-5 text-muted-foreground">{parsed.hint}</p> : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className={compact ? 'shrink-0' : 'mt-1'}>
          <RefreshCw className="size-3.5" />
          Retry
        </Button>
      ) : null}
    </div>
  )
}
