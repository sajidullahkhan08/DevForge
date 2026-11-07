import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Download,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Sparkles,
  SquareArrowOutUpRight
} from 'lucide-react'
import { api } from '@/lib/api'
import { notifyError, notifySuccess } from '@/lib/feedback'
import { queryKeys, useCatalogue } from '@/hooks/useData'
import { navSections } from '@/lib/navigation'
import { useUiStore } from '@/store/ui'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export const OPEN_COMMAND_PALETTE_EVENT = 'devforge:open-command-palette'

interface CommandItem {
  id: string
  label: string
  group: string
  hint?: string
  icon: ComponentType<{ className?: string }>
  run: () => void
}

export function CommandPalette(): ReactNode {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const catalogue = useCatalogue()
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    const onOpenEvent = (): void => setOpen(true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setActiveIndex(0)
      setBusy(null)
    }
  }, [open])

  const items = useMemo<CommandItem[]>(() => {
    const close = (): void => setOpen(false)
    const navigation: CommandItem[] = navSections.flatMap((section) =>
      section.items.map((item) => ({
        id: `nav:${item.to}`,
        label: item.label,
        group: 'Go to',
        hint: item.to,
        icon: item.icon,
        run: () => {
          close()
          navigate(item.to)
        }
      }))
    )

    const actions: CommandItem[] = [
      {
        id: 'action:refresh',
        label: 'Re-detect installed software',
        group: 'Actions',
        hint: 'Scan known installation folders',
        icon: RefreshCw,
        run: async () => {
          setBusy('action:refresh')
          try {
            const installations = await api.installations.refresh()
            queryClient.setQueryData(queryKeys.installations, installations)
            notifySuccess('Detection complete', `${installations.length} active installation(s) detected.`)
            close()
          } catch (error) {
            notifyError(error)
          } finally {
            setBusy(null)
          }
        }
      },
      {
        id: 'action:updates',
        label: 'Check for updates',
        group: 'Actions',
        hint: 'Registry and vendor release feeds',
        icon: Sparkles,
        run: async () => {
          setBusy('action:updates')
          try {
            const updates = await api.installations.checkUpdates()
            void queryClient.invalidateQueries({ queryKey: queryKeys.installations })
            void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
            notifySuccess(
              updates.length > 0 ? `${updates.length} update(s) available` : 'No updates found',
              updates.length > 0
                ? 'Review each update on the dashboard or Installed Software page.'
                : 'All tracked packages match the latest known release.'
            )
            close()
          } catch (error) {
            notifyError(error)
          } finally {
            setBusy(null)
          }
        }
      },
      {
        id: 'action:discover',
        label: 'Install new software',
        group: 'Actions',
        hint: 'Open the catalogue',
        icon: Download,
        run: () => {
          close()
          navigate('/discover')
        }
      },
      {
        id: 'action:sidebar',
        label: 'Toggle sidebar',
        group: 'Actions',
        hint: 'Collapse or expand navigation',
        icon: SquareArrowOutUpRight,
        run: () => {
          toggleSidebar()
          close()
        }
      }
    ]

    const packages: CommandItem[] = (catalogue.data ?? []).map((item) => ({
      id: `package:${item.package.id}`,
      label: item.package.name,
      group: 'Packages',
      hint: `${item.package.id} · ${item.package.versions.length} version(s)`,
      icon: Package,
      run: () => {
        close()
        navigate(`/discover/${item.package.id}`)
      }
    }))

    return [...navigation, ...actions, ...packages]
  }, [catalogue.data, navigate, queryClient, toggleSidebar])

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    const matches = term
      ? items.filter(
          (item) =>
            item.label.toLowerCase().includes(term) ||
            item.hint?.toLowerCase().includes(term) ||
            item.group.toLowerCase().includes(term)
        )
      : items.filter((item) => item.group !== 'Packages')
    return matches.slice(0, 30)
  }, [items, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const runItem = (item: CommandItem): void => {
    void item.run()
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search pages, packages and actions. Use the arrow keys and Enter to run a command.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) => Math.min(index + 1, filtered.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) => Math.max(index - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const item = filtered[activeIndex]
                if (item) runItem(item)
              }
            }}
            placeholder="Search pages, packages and actions…"
            aria-label="Search commands"
            className="h-8 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
          <kbd className="rounded border border-border/70 bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-1.5" role="listbox" aria-label="Commands">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              No pages, packages or actions match “{query.trim()}”.
            </p>
          ) : (
            filtered.map((item, index) => {
              const Icon = item.icon
              const active = index === activeIndex
              return (
                <button
                  key={item.id}
                  type="button"
                  ref={active ? selectedRef : null}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runItem(item)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    active ? 'bg-secondary/80 text-foreground' : 'text-muted-foreground hover:bg-secondary/50'
                  )}
                >
                  <span
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60',
                      active ? 'bg-primary/15 text-primary' : 'bg-secondary/40'
                    )}
                  >
                    {busy === item.id ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{item.label}</span>
                    {item.hint ? (
                      <span className="block truncate text-[10px] text-muted-foreground">{item.hint}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60">
                    {item.group}
                  </span>
                  <ArrowRight className={cn('size-3', active ? 'text-primary' : 'text-transparent')} />
                </button>
              )
            })
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border/60 px-3.5 py-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-2">
            <kbd className="rounded border border-border/70 px-1 py-0.5 font-mono">↑</kbd>
            <kbd className="rounded border border-border/70 px-1 py-0.5 font-mono">↓</kbd>
            to navigate
            <kbd className="ml-2 rounded border border-border/70 px-1 py-0.5 font-mono">Enter</kbd>
            to run
          </span>
          <span className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={() => setOpen(false)}>
              Close
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
