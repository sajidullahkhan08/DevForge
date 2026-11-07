import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { ipcChannels } from '@shared/ipc'
import type {
  ActivityEntry,
  AppNotification,
  AppSettings,
  DatabaseInfo,
  DevForgeApi,
  EnvPreview,
  EnvScope,
  EnvironmentMutation,
  EnvironmentProfile,
  InstallRequest,
  PackageImportResult,
  ProfileImportResult,
  ProfileInput,
  ProjectGenerateResult,
  ProjectInspection,
  ProjectRemoveResult,
  QueueSnapshot,
  VerificationRun
} from '@shared/types'

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>

const subscribe = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: DevForgeApi = {
  app: {
    getInfo: () => invoke(ipcChannels.app.getInfo),
    getDashboard: () => invoke(ipcChannels.app.getDashboard)
  },
  registry: {
    list: () => invoke(ipcChannels.registry.list),
    get: (packageId: string) => invoke(ipcChannels.registry.get, packageId),
    importPackage: () => invoke<PackageImportResult>(ipcChannels.registry.importPackage)
  },
  discovery: {
    search: (query: string) => invoke(ipcChannels.discovery.search, query),
    prepare: (resultId: string) => invoke(ipcChannels.discovery.prepare, resultId),
    refreshManaged: (force?: boolean) => invoke(ipcChannels.discovery.refresh, force ?? false)
  },
  plans: {
    preview: (requests: InstallRequest[]) => invoke(ipcChannels.plans.preview, requests)
  },
  queue: {
    get: () => invoke<QueueSnapshot>(ipcChannels.queue.get),
    enqueue: (requests: InstallRequest[]) => invoke(ipcChannels.queue.enqueue, requests),
    start: () => invoke(ipcChannels.queue.start),
    pause: () => invoke(ipcChannels.queue.pause),
    resume: () => invoke(ipcChannels.queue.resume),
    cancel: (itemId: string) => invoke(ipcChannels.queue.cancel, itemId),
    retry: (itemId: string, options?: { recoverDirectory?: boolean }) =>
      invoke(ipcChannels.queue.retry, { itemId, ...(options ?? {}) }),
    remove: (itemId: string) => invoke(ipcChannels.queue.remove, itemId),
    move: (itemId: string, direction: 'up' | 'down') =>
      invoke<QueueSnapshot>(ipcChannels.queue.move, { itemId, direction }),
    clearCompleted: () => invoke(ipcChannels.queue.clearCompleted)
  },
  installations: {
    list: () => invoke(ipcChannels.installations.list),
    refresh: () => invoke(ipcChannels.installations.refresh),
    verify: (packageId: string) => invoke<VerificationRun>(ipcChannels.installations.verify, packageId),
    repair: (packageId: string) => invoke<EnvPreview>(ipcChannels.installations.repair, packageId),
    uninstall: (packageId: string, options?: { removeDirectory?: boolean }) =>
      invoke(ipcChannels.installations.uninstall, { packageId, options }),
    openDirectory: (packageId: string) => invoke(ipcChannels.installations.openDirectory, packageId),
    checkUpdates: () => invoke(ipcChannels.installations.checkUpdates)
  },
  versions: {
    switch: (packageId: string, version: string) => invoke(ipcChannels.versions.switch, { packageId, version })
  },
  profiles: {
    list: () => invoke<EnvironmentProfile[]>(ipcChannels.profiles.list),
    create: (input: ProfileInput) => invoke(ipcChannels.profiles.create, input),
    update: (profileId: string, input: ProfileInput) => invoke(ipcChannels.profiles.update, { profileId, input }),
    remove: (profileId: string) => invoke(ipcChannels.profiles.remove, profileId),
    duplicate: (profileId: string) => invoke(ipcChannels.profiles.duplicate, profileId),
    exportManifest: (profileId: string) => invoke(ipcChannels.profiles.exportManifest, profileId),
    importManifest: () => invoke<ProfileImportResult>(ipcChannels.profiles.importManifest)
  },
  projects: {
    choose: () => invoke<string | null>(ipcChannels.projects.choose),
    inspect: (path: string) => invoke<ProjectInspection>(ipcChannels.projects.inspect, path),
    generate: (request) => invoke<ProjectGenerateResult>(ipcChannels.projects.generate, request),
    remove: (path: string) => invoke<ProjectRemoveResult>(ipcChannels.projects.remove, path)
  },
  environment: {
    list: () => invoke(ipcChannels.environment.list),
    pathEntries: (scope: EnvScope, name?: string) => invoke(ipcChannels.environment.pathEntries, { scope, name }),
    preview: (mutations: EnvironmentMutation[]) => invoke<EnvPreview>(ipcChannels.environment.preview, mutations),
    apply: (mutations: EnvironmentMutation[]) => invoke<EnvPreview>(ipcChannels.environment.apply, mutations),
    backups: () => invoke(ipcChannels.environment.backups),
    restore: (backupId: number) => invoke(ipcChannels.environment.restore, backupId),
    validate: () => invoke(ipcChannels.environment.validate),
    refreshEnvironment: () => invoke(ipcChannels.environment.refresh),
    doctor: () => invoke(ipcChannels.environment.doctor)
  },
  history: {
    list: (limit?: number) => invoke(ipcChannels.history.list, limit),
    get: (transactionId: string) => invoke(ipcChannels.history.get, transactionId)
  },
  settings: {
    get: () => invoke<AppSettings>(ipcChannels.settings.get),
    update: (patch: Partial<AppSettings>) => invoke<AppSettings>(ipcChannels.settings.update, patch),
    diagnostics: () => invoke(ipcChannels.settings.diagnostics),
    clearDownloads: () => invoke(ipcChannels.settings.clearDownloads),
    reset: () => invoke<AppSettings>(ipcChannels.settings.reset),
    databaseInfo: () => invoke<DatabaseInfo>(ipcChannels.settings.databaseInfo)
  },
  system: {
    openExternal: (url: string) => invoke(ipcChannels.system.openExternal, url),
    openPath: (path: string) => invoke(ipcChannels.system.openPath, path),
    showInFolder: (path: string) => invoke(ipcChannels.system.showInFolder, path)
  },
  events: {
    onQueueUpdate: (callback: (snapshot: QueueSnapshot) => void) =>
      subscribe(ipcChannels.events.queueUpdate, callback),
    onActivity: (callback: (entries: ActivityEntry[]) => void) =>
      subscribe(ipcChannels.events.activity, callback),
    onVerification: (callback: (run: VerificationRun) => void) =>
      subscribe(ipcChannels.events.verification, callback),
    onNotification: (callback: (notification: AppNotification) => void) =>
      subscribe(ipcChannels.events.notification, callback)
  }
}

contextBridge.exposeInMainWorld('devforge', api)
