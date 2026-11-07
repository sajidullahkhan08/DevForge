export const ipcChannels = {
  app: {
    getInfo: 'app:get-info',
    getDashboard: 'app:get-dashboard'
  },
  registry: {
    list: 'registry:list',
    get: 'registry:get',
    importPackage: 'registry:import-package'
  },
  discovery: {
    search: 'discovery:search',
    prepare: 'discovery:prepare',
    refresh: 'discovery:refresh'
  },
  plans: {
    preview: 'plans:preview'
  },
  queue: {
    get: 'queue:get',
    enqueue: 'queue:enqueue',
    start: 'queue:start',
    pause: 'queue:pause',
    resume: 'queue:resume',
    cancel: 'queue:cancel',
    retry: 'queue:retry',
    remove: 'queue:remove',
    move: 'queue:move',
    clearCompleted: 'queue:clear-completed'
  },
  installations: {
    list: 'installations:list',
    refresh: 'installations:refresh',
    verify: 'installations:verify',
    repair: 'installations:repair',
    uninstall: 'installations:uninstall',
    openDirectory: 'installations:open-directory',
    checkUpdates: 'installations:check-updates'
  },
  versions: {
    switch: 'versions:switch'
  },
  profiles: {
    list: 'profiles:list',
    create: 'profiles:create',
    update: 'profiles:update',
    remove: 'profiles:remove',
    duplicate: 'profiles:duplicate',
    exportManifest: 'profiles:export-manifest',
    importManifest: 'profiles:import-manifest'
  },
  projects: {
    choose: 'projects:choose',
    inspect: 'projects:inspect',
    generate: 'projects:generate',
    remove: 'projects:remove'
  },
  environment: {
    list: 'environment:list',
    pathEntries: 'environment:path-entries',
    preview: 'environment:preview',
    apply: 'environment:apply',
    backups: 'environment:backups',
    restore: 'environment:restore',
    validate: 'environment:validate',
    refresh: 'environment:refresh',
    doctor: 'environment:doctor'
  },
  history: {
    list: 'history:list',
    get: 'history:get'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    diagnostics: 'settings:diagnostics',
    clearDownloads: 'settings:clear-downloads',
    reset: 'settings:reset',
    databaseInfo: 'settings:database-info'
  },
  system: {
    openExternal: 'system:open-external',
    openPath: 'system:open-path',
    showInFolder: 'system:show-in-folder'
  },
  events: {
    queueUpdate: 'event:queue-update',
    activity: 'event:activity',
    verification: 'event:verification',
    notification: 'event:notification'
  }
} as const
