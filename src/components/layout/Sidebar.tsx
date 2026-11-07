import type { ReactElement } from 'react'
import { NavLink } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  Cpu,
  Flame,
  HardDrive,
  Search,
  ShieldCheck,
  ShieldQuestion,
  Terminal
} from 'lucide-react'
import { navSections } from '@/lib/navigation'
import { OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette'
import { useSystemInfo, useQueue } from '@/hooks/useData'
import { useUiStore } from '@/store/ui'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

export function Sidebar(): ReactElement {
  const collapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const { data: info, isLoading: infoLoading } = useSystemInfo()
  const { data: queue } = useQueue()

  const activeCount = (queue?.pendingCount ?? 0) + (queue?.items.filter((item) => item.status === 'running').length ?? 0)

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar/95 transition-[width] duration-200 ease-out',
        collapsed ? 'w-[74px]' : 'w-[248px]'
      )}
    >
      <div className={cn('flex h-16 items-center gap-3', collapsed ? 'justify-center px-2' : 'px-4')}>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-gradient-to-br from-primary/30 via-primary/10 to-transparent text-primary shadow-glow">
          <Flame className="size-[18px]" strokeWidth={2.2} />
        </div>
        {!collapsed ? (
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight text-foreground">DevForge</p>
            <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-muted-foreground/80">
              Toolchain manager
            </p>
          </div>
        ) : null}
      </div>

      <div className={cn('space-y-1.5 pb-2 pt-1', collapsed ? 'px-2' : 'px-3')}>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
          title="Search or run a command (Ctrl+K)"
          aria-label="Search or run a command"
          className={cn(
            'flex h-7 w-full items-center rounded-md border border-border/60 bg-secondary/25 text-[11px] text-muted-foreground/80 transition-colors hover:bg-secondary/60 hover:text-foreground',
            collapsed ? 'justify-center' : 'gap-1.5 px-2'
          )}
        >
          <Search className="size-3.5 shrink-0" />
          {!collapsed ? (
            <>
              <span className="flex-1 text-left">Search…</span>
              <kbd className="rounded border border-border/70 px-1 font-mono text-[9px]">Ctrl K</kbd>
            </>
          ) : null}
        </button>
        <button
          type="button"
          onClick={toggleSidebar}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex h-7 w-full items-center rounded-md text-[11px] text-muted-foreground/70 transition-colors hover:bg-secondary/70 hover:text-foreground',
            collapsed ? 'justify-center' : 'justify-end px-2'
          )}
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronLeft className="size-3.5" />}
        </button>
      </div>

      <nav className={cn('flex-1 overflow-y-auto pb-3 no-scrollbar', collapsed ? 'px-2' : 'px-2.5')}>
        <div className="space-y-5">
          {navSections.map((section) => (
            <div key={section.label}>
              {!collapsed ? (
                <p className="mb-1.5 px-2.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/60">
                  {section.label}
                </p>
              ) : (
                <div className="mx-1.5 mb-2 h-px bg-border/60" />
              )}
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      title={collapsed ? item.label : undefined}
                      className={({ isActive }) =>
                        cn(
                          'group relative flex items-center rounded-lg text-[13px] transition-colors',
                          collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-2.5 py-2',
                          isActive
                            ? 'bg-primary/10 font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive ? (
                            <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
                          ) : null}
                          <item.icon className={cn('size-4 shrink-0', isActive ? 'text-primary' : '')} />
                          {!collapsed ? (
                            <>
                              <span className="flex-1 truncate">{item.label}</span>
                              {item.showQueueBadge && activeCount > 0 ? (
                                <span className="flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 font-mono text-[10px] font-semibold leading-4 text-primary-foreground">
                                  {activeCount}
                                </span>
                              ) : null}
                            </>
                          ) : item.showQueueBadge && activeCount > 0 ? (
                            <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />
                          ) : null}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div className={cn('border-t border-sidebar-border', collapsed ? 'p-2' : 'p-3')}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2 py-1 text-muted-foreground">
            <span title={info?.wingetVersion ? `WinGet ${info.wingetVersion}` : 'WinGet unavailable'}>
              <Terminal className={cn('size-3.5', info?.wingetVersion ? 'text-success' : 'text-warning')} />
            </span>
            <span title={info?.isElevated ? 'Running elevated' : 'Standard user'}>
              {info?.isElevated ? (
                <ShieldCheck className="size-3.5 text-success" />
              ) : (
                <ShieldQuestion className="size-3.5 text-muted-foreground" />
              )}
            </span>
          </div>
        ) : (
          <div className="rounded-lg border border-border/70 bg-secondary/25 p-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                System status
              </p>
              <span className="text-[10px] text-muted-foreground/60">v{info?.appVersion ?? '1.0.0'}</span>
            </div>
            {infoLoading ? (
              <div className="mt-2.5 space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            ) : (
              <ul className="mt-2.5 space-y-2 text-[11px]">
                <li className="flex items-center gap-2 text-muted-foreground">
                  <Terminal className="size-3.5 shrink-0" />
                  <span className="flex-1">WinGet</span>
                  <span className={info?.wingetVersion ? 'text-success' : 'text-warning'}>
                    {info?.wingetVersion ?? 'Unavailable'}
                  </span>
                </li>
                <li className="flex items-center gap-2 text-muted-foreground">
                  <Cpu className="size-3.5 shrink-0" />
                  <span className="flex-1">Session</span>
                  <span className={info?.isElevated ? 'text-success' : 'text-foreground/80'}>
                    {info?.isElevated ? 'Elevated' : 'Standard'}
                  </span>
                </li>
                <li className="flex items-center gap-2 text-muted-foreground">
                  <HardDrive className="size-3.5 shrink-0" />
                  <span className="flex-1">Free space</span>
                  <span className="font-mono text-[10px] text-foreground/80">{formatBytes(info?.freeDiskBytes ?? null)}</span>
                </li>
              </ul>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
