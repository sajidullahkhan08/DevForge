import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '@shared/ipc'
import type { EnvironmentMutation } from '@shared/types'
import { AppError, formatErrorForIpc } from './services/errors'
import type { AppContext } from './context'

const packageIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80)
const versionSchema = z.string().min(1).max(80)
const idSchema = z.string().min(1).max(120)
const scopeSchema = z.enum(['user', 'system'])

const queueRetrySchema = z
  .object({
    itemId: idSchema,
    recoverDirectory: z.boolean().optional()
  })
  .strict()

const queueMoveSchema = z
  .object({
    itemId: idSchema,
    direction: z.enum(['up', 'down'])
  })
  .strict()

const requestsSchema = z
  .array(
    z
      .object({
        packageId: packageIdSchema,
        version: versionSchema.optional()
      })
      .strict()
  )
  .min(1)
  .max(20)

const environmentMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set-variable'), scope: scopeSchema, name: z.string().min(1).max(120), value: z.string().max(32767) }).strict(),
  z.object({ action: z.literal('remove-variable'), scope: scopeSchema, name: z.string().min(1).max(120) }).strict(),
  z
    .object({
      action: z.literal('add-path'),
      scope: scopeSchema,
      entries: z.array(z.string().min(1).max(1024)).min(1).max(30),
      strategy: z.enum(['append', 'prepend']).optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('remove-path'),
      scope: scopeSchema,
      entries: z.array(z.string().min(1).max(1024)).min(1).max(30)
    })
    .strict(),
  z.object({ action: z.literal('dedupe-path'), scope: scopeSchema }).strict()
])

const mutationsSchema = z.array(environmentMutationSchema).min(1).max(50)

const profileComponentSchema = z
  .object({
    packageId: packageIdSchema,
    optional: z.boolean().optional(),
    preferredVersion: versionSchema.nullable().optional()
  })
  .strict()

const profileInputSchema = z
  .object({
    name: z.string().min(2).max(60),
    description: z.string().max(400),
    audience: z.string().max(120),
    icon: z.string().max(60),
    components: z.array(profileComponentSchema).min(1).max(30)
  })
  .strict()

const settingsPatchSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']),
    startupPage: z.string().min(1).max(80),
    installDir: z.string().min(3).max(300),
    installScope: scopeSchema,
    defaultMethod: z.enum(['auto', 'winget', 'archive', 'official-installer']),
    downloadDir: z.string().min(3).max(300),
    concurrentDownloads: z.number().int().min(1).max(3),
    autoVerify: z.boolean(),
    confirmInstall: z.boolean(),
    envScope: scopeSchema,
    pathStrategy: z.enum(['append', 'prepend']),
    backupBeforeChange: z.boolean(),
    notifyOnComplete: z.boolean(),
    notifyOnFailure: z.boolean(),
    notifyOnUpdates: z.boolean(),
    checkUpstreamUpdates: z.boolean(),
    proxyUrl: z.string().max(500),
    proxyBypass: z.string().max(1000),
    keepInTray: z.boolean(),
    resumeQueueOnStartup: z.boolean(),
    language: z.literal('en')
  })
  .partial()
  .strict()

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new AppError('VALIDATION', `Invalid ${label}: ${result.error.issues[0]?.message ?? 'invalid value'}`)
  }
  return result.data
}

