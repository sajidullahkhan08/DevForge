import { useEffect, useRef, type ReactElement } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { CommandPalette } from './CommandPalette'

export function AppShell(): ReactElement {
  const location = useLocation()
  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [location.pathname])

  return (
    <div className="app-surface flex h-screen overflow-hidden">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md border border-primary/40 bg-card px-3 py-2 text-xs font-medium text-foreground focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
      >
        Skip to main content
      </a>
      <Sidebar />
      <main ref={mainRef} id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto outline-none">
        <div className="mx-auto w-full max-w-[1440px] px-6 py-6 lg:px-8">
          <Outlet />
        </div>
      </main>
      <CommandPalette />
    </div>
  )
}
