import type { ReactNode } from 'react'
import { ExternalLink, Info } from 'lucide-react'
import type { PackageDefinition } from '@shared/types'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CopyButton } from './CopyButton'

interface RecipeDialogProps {
  pkg: PackageDefinition | null
  onOpenChange: (open: boolean) => void
}

export function RecipeDialog({ pkg, onOpenChange }: RecipeDialogProps): ReactNode {
  const recipe = pkg?.projectRecipe
  const open = Boolean(pkg && recipe)
  const allCommands = recipe?.commands.map((command) => command.command).join('\n') ?? ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 p-0">
        <DialogHeader className="border-b border-border/70 p-6 pb-4">
          <DialogTitle>{pkg?.name ?? 'Guided setup'}</DialogTitle>
          <DialogDescription>{recipe?.summary ?? ''}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[52vh]">
          <div className="space-y-4 p-6">
            <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <span>
                This is a project-level recipe, not a machine-wide installation. DevForge never runs these commands
                for you: review them and execute them inside the project directory you want to set up.
              </span>
            </div>

            {recipe && recipe.commands.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-border/70">
                {recipe.commands.map((command, index) => (
                  <div key={`${command.label}-${index}`} className={index > 0 ? 'border-t border-border/60' : undefined}>
                    <div className="flex items-center justify-between gap-2 bg-secondary/30 px-3 py-1.5">
                      <span className="text-[11px] font-medium text-foreground/90">{command.label}</span>
                      <CopyButton value={command.command} />
                    </div>
                    <pre className="overflow-x-auto bg-background/60 px-3 py-2.5 font-mono text-[11px] leading-5 text-foreground/85">
                      {command.command}
                    </pre>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No commands were provided for this recipe.</p>
            )}

            {recipe && recipe.notes.length > 0 ? (
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Notes</p>
                <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                  {recipe.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        <DialogFooter className="border-t border-border/70 p-4">
          {allCommands ? <CopyButton value={allCommands} label="Copy all" size="sm" /> : null}
          {pkg ? (
            <Button
              variant="outline"
              onClick={() => void api.system.openExternal(pkg.documentationUrl ?? pkg.homepage)}
            >
              <ExternalLink />
              Documentation
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