export function registerIpc(context: AppContext, getWindow: () => BrowserWindow | null): void {
  const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      throw new AppError('PERMISSION_DENIED', 'This request did not come from the DevForge window.')
    }
  }

  const handle = (channel: string, handler: (payload: unknown) => unknown): void => {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      try {
        assertTrustedSender(event)
        return await handler(payload)
      } catch (error) {
        throw formatErrorForIpc(error)
      }
    })
  }

  handle(ipcChannels.app.getInfo, () => context.getSystemInfo())
  handle(ipcChannels.app.getDashboard, () => context.dashboard.get())

  handle(ipcChannels.registry.list, () => context.catalogue.list())
  handle(ipcChannels.registry.get, (payload) => context.catalogue.get(parse(packageIdSchema, payload, 'package id')))
  handle(ipcChannels.registry.importPackage, async () => {
    const window = getWindow()
    const options: OpenDialogOptions = {
      title: 'Import a DevForge package definition',
      properties: ['openFile'],
      filters: [{ name: 'DevForge package', extensions: ['json'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null, package: null, warnings: [] }
    }
    const filePath = result.filePaths[0]
    if (statSync(filePath).size > 512 * 1024) {
      throw new AppError('VALIDATION', 'The package definition is too large (maximum 512 KB).')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
      throw new AppError('VALIDATION', 'The selected file is not valid JSON.', {
        details: error instanceof Error ? error.message : String(error)
      })
    }
    const imported = context.discovery.importCustomPackage(parsed)
    context.emitActivity()
    return { canceled: false, path: filePath, ...imported }
  })

  handle(ipcChannels.discovery.search, (payload) =>
    context.discovery.search(parse(z.string().trim().min(2).max(80), payload, 'search query'))
  )
  handle(ipcChannels.discovery.prepare, (payload) =>
    context.discovery.prepare(parse(z.string().min(3).max(300), payload, 'discovery result id'))
  )
  handle(ipcChannels.discovery.refresh, (payload) =>
    context.discovery.refreshManagedPackages(parse(z.boolean().optional(), payload, 'refresh option') ?? false)
  )

  handle(ipcChannels.plans.preview, (payload) => context.planner.preview(parse(requestsSchema, payload, 'installation request')))

  handle(ipcChannels.queue.get, () => context.queue.getSnapshot())
  handle(ipcChannels.queue.enqueue, (payload) => context.queue.enqueue(parse(requestsSchema, payload, 'installation request')))
  handle(ipcChannels.queue.start, () => context.queue.start())
  handle(ipcChannels.queue.pause, () => context.queue.pause())
  handle(ipcChannels.queue.resume, () => context.queue.resume())
  handle(ipcChannels.queue.cancel, (payload) => context.queue.cancel(parse(idSchema, payload, 'queue item id')))
  handle(ipcChannels.queue.retry, (payload) => {
    const input = parse(queueRetrySchema, payload, 'queue retry request')
    return context.queue.retry(input.itemId, { recoverDirectory: input.recoverDirectory })
  })
  handle(ipcChannels.queue.remove, (payload) => context.queue.remove(parse(idSchema, payload, 'queue item id')))
  handle(ipcChannels.queue.move, (payload) => {
    const input = parse(queueMoveSchema, payload, 'queue move request')
    return context.queue.move(input.itemId, input.direction)
  })
  handle(ipcChannels.queue.clearCompleted, () => context.queue.clearCompleted())

  handle(ipcChannels.installations.list, () => context.listInstalled())
  handle(ipcChannels.installations.refresh, () => context.refreshInstalled())
  handle(ipcChannels.installations.verify, async (payload) => {
    const packageId = parse(packageIdSchema, payload, 'package id')
    const pkg = context.registry.getPackage(packageId)
    if (!pkg) throw new AppError('NOT_FOUND', 'That package is not in the registry.')
    const records = context.db
      .listInstallationsForPackage(packageId)
      .filter((record) => record.status === 'installed')
    const record = records.find((candidate) => candidate.isActive) ?? records[0] ?? null
    if (!record) throw new AppError('NOT_FOUND', `${pkg.name} is not installed.`)
    const run = await context.verification.verify(pkg, {
      version: record.detectedVersion ?? record.version,
      installDir: record.installDir
    })
    context.emitVerification(run)
    context.emitActivity()
    return run
  })
  handle(ipcChannels.installations.repair, async (payload) => {
    const packageId = parse(packageIdSchema, payload, 'package id')
    const preview = await context.engine.repair(packageId)
    context.emitActivity()
    return preview
  })
  handle(ipcChannels.installations.uninstall, async (payload) => {
    const parsed = parse(
      z.object({ packageId: packageIdSchema, options: z.object({ removeDirectory: z.boolean().optional() }).strict().optional() }).strict(),
      payload,
      'uninstall request'
    )
    const result = await context.engine.uninstall(parsed.packageId, parsed.options ?? {})
    context.emitActivity()
    return result
  })
  handle(ipcChannels.installations.openDirectory, (payload) =>
    context.openInstallationDirectory(parse(packageIdSchema, payload, 'package id'))
  )
  handle(ipcChannels.installations.checkUpdates, async () => {
    const updates = await context.engine.checkUpdates()
    context.emitActivity()
    return updates
  })

  handle(ipcChannels.versions.switch, async (payload) => {
    const parsed = parse(
      z.object({ packageId: packageIdSchema, version: versionSchema }).strict(),
      payload,
      'version switch request'
    )
    return context.engine.switchVersion(parsed.packageId, parsed.version)
  })

  handle(ipcChannels.profiles.list, () => context.profiles.list())
  handle(ipcChannels.profiles.create, (payload) => context.profiles.create(parse(profileInputSchema, payload, 'profile')))
  handle(ipcChannels.profiles.update, (payload) => {
    const parsed = parse(
      z.object({ profileId: idSchema, input: profileInputSchema }).strict(),
      payload,
      'profile update'
    )
    return context.profiles.update(parsed.profileId, parsed.input)
  })
  handle(ipcChannels.profiles.remove, (payload) => {
    context.profiles.remove(parse(idSchema, payload, 'profile id'))
    return null
  })
  handle(ipcChannels.profiles.duplicate, (payload) => context.profiles.duplicate(parse(idSchema, payload, 'profile id')))
  handle(ipcChannels.profiles.exportManifest, async (payload) => {
    const profileId = parse(idSchema, payload, 'profile id')
    const manifest = context.profiles.exportManifest(profileId, app.getVersion())
    const safeName = manifest.name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 60) || 'environment'
    const window = getWindow()
    const options = {
      title: 'Export DevForge environment manifest',
      defaultPath: join(app.getPath('documents'), `${safeName}.devforge.json`),
      filters: [{ name: 'DevForge environment', extensions: ['json'] }]
    }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) {
      return { canceled: true, path: null }
    }
    writeFileSync(result.filePath, JSON.stringify(manifest, null, 2), 'utf8')
    context.logger.info('Environment manifest exported', { path: result.filePath })
    return { canceled: false, path: result.filePath }
  })
  handle(ipcChannels.profiles.importManifest, async () => {
    const window = getWindow()
    const options = {
      title: 'Import a DevForge environment manifest',
      properties: ['openFile' as const],
      filters: [{ name: 'DevForge environment', extensions: ['json'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null, profile: null, warnings: [] }
    }
    const filePath = result.filePaths[0]
    if (statSync(filePath).size > 1024 * 1024) {
      throw new AppError('VALIDATION', 'That manifest is larger than 1 MB and was rejected.')
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
      throw new AppError('VALIDATION', 'That file is not valid JSON.', {
        details: error instanceof Error ? error.message : String(error)
      })
    }
    const imported = context.profiles.importManifest(raw)
    context.emitActivity()
    return { canceled: false, path: filePath, profile: imported.profile, warnings: imported.warnings }
  })

  handle(ipcChannels.projects.choose, async () => {
    const window = getWindow()
    const options = {
      title: 'Choose a project folder',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  handle(ipcChannels.projects.inspect, (payload) =>
    context.projects.inspect(parse(z.string().min(3).max(1024), payload, 'project folder'))
  )
  handle(ipcChannels.projects.generate, (payload) => {
    const parsed = parse(
      z
        .object({
          path: z.string().min(3).max(1024),
          packages: z.record(packageIdSchema, versionSchema)
        })
        .strict()
        .refine((value) => Object.keys(value.packages).length > 0 && Object.keys(value.packages).length <= 30, {
          message: 'Select between 1 and 30 package versions.'
        }),
      payload,
      'project environment'
    )
    const result = context.projects.generate(parsed)
    context.emitActivity()
    return result
  })
  handle(ipcChannels.projects.remove, (payload) =>
    context.projects.remove(parse(z.string().min(3).max(1024), payload, 'project folder'))
  )

  handle(ipcChannels.environment.list, () => context.env.listVariables())
  handle(ipcChannels.environment.pathEntries, (payload) => {
    const parsed = parse(
      z.object({ scope: scopeSchema, name: z.string().min(1).max(120).optional() }).strict(),
      payload,
      'PATH request'
    )
    return context.env.pathEntries(parsed.scope, parsed.name ?? 'PATH')
  })
  handle(ipcChannels.environment.preview, (payload) =>
    context.env.preview(parse(mutationsSchema, payload, 'environment change') as EnvironmentMutation[])
  )
  handle(ipcChannels.environment.apply, async (payload) => {
    const preview = await context.env.apply(parse(mutationsSchema, payload, 'environment change') as EnvironmentMutation[])
    context.emitActivity()
    return preview
  })
  handle(ipcChannels.environment.backups, () => context.env.backups(200))
  handle(ipcChannels.environment.restore, async (payload) => {
    const backupId = parse(z.number().int().positive(), payload, 'backup id')
    const result = await context.env.restoreBackup(backupId)
    context.emitActivity()
    return result
  })
  handle(ipcChannels.environment.validate, () => context.env.validate())
  handle(ipcChannels.environment.doctor, () => context.env.doctor())
  handle(ipcChannels.environment.refresh, async () => {
    context.env.invalidate()
    const refreshed = await context.env.broadcastEnvironmentChange()
    context.emitActivity()
    return {
      refreshed,
      message: refreshed
        ? 'Windows was notified about environment changes. New terminals will use the latest values.'
        : 'DevForge could not confirm the Windows environment broadcast. Open a new terminal to load the current values.'
    }
  })

  handle(ipcChannels.history.list, (payload) => {
    const limit = payload === undefined ? 200 : parse(z.number().int().min(1).max(1000), payload, 'history limit')
    return context.db.listTransactions(limit)
  })
  handle(ipcChannels.history.get, (payload) => context.db.getTransaction(parse(idSchema, payload, 'transaction id')))

  handle(ipcChannels.settings.get, () => context.settings.get())
  handle(ipcChannels.settings.update, async (payload) => {
    const updated = context.settings.update(parse(settingsPatchSchema, payload, 'settings'))
    await context.applyNetworkSettings()
    return updated
  })
  handle(ipcChannels.settings.diagnostics, () => context.settings.diagnostics())
  handle(ipcChannels.settings.clearDownloads, () => context.settings.clearDownloads())
  handle(ipcChannels.settings.reset, () => context.settings.reset())
  handle(ipcChannels.settings.databaseInfo, async () => {
    const info = context.settings.databaseInfo()
    return { ...info, sizeBytes: await context.databaseFileSize() }
  })

  handle(ipcChannels.system.openExternal, (payload) =>
    context.openExternal(parse(z.string().min(1).max(2048), payload, 'URL'))
  )
  handle(ipcChannels.system.openPath, (payload) =>
    context.openPath(parse(z.string().min(1).max(4096), payload, 'path'))
  )
  handle(ipcChannels.system.showInFolder, (payload) =>
    context.showInFolder(parse(z.string().min(1).max(4096), payload, 'path'))
  )
}
