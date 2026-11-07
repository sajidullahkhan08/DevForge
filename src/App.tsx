import { useEffect, useRef, type ReactElement } from 'react'
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { Toaster, toast } from 'sonner'
import type { DashboardData } from '@shared/types'
import { AppShell } from '@/components/layout/AppShell'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useResolvedTheme } from '@/hooks/useTheme'
import { queryKeys, useSettings } from '@/hooks/useData'
import DashboardPage from '@/pages/DashboardPage'
import DiscoverPage from '@/pages/DiscoverPage'
import PackageDetailPage from '@/pages/PackageDetailPage'
import EnvironmentsPage from '@/pages/EnvironmentsPage'
import InstalledPage from '@/pages/InstalledPage'
import QueuePage from '@/pages/QueuePage'
import EnvironmentVariablesPage from '@/pages/EnvironmentVariablesPage'
import VersionsPage from '@/pages/VersionsPage'
import HistoryPage from '@/pages/HistoryPage'
import SettingsPage from '@/pages/SettingsPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false
    }
  }
})

function EventBridge(): null {
  const client = useQueryClient()
  const finishedRef = useRef(0)

  useEffect(() => {
    const disposeQueue = window.devforge.events.onQueueUpdate((snapshot) => {
      client.setQueryData(queryKeys.queue, snapshot)
      client.setQueryData<DashboardData>(queryKeys.dashboard, (previous) =>
        previous
          ? {
              ...previous,
              queue: snapshot,
              stats: { ...previous.stats, pendingOperations: snapshot.pendingCount }
            }
          : previous
      )

      const finished = snapshot.items.filter((item) =>
        ['completed', 'failed', 'cancelled', 'requires-restart'].includes(item.status)
      ).length
      if (finished > finishedRef.current) {
        void client.invalidateQueries({ queryKey: queryKeys.installations })
        void client.invalidateQueries({ queryKey: queryKeys.catalogue })
        void client.invalidateQueries({ queryKey: queryKeys.dashboard })
        void client.invalidateQueries({ queryKey: queryKeys.info })
        void client.invalidateQueries({ queryKey: ['history'] })
      }
      finishedRef.current = finished
    })

    const disposeActivity = window.devforge.events.onActivity((entries) => {
      client.setQueryData<DashboardData>(queryKeys.dashboard, (previous) =>
        previous ? { ...previous, activity: entries } : previous
      )
      void client.invalidateQueries({ queryKey: ['history'] })
    })

    const disposeVerification = window.devforge.events.onVerification(() => {
      void client.invalidateQueries({ queryKey: queryKeys.installations })
      void client.invalidateQueries({ queryKey: queryKeys.dashboard })
      void client.invalidateQueries({ queryKey: queryKeys.catalogue })
    })

    const disposeNotification = window.devforge.events.onNotification((notification) => {
      const options = { description: notification.body, duration: 7000 }
      switch (notification.kind) {
        case 'error':
          toast.error(notification.title, options)
          break
        case 'warning':
          toast.warning(notification.title, options)
          break
        case 'info':
          toast.info(notification.title, options)
          break
        default:
          toast.success(notification.title, options)
      }
    })

    return () => {
      disposeQueue()
      disposeActivity()
      disposeVerification()
      disposeNotification()
    }
  }, [client])

  return null
}

const startupPaths = new Set([
  '/dashboard',
  '/discover',
  '/environments',
  '/installed',
  '/queue',
  '/environment-variables',
  '/versions',
  '/history',
  '/settings'
])

function StartupRedirect(): ReactElement | null {
  const settings = useSettings()
  const navigate = useNavigate()
  const handled = useRef(false)

  useEffect(() => {
    if (handled.current || !settings.data) return
    handled.current = true
    const target = startupPaths.has(settings.data.startupPage) ? settings.data.startupPage : '/dashboard'
    navigate(target, { replace: true })
  }, [settings.data, navigate])

  return null
}

function AppFrame(): ReactElement {
  const theme = useResolvedTheme()
  return (
    <>
      <EventBridge />
      <HashRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<StartupRedirect />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/discover/:packageId" element={<PackageDetailPage />} />
            <Route path="/environments" element={<EnvironmentsPage />} />
            <Route path="/installed" element={<InstalledPage />} />
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/environment-variables" element={<EnvironmentVariablesPage />} />
            <Route path="/versions" element={<VersionsPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      <Toaster theme={theme} position="bottom-right" closeButton richColors />
    </>
  )
}

export default function App(): ReactElement {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={250}>
          <AppFrame />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
