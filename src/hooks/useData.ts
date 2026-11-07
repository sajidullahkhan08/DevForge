import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

export const queryKeys = {
  info: ['system-info'] as const,
  dashboard: ['dashboard'] as const,
  catalogue: ['catalogue'] as const,
  package: (packageId: string) => ['catalogue', packageId] as const,
  discovery: (query: string) => ['discovery', query] as const,
  installations: ['installations'] as const,
  queue: ['queue'] as const,
  profiles: ['profiles'] as const,
  environment: ['environment'] as const,
  environmentBackups: ['environment-backups'] as const,
  history: (limit: number) => ['history', limit] as const,
  transaction: (transactionId: string) => ['transaction', transactionId] as const,
  settings: ['settings'] as const,
  databaseInfo: ['database-info'] as const
}

export function useSystemInfo() {
  return useQuery({
    queryKey: queryKeys.info,
    queryFn: () => api.app.getInfo(),
    staleTime: 30_000
  })
}

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => api.app.getDashboard(),
    staleTime: 10_000
  })
}

export function useCatalogue() {
  return useQuery({
    queryKey: queryKeys.catalogue,
    queryFn: () => api.registry.list(),
    staleTime: 60_000
  })
}

export function useDiscoverySearch(query: string) {
  const normalized = query.trim()
  return useQuery({
    queryKey: queryKeys.discovery(normalized.toLowerCase()),
    queryFn: () => api.discovery.search(normalized),
    enabled: normalized.length >= 2,
    staleTime: 10 * 60_000,
    retry: false
  })
}

export function usePackage(packageId: string | undefined) {  return useQuery({
    queryKey: queryKeys.package(packageId ?? 'unknown'),
    queryFn: () => api.registry.get(packageId as string),
    enabled: Boolean(packageId),
    staleTime: 60_000
  })
}

export function useInstallations() {
  return useQuery({
    queryKey: queryKeys.installations,
    queryFn: () => api.installations.list(),
    staleTime: 10_000
  })
}

export function useQueue() {
  return useQuery({
    queryKey: queryKeys.queue,
    queryFn: () => api.queue.get(),
    staleTime: 5_000
  })
}

export function useProfiles() {
  return useQuery({
    queryKey: queryKeys.profiles,
    queryFn: () => api.profiles.list(),
    staleTime: 30_000
  })
}

export function useEnvironmentVariables() {
  return useQuery({
    queryKey: queryKeys.environment,
    queryFn: () => api.environment.list(),
    staleTime: 10_000
  })
}

export function useEnvironmentBackups() {
  return useQuery({
    queryKey: queryKeys.environmentBackups,
    queryFn: () => api.environment.backups(),
    staleTime: 10_000
  })
}

export function useHistory(limit = 100) {
  return useQuery({
    queryKey: queryKeys.history(limit),
    queryFn: () => api.history.list(limit),
    staleTime: 10_000
  })
}

export function useTransaction(transactionId: string | null) {
  return useQuery({
    queryKey: queryKeys.transaction(transactionId ?? 'none'),
    queryFn: () => api.history.get(transactionId as string),
    enabled: Boolean(transactionId),
    staleTime: 30_000
  })
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.settings.get(),
    staleTime: 60_000
  })
}

export function useDatabaseInfo() {
  return useQuery({
    queryKey: queryKeys.databaseInfo,
    queryFn: () => api.settings.databaseInfo(),
    staleTime: 30_000
  })
}

export function useRefreshInstallData(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue })
    void queryClient.invalidateQueries({ queryKey: queryKeys.installations })
    void queryClient.invalidateQueries({ queryKey: queryKeys.queue })
    void queryClient.invalidateQueries({ queryKey: queryKeys.info })
  }, [queryClient])
}
