import type { ReactNode } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import type { VerificationRun } from '@shared/types'
import { formatDateTime } from '@/lib/format'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from './StatusBadge'

interface VerificationDialogProps {
  run: VerificationRun | null
  onClose: () => void
}

export function VerificationDialog({ run, onClose }: VerificationDialogProps): ReactNode {
  return (
    <Dialog open={Boolean(run)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl gap-0 p-0">
        <DialogHeader className="border-b border-border/70 p-6 pb-4">
          <div className="flex items-center gap-2">
            <DialogTitle>Verification results</DialogTitle>
            {run ? <StatusBadge status={run.status} /> : null}
          </div>
          <DialogDescription>
            {run
              ? `${run.packageId}${run.version ? ` ${run.version}` : ''} · checked ${formatDateTime(run.finishedAt)}`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[55vh]">
          <div className="space-y-2 p-6">
            {run?.checks.map((check) => (
              <div
                key={check.id}
                className="rounded-lg border border-border/70 bg-secondary/20 px-3.5 py-3"
              >
                <div className="flex items-start gap-2">
                  {check.passed ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-foreground">{check.label}</span>
                      {check.optional ? <Badge variant="outline">Optional</Badge> : null}
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{check.command}</p>
                    {check.expected ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">Expected: {check.expected}</p>
                    ) : null}
                    {check.error ? (
                      <p className="mt-1 text-[11px] text-destructive">{check.error}</p>
                    ) : check.output ? (
                      <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
                        {check.output}
                      </pre>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
            {run && run.checks.length === 0 ? (
              <p className="text-xs text-muted-foreground">No checks were defined for this package.</p>
            ) : null}
          </div>
        </ScrollArea>
        <DialogFooter className="border-t border-border/70 p-4">
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
