import { existsSync } from 'node:fs'
import type {
  AppSettings,
  DoctorAction,
  EnvBackup,
  EnvChange,
  EnvPreview,
  EnvScope,
  EnvVariable,
  EnvironmentDoctorReport,
  EnvironmentMutation,
  HealthCheck,
  PathEntry
} from '@shared/types'
import type { PackageDefinition } from '@shared/registry'
import {
  addPathEntries,
  createSimpleExpander,
  dedupePathEntries,
  findDuplicatePathEntries,
  normalizePathEntry,
  removePathEntries,
  splitPathValue,
  stripQuotes
} from '@shared/path-utils'
import { AppDatabase } from '../database/Database'
import { AppError } from '../errors'
import { Logger } from '../logging/Logger'
import { ProcessExecutor } from '../process/ProcessExecutor'
import { powershellScripts, PowerShellService } from '../system/PowerShellService'
import { buildTemplateContext, resolveTemplate } from './TemplateResolver'

interface RawVariable {
  name: string
  value: string
  kind: string
}

interface EnvSnapshot {
  user: Map<string, RawVariable>
  system: Map<string, RawVariable>
  takenAt: number
}

const protectedNames = new Set([
  'path',
  'comspec',
  'pathext',
  'systemroot',
  'windir',
  'temp',
  'tmp',
  'userprofile',
  'appdata',
  'localappdata',
  'programfiles',
  'programfiles(x86)',
  'programdata',
  'homedrive',
  'homepath',
  'username',
  'os',
  'processor_architecture'
])

const snapshotTtlMs = 4000

export class EnvironmentManager {
  private snapshot: EnvSnapshot | null = null
  private elevated: { value: boolean; takenAt: number } | null = null
  private wingetVersion: { value: string | null; takenAt: number } | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly ps: PowerShellService,
    private readonly executor: ProcessExecutor,
    private readonly logger: Logger,
    private readonly getSettings: () => AppSettings,
    private readonly toolsDir: () => string
  ) {}

  invalidate(): void {
    this.snapshot = null
  }

  async isElevated(): Promise<boolean> {
    if (this.elevated && Date.now() - this.elevated.takenAt < 60000) return this.elevated.value
    try {
      const result = await this.ps.run(powershellScripts.isElevated, undefined, 15000)
      const value = result.stdout.trim().toLowerCase() === 'true'
      this.elevated = { value, takenAt: Date.now() }
      return value
    } catch (error) {
      this.logger.warn('Could not determine elevation state', { error: String(error) })
      return false
    }
  }

  async getWingetVersion(): Promise<string | null> {
    if (this.wingetVersion && Date.now() - this.wingetVersion.takenAt < 60000) {
      return this.wingetVersion.value
    }
    try {
      const result = await this.executor.run('winget', ['--version'], {
        env: await this.getMergedProcessEnv(),
        timeoutMs: 15000
      })
      const value = result.stdout.trim() || null
      this.wingetVersion = { value, takenAt: Date.now() }
      return value
    } catch {
      this.wingetVersion = { value: null, takenAt: Date.now() }
      return null
    }
  }

  private async readSnapshot(force = false): Promise<EnvSnapshot> {
    if (!force && this.snapshot && Date.now() - this.snapshot.takenAt < snapshotTtlMs) {
      return this.snapshot
    }
    const [user, system] = await Promise.all([this.readScope('user'), this.readScope('system')])
    this.snapshot = { user, system, takenAt: Date.now() }
    return this.snapshot
  }

  private async readScope(scope: EnvScope): Promise<Map<string, RawVariable>> {
    const rows = await this.ps.runJson<RawVariable[] | RawVariable>(powershellScripts.readEnvironment, { scope }, 30000)
    const list = Array.isArray(rows) ? rows : rows ? [rows] : []
    const map = new Map<string, RawVariable>()
    for (const row of list) {
      if (!row || typeof row.name !== 'string') continue
      map.set(row.name.toLowerCase(), {
        name: row.name,
        value: row.value ?? '',
        kind: row.kind ?? 'String'
      })
    }
    return map
  }

  async getRawVariable(scope: EnvScope, name: string): Promise<RawVariable | null> {
    const snapshot = await this.readSnapshot(true)
    const source = scope === 'user' ? snapshot.user : snapshot.system
    return source.get(name.toLowerCase()) ?? null
  }

  private getExpander(snapshot: EnvSnapshot): (value: string) => string {
    const vars: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') vars[key] = value
    }
    for (const variable of snapshot.system.values()) vars[variable.name] = variable.value
    for (const variable of snapshot.user.values()) vars[variable.name] = variable.value
    return createSimpleExpander(vars)
  }

  async listVariables(): Promise<EnvVariable[]> {
    const snapshot = await this.readSnapshot(true)
    const expand = this.getExpander(snapshot)
    const managedRows = this.db.listManagedVariables()
    const managedMap = new Map(managedRows.map((row) => [`${row.scope}:${row.name.toLowerCase()}`, row]))
    const activeEntries = this.db.listActiveManagedPathEntries()

    const results: EnvVariable[] = []
    const scopes: EnvScope[] = ['user', 'system']

    for (const scope of scopes) {
      const source = scope === 'user' ? snapshot.user : snapshot.system
      for (const variable of source.values()) {
        const lower = variable.name.toLowerCase()
        const isPath = lower === 'path'
        const managedRow = managedMap.get(`${scope}:${lower}`)
        if (scope === 'system' && !isPath && !managedRow) continue

        let managedEntries: string[] | null = null
        if (isPath) {
          const expanded = new Set(splitPathValue(variable.value).map((entry) => normalizePathEntry(entry, expand)))
          managedEntries = activeEntries
            .filter((entry) => entry.scope === scope)
            .map((entry) => entry.entry)
            .filter((entry) => expanded.has(normalizePathEntry(entry, expand)))
        }

        const duplicates = isPath ? findDuplicatePathEntries(variable.value, expand) : []
        let status: EnvVariable['status'] = 'valid'
        if (isPath && duplicates.length > 0) status = 'invalid'
        if (!isPath && /(_HOME|_ROOT)$/i.test(variable.name)) {
          const resolved = expand(variable.value)
          if (resolved && !existsSync(stripQuotes(resolved))) status = 'invalid'
        }

        results.push({
          name: variable.name,
          value: variable.value,
          scope,
          kind: isPath ? 'path' : 'variable',
          managedByDevForge: Boolean(managedRow) || Boolean(managedEntries && managedEntries.length > 0),
          originalValue: managedRow?.originalValue ?? null,
          updatedAt: managedRow?.updatedAt ?? null,
          status,
          entryCount: isPath ? splitPathValue(variable.value).filter((entry) => entry.trim() !== '').length : null,
          managedEntries
        })
      }
    }

    return results.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'path' ? -1 : 1
      if (a.managedByDevForge !== b.managedByDevForge) return a.managedByDevForge ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  async pathEntries(scope: EnvScope, name = 'PATH'): Promise<PathEntry[]> {
    const snapshot = await this.readSnapshot(true)
    const expand = this.getExpander(snapshot)
    const source = scope === 'user' ? snapshot.user : snapshot.system
    const variable = source.get(name.toLowerCase())
    if (!variable) return []
    const rawEntries = splitPathValue(variable.value)
    const normalized = new Map<string, number>()
    const managed = new Set(
      this.db
        .listActiveManagedPathEntries()
        .filter((entry) => entry.scope === scope)
        .map((entry) => normalizePathEntry(entry.entry, expand))
    )

    let index = 0
    return rawEntries
      .filter((entry) => entry.trim() !== '')
      .map((entry) => {
        const key = normalizePathEntry(entry, expand)
        const duplicate = normalized.has(key)
        normalized.set(key, (normalized.get(key) ?? 0) + 1)
        const resolved = expand(stripQuotes(entry))
        const result: PathEntry = {
          index: index++,
          raw: entry,
          resolved,
          exists: resolved ? existsSync(resolved) : false,
          duplicate,
          managed: managed.has(key)
        }
        return result
      })
  }

  private looksLikePath(value: string): boolean {
    return /^[a-zA-Z]:\\/.test(value) || /^%[^%]+%/.test(value) || /^\\\\/.test(value)
  }

  private validateVariableName(name: string): string | null {
    if (!/^[A-Za-z_][A-Za-z0-9_()]*$/.test(name)) {
      return 'Variable names may contain letters, digits, underscores and parentheses only.'
    }
    return null
  }

  async preview(mutations: EnvironmentMutation[]): Promise<EnvPreview> {
    const snapshot = await this.readSnapshot(true)
    const expand = this.getExpander(snapshot)
    const elevated = await this.isElevated()
    const changes: EnvChange[] = []
    const warnings: string[] = []
    const errors: string[] = []
    let requiresAdmin = false
    let satisfiedRequests = 0
    let requestedOperations = 0

    if (!Array.isArray(mutations) || mutations.length === 0) {
      return {
        changes,
        warnings,
        errors: ['No environment changes were requested.'],
        requiresAdmin,
        canApply: false,
        appliedBackupIds: [],
        outcome: 'nothing-to-do'
      }
    }
    if (mutations.length > 50) {
      return {
        changes,
        warnings,
        errors: ['Too many environment changes in one operation.'],
        requiresAdmin,
        canApply: false,
        appliedBackupIds: [],
        outcome: 'nothing-to-do'
      }
    }

    const overlay = new Map<string, string | null>()
    const readValue = (scope: EnvScope, name: string): string | null => {
      const key = `${scope}:${name.toLowerCase()}`
      if (overlay.has(key)) return overlay.get(key) ?? null
      const source = scope === 'user' ? snapshot.user : snapshot.system
      return source.get(name.toLowerCase())?.value ?? null
    }
    const writeOverlay = (scope: EnvScope, name: string, value: string | null): void => {
      overlay.set(`${scope}:${name.toLowerCase()}`, value)
    }

    for (const mutation of mutations) {
      const scope = mutation.scope
      if (scope !== 'user' && scope !== 'system') {
        errors.push('Unknown environment scope.')
        continue
      }
      if (scope === 'system') requiresAdmin = true

      if (mutation.action === 'set-variable' || mutation.action === 'remove-variable') {
        const error = this.validateVariableName(mutation.name)
        if (error) {
          errors.push(error)
          continue
        }
        const lower = mutation.name.toLowerCase()
        if (lower === 'path') {
          errors.push('Use PATH entry operations to change PATH safely.')
          continue
        }
        if (protectedNames.has(lower)) {
          errors.push(`"${mutation.name}" is protected by Windows. DevForge will not modify it.`)
          continue
        }

        requestedOperations += 1
        const current = readValue(scope, mutation.name)
        if (mutation.action === 'remove-variable') {
          const managed = this.db
            .listManagedVariables()
            .some((row) => row.scope === scope && row.name.toLowerCase() === lower)
          if (!managed) {
            errors.push(`DevForge did not create "${mutation.name}", so it will not remove it.`)
            continue
          }
          if (current === null) {
            satisfiedRequests += 1
            continue
          }
          changes.push({
            scope,
            name: mutation.name,
            kind: 'variable',
            operation: 'remove-variable',
            before: current,
            after: null,
            addedEntries: [],
            removedEntries: [],
            reason: 'Remove a variable created by DevForge'
          })
          writeOverlay(scope, mutation.name, null)
          continue
        }

        const value = mutation.value
        if (value.includes('\u0000') || /[\r\n]/.test(value)) {
          errors.push(`The value for "${mutation.name}" contains invalid control characters.`)
          continue
        }
        if (value.length > 32767) {
          errors.push(`The value for "${mutation.name}" is too long. Windows limits environment variables to 32,767 characters.`)
          continue
        }
        if (current === value) {
          satisfiedRequests += 1
          continue
        }
        if (this.looksLikePath(value) && !existsSync(stripQuotes(expand(value)))) {
          warnings.push(`The path "${value}" does not exist right now.`)
        }
        changes.push({
          scope,
          name: mutation.name,
          kind: 'variable',
          operation: current === null ? 'create' : 'update',
          before: current,
          after: value,
          addedEntries: [],
          removedEntries: [],
          reason: null
        })
        writeOverlay(scope, mutation.name, value)
        continue
      }

      if (mutation.action === 'add-path') {
        const entries = mutation.entries.map((entry) => entry.trim()).filter(Boolean)
        if (entries.length === 0) {
          errors.push('No PATH entries were provided.')
          continue
        }
        if (entries.some((entry) => entry.includes('\u0000') || /[\r\n]/.test(entry))) {
          errors.push('A PATH entry contains invalid control characters.')
          continue
        }
        requestedOperations += 1
        const current = readValue(scope, 'Path')
        const result = addPathEntries(current, entries, expand, mutation.strategy ?? this.getSettings().pathStrategy)
        if (result.added.length === 0) {
          satisfiedRequests += 1
          const missingDirectories = entries.filter((entry) => !existsSync(stripQuotes(expand(entry))))
          if (missingDirectories.length > 0) {
            warnings.push(
              `PATH already contains ${missingDirectories.length === 1 ? 'the requested entry' : 'the requested entries'}, but ${
                missingDirectories.length === 1 ? 'this directory does' : 'these directories do'
              } not exist yet: ${missingDirectories.join('; ')}. DevForge did not change PATH.`
            )
          } else {
            warnings.push('All requested PATH entries are already present. No PATH changes were required.')
          }
          const duplicates = findDuplicatePathEntries(current, expand)
          if (duplicates.length > 0) {
            warnings.push(
              `PATH contains ${duplicates.length} duplicate ${duplicates.length === 1 ? 'entry' : 'entries'} that DevForge left untouched.`
            )
          }
          continue
        }
        for (const entry of result.added) {
          if (!existsSync(stripQuotes(expand(entry)))) {
            warnings.push(`PATH entry "${entry}" does not exist yet. The tool may not run until that directory is created.`)
          }
        }
        if (result.value.length > 30000) {
          warnings.push('PATH is approaching the Windows length limit. Consider enabling the long PATH registry setting or removing unused entries.')
        }
        if (result.value.length > 32000) {
          errors.push('PATH would exceed the Windows environment variable size limit.')
          continue
        }
        changes.push({
          scope,
          name: 'Path',
          kind: 'path',
          operation: 'append-path',
          before: current,
          after: result.value,
          addedEntries: result.added,
          removedEntries: [],
          reason: null
        })
        writeOverlay(scope, 'Path', result.value)
        continue
      }

      if (mutation.action === 'dedupe-path') {
        requestedOperations += 1
        const current = readValue(scope, 'Path')
        const result = dedupePathEntries(current, expand)
        if (result.removed.length === 0) {
          satisfiedRequests += 1
          continue
        }
        changes.push({
          scope,
          name: 'Path',
          kind: 'path',
          operation: 'dedupe-path',
          before: current,
          after: result.value,
          addedEntries: [],
          removedEntries: result.removed,
          reason: 'Remove duplicate PATH entries'
        })
        writeOverlay(scope, 'Path', result.value)
        continue
      }

      if (mutation.action === 'remove-path') {
        const entries = mutation.entries.map((entry) => entry.trim()).filter(Boolean)
        if (entries.length === 0) {
          errors.push('No PATH entries were provided.')
          continue
        }
        requestedOperations += 1
        const current = readValue(scope, 'Path')
        const result = removePathEntries(current, entries, expand)
        if (result.removed.length === 0) {
          satisfiedRequests += 1
          warnings.push('The selected PATH entries were not present. No changes were required.')
          continue
        }
        const managedKeys = new Set(
          this.db
            .listActiveManagedPathEntries()
            .filter((entry) => entry.scope === scope)
            .map((entry) => normalizePathEntry(entry.entry, expand))
        )
        const unmanaged = result.removed.filter((entry) => !managedKeys.has(normalizePathEntry(entry, expand)))
        if (unmanaged.length > 0) {
          warnings.push(`You are removing ${unmanaged.length} PATH entr${unmanaged.length === 1 ? 'y' : 'ies'} that DevForge did not add.`)
        }
        changes.push({
          scope,
          name: 'Path',
          kind: 'path',
          operation: 'remove-path',
          before: current,
          after: result.value,
          addedEntries: [],
          removedEntries: result.removed,
          reason: null
        })
        writeOverlay(scope, 'Path', result.value)
      }
    }

    if (requiresAdmin && !elevated) {
      errors.push('Changing system environment variables requires administrator permission. Restart DevForge as administrator to apply system-wide changes.')
    }

    const outcome: EnvPreview['outcome'] =
      errors.length > 0
        ? 'pending'
        : changes.length > 0
          ? 'pending'
          : satisfiedRequests > 0 || requestedOperations > 0
            ? 'already-satisfied'
            : 'nothing-to-do'

    return {
      changes,
      warnings,
      errors,
      requiresAdmin,
      canApply: errors.length === 0 && changes.length > 0,
      appliedBackupIds: [],
      outcome
    }
  }

  async apply(
    mutations: EnvironmentMutation[],
    context: { transactionId?: string | null; packageId?: string | null; reason?: string | null } = {}
  ): Promise<EnvPreview> {
    const preview = await this.preview(mutations)
    if (preview.errors.length > 0) {
      throw new AppError('ENVIRONMENT_FAILED', preview.errors[0], {
        hint: preview.errors.slice(1).join(' ') || null
      })
    }
    if (preview.changes.length === 0) {
      return { ...preview, canApply: true }
    }

    const elevated = await this.isElevated()
    if (preview.requiresAdmin && !elevated) {
      throw new AppError('ADMIN_REQUIRED', 'Administrator permission is required for system environment changes.')
    }

    const backupIds: number[] = []
    const snapshot = await this.readSnapshot(true)
    const expand = this.getExpander(snapshot)
    const currentSnapshot = snapshot
    let appliedCount = 0
    let writeFailure: { error: unknown; name: string; scope: EnvScope } | null = null

    for (const change of preview.changes) {
      const scope = change.scope
      const source = scope === 'user' ? currentSnapshot.user : currentSnapshot.system
      const existing = source.get(change.name.toLowerCase())
      const actualBefore = existing?.value ?? null

      let newValue: string | null = change.after
      if (change.operation === 'append-path') {
        newValue = addPathEntries(actualBefore, change.addedEntries, expand, 'append').value
      } else if (change.operation === 'remove-path') {
        newValue = removePathEntries(actualBefore, change.removedEntries, expand).value
      } else if (change.operation === 'dedupe-path') {
        newValue = dedupePathEntries(actualBefore, expand).value
      }
      if (change.operation === 'remove-variable') newValue = null

      if (newValue === actualBefore) continue

      const isPath = change.kind === 'path'
      const expandable = isPath || existing?.kind === 'ExpandString' || /%[^%]+%/.test(newValue ?? '')

      try {
        await this.ps.run(
          powershellScripts.writeEnvironment,
          {
            scope,
            name: change.name,
            value: newValue ?? '',
            delete: newValue === null,
            expandable
          },
          30000
        )
      } catch (error) {
        writeFailure = { error, name: change.name, scope }
        break
      }

      const backupId = this.db.addEnvironmentBackup({
        scope,
        name: change.name,
        kind: change.kind,
        changeType: change.operation,
        previousValue: actualBefore,
        newValue,
        addedEntries: change.addedEntries,
        removedEntries: change.removedEntries,
        transactionId: context.transactionId ?? null,
        packageId: context.packageId ?? null
      })
      backupIds.push(backupId)

      if (newValue === null) {
        this.db.deleteManagedVariable(scope, change.name)
      } else {
        this.db.upsertManagedVariable({
          scope,
          name: change.name,
          value: newValue,
          kind: change.kind,
          originalValue: actualBefore
        })
      }

      const updated: RawVariable = {
        name: change.name,
        value: newValue ?? '',
        kind: expandable ? 'ExpandString' : 'String'
      }
      if (newValue === null) {
        source.delete(change.name.toLowerCase())
      } else {
        source.set(change.name.toLowerCase(), updated)
      }
      appliedCount += 1
    }

    if (writeFailure) {
      this.invalidate()
      await this.broadcastEnvironmentChange()
      const details = `Applied ${appliedCount} of ${preview.changes.length} changes. ${
        writeFailure.error instanceof Error ? writeFailure.error.message : String(writeFailure.error)
      }`
      if (appliedCount > 0) {
        throw new AppError(
          'ENVIRONMENT_PARTIALLY_APPLIED',
          `Could not update ${writeFailure.name} in the ${writeFailure.scope} environment after applying ${appliedCount} other ${
            appliedCount === 1 ? 'change' : 'changes'
          }.`,
          {
            hint: 'The applied changes were backed up individually. Review Environment Variables, then retry the remaining configuration.',
            details
          }
        )
      }
      throw new AppError('ENVIRONMENT_FAILED', `Could not update ${writeFailure.name} in the ${writeFailure.scope} environment.`, {
        hint: writeFailure.scope === 'system' ? 'Restart DevForge as administrator and try again.' : 'Check permissions for your user environment.',
        details
      })
    }

    if (appliedCount === 0) {
      this.invalidate()
      return { ...preview, canApply: true, outcome: 'already-satisfied' }
    }

    this.invalidate()
    const broadcast = await this.broadcastEnvironmentChange()

    const verified = await this.verifyAppliedChanges(preview.changes)
    const warnings = [...preview.warnings]
    if (!broadcast) {
      warnings.push('Windows did not confirm the environment change notification. Open a new terminal to pick up the updated variables.')
    }
    warnings.push(...verified)

    this.logger.info('Applied environment changes', {
      count: appliedCount,
      backupIds,
      context
    })

    return {
      ...preview,
      warnings,
      appliedBackupIds: backupIds,
      canApply: true,
      outcome: 'applied'
    }
  }

  private async verifyAppliedChanges(changes: EnvChange[]): Promise<string[]> {
    const warnings: string[] = []
    try {
      const snapshot = await this.readSnapshot(true)
      const expand = this.getExpander(snapshot)
      for (const change of changes) {
        const source = change.scope === 'user' ? snapshot.user : snapshot.system
        const variable = source.get(change.name.toLowerCase())
        const actual = variable?.value ?? null
        if (change.kind === 'path') {
          const entries = splitPathValue(actual)
          for (const entry of change.addedEntries) {
            if (!entries.some((candidate) => normalizePathEntry(candidate, expand) === normalizePathEntry(entry, expand))) {
              warnings.push(`Verification could not confirm that "${entry}" was added to PATH.`)
            }
          }
          if (change.after !== null && actual !== change.after) {
            const missing = change.addedEntries.length > 0
            if (!missing) warnings.push('PATH changed while DevForge was applying the update. Review the current value.')
          }
        } else if (actual !== change.after) {
          warnings.push(`${change.name} does not match the value DevForge wrote. Another program may have changed it.`)
        }
      }
    } catch (error) {
      warnings.push('DevForge could not re-read the environment to verify the change.')
      this.logger.warn('Environment verification failed', { error: String(error) })
    }
    return warnings
  }

  async broadcastEnvironmentChange(): Promise<boolean> {
    try {
      const result = await this.ps.run(powershellScripts.broadcastEnvironmentChange, undefined, 15000)
      return result.stdout.includes('broadcast')
    } catch (error) {
      this.logger.warn('Could not broadcast environment change', { error: String(error) })
      return false
    }
  }

  async applyPackageEnvironment(
    pkg: PackageDefinition,
    installDir: string | null,
    context: { transactionId?: string | null; packageId?: string | null; version?: string | null }
  ): Promise<EnvPreview> {
    const templateContext = buildTemplateContext({
      installDir,
      toolsDir: this.toolsDir(),
      version: context.version ?? null,
      packageName: pkg.name
    })

    const pathEntriesByScope = new Map<EnvScope, string[]>()
    const variables: { scope: EnvScope; name: string; value: string }[] = []
    const warnings: string[] = []

    for (const spec of pkg.environment) {
      try {
        const value = resolveTemplate(spec.valueTemplate, templateContext)
        if (!value.trim()) continue
        if (spec.kind === 'path') {
          const list = pathEntriesByScope.get(spec.scope) ?? []
          list.push(value)
          pathEntriesByScope.set(spec.scope, list)
        } else {
          variables.push({ scope: spec.scope, name: spec.name, value })
        }
      } catch (error) {
        warnings.push(
          `Could not resolve environment template "${spec.valueTemplate}" for ${pkg.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    const mutations: EnvironmentMutation[] = []
    for (const [scope, entries] of pathEntriesByScope) {
      mutations.push({ action: 'add-path', scope, entries, strategy: this.getSettings().pathStrategy })
    }
    for (const variable of variables) {
      mutations.push({ action: 'set-variable', scope: variable.scope, name: variable.name, value: variable.value })
    }

    if (mutations.length === 0) {
      return {
        changes: [],
        warnings,
        errors: [],
        requiresAdmin: false,
        canApply: false,
        appliedBackupIds: [],
        outcome: 'nothing-to-do'
      }
    }

    const result = await this.apply(mutations, {
      transactionId: context.transactionId ?? null,
      packageId: context.packageId ?? pkg.id
    })
    return { ...result, warnings: [...warnings, ...result.warnings] }
  }

  async restoreBackup(backupId: number, reason = 'Restore environment change'): Promise<{ success: boolean; preview: EnvPreview; message: string }> {
    const backup = this.db.getEnvironmentBackup(backupId)
    if (!backup) throw new AppError('NOT_FOUND', 'That environment backup was not found.')
    if (backup.restoredAt) {
      return {
        success: false,
        preview: { changes: [], warnings: [], errors: ['This change has already been restored.'], requiresAdmin: false, canApply: false, appliedBackupIds: [], outcome: 'nothing-to-do' },
        message: 'This change has already been restored.'
      }
    }

    const current = (await this.getRawVariable(backup.scope, backup.name))?.value ?? null
    const mutations: EnvironmentMutation[] = []
    let conflict: string | null = null

    if (backup.changeType === 'append-path') {
      mutations.push({ action: 'remove-path', scope: backup.scope, entries: backup.addedEntries })
    } else if (backup.changeType === 'remove-path') {
      mutations.push({ action: 'add-path', scope: backup.scope, entries: backup.removedEntries, strategy: 'append' })
    } else if (backup.changeType === 'dedupe-path') {
      mutations.push({ action: 'add-path', scope: backup.scope, entries: backup.removedEntries, strategy: 'append' })
    } else if (backup.changeType === 'set-variable') {
      if (backup.previousValue === null) {
        if (current === null) {
          this.db.markEnvironmentBackupRestored(backupId)
          return {
            success: true,
            preview: { changes: [], warnings: [], errors: [], requiresAdmin: false, canApply: true, appliedBackupIds: [], outcome: 'already-satisfied' },
            message: 'The variable is already absent.'
          }
        }
        if (current !== backup.newValue) {
          conflict = `"${backup.name}" has changed since DevForge updated it. It was not modified.`
        } else {
          mutations.push({ action: 'remove-variable', scope: backup.scope, name: backup.name })
        }
      } else {
        if (current === backup.previousValue) {
          this.db.markEnvironmentBackupRestored(backupId)
          return {
            success: true,
            preview: { changes: [], warnings: [], errors: [], requiresAdmin: false, canApply: true, appliedBackupIds: [], outcome: 'already-satisfied' },
            message: 'The previous value is already in place.'
          }
        }
        if (current !== backup.newValue) {
          conflict = `"${backup.name}" has changed since DevForge updated it. Restoring it would overwrite a newer change.`
        } else {
          mutations.push({ action: 'set-variable', scope: backup.scope, name: backup.name, value: backup.previousValue })
        }
      }
    } else if (backup.changeType === 'remove-variable') {
      if (current !== null && current !== backup.previousValue) {
        conflict = `"${backup.name}" already exists with a different value. It was not modified.`
      } else {
        mutations.push({ action: 'set-variable', scope: backup.scope, name: backup.name, value: backup.previousValue ?? '' })
      }
    }

    if (conflict) {
      return {
        success: false,
        preview: { changes: [], warnings: [], errors: [conflict], requiresAdmin: backup.scope === 'system', canApply: false, appliedBackupIds: [], outcome: 'nothing-to-do' },
        message: conflict
      }
    }

    const preview = await this.apply(mutations, { reason })
    this.db.markEnvironmentBackupRestored(backupId)
    return { success: true, preview, message: 'The environment change was reversed.' }
  }

  async revertPackageEnvironment(packageId: string): Promise<EnvPreview> {
    const backups = this.db.listEnvironmentBackupsForPackage(packageId).filter((backup) => !backup.restoredAt)
    const mutations: EnvironmentMutation[] = []
    const warnings: string[] = []
    const snapshot = await this.readSnapshot(true)
    const expand = this.getExpander(snapshot)
    const simulated = new Map<string, string | null>()
    const readValue = (scope: EnvScope, name: string): string | null => {
      const key = `${scope}:${name.toLowerCase()}`
      if (simulated.has(key)) return simulated.get(key) ?? null
      const source = scope === 'user' ? snapshot.user : snapshot.system
      return source.get(name.toLowerCase())?.value ?? null
    }

    for (const backup of backups) {
      if (backup.changeType === 'append-path') {
        const current = readValue(backup.scope, backup.name)
        const result = removePathEntries(current, backup.addedEntries, expand)
        if (result.removed.length === 0) continue
        simulated.set(`${backup.scope}:path`, result.value)
        mutations.push({ action: 'remove-path', scope: backup.scope, entries: result.removed })
        this.db.markEnvironmentBackupRestored(backup.id)
      } else if (backup.changeType === 'set-variable') {
        const current = readValue(backup.scope, backup.name)
        if (current !== backup.newValue) {
          warnings.push(`"${backup.name}" changed after DevForge updated it, so it was left alone.`)
          continue
        }
        if (backup.previousValue === null) {
          mutations.push({ action: 'remove-variable', scope: backup.scope, name: backup.name })
          simulated.set(`${backup.scope}:${backup.name.toLowerCase()}`, null)
        } else {
          mutations.push({ action: 'set-variable', scope: backup.scope, name: backup.name, value: backup.previousValue })
          simulated.set(`${backup.scope}:${backup.name.toLowerCase()}`, backup.previousValue)
        }
        this.db.markEnvironmentBackupRestored(backup.id)
      }
    }

    if (mutations.length === 0) {
      return {
        changes: [],
        warnings,
        errors: [],
        requiresAdmin: false,
        canApply: false,
        appliedBackupIds: [],
        outcome: 'already-satisfied'
      }
    }

    const result = await this.apply(mutations, { reason: `Remove environment changes for ${packageId}` })
    return { ...result, warnings: [...warnings, ...result.warnings] }
  }

  async doctor(): Promise<EnvironmentDoctorReport> {
    const actions: DoctorAction[] = []
    const warnings: string[] = []
    const snapshot = await this.readSnapshot(true)
    const expand = this.getExpander(snapshot)

    for (const scope of ['user', 'system'] as EnvScope[]) {
      const source = scope === 'user' ? snapshot.user : snapshot.system
      const raw = source.get('path')?.value ?? null
      const duplicates = findDuplicatePathEntries(raw, expand)
      if (duplicates.length > 0) {
        actions.push({
          id: `dedupe-path-${scope}`,
          label: `Remove ${duplicates.length} duplicate ${scope} PATH ${
            duplicates.length === 1 ? 'entry' : 'entries'
          }`,
          description: `Keeps the first occurrence of each path and removes repeated copies from the ${scope} PATH. All other entries remain untouched.`,
          scope,
          mutations: [{ action: 'dedupe-path', scope }]
        })
      }
    }

    const managedMissing = this.db
      .listActiveManagedPathEntries()
      .filter((entry) => !existsSync(stripQuotes(expand(entry.entry))))
    if (managedMissing.length > 0) {
      warnings.push(
        `${managedMissing.length} DevForge-managed PATH ${
          managedMissing.length === 1 ? 'entry points' : 'entries point'
        } to folders that no longer exist. Use Repair Configuration on the affected package.`
      )
    }

    for (const name of ['JAVA_HOME', 'MAVEN_HOME', 'GOROOT']) {
      const variable = snapshot.user.get(name.toLowerCase()) ?? snapshot.system.get(name.toLowerCase())
      if (!variable) continue
      const resolved = stripQuotes(expand(variable.value))
      const valid =
        name === 'JAVA_HOME' ? existsSync(`${resolved}\\bin\\java.exe`) : existsSync(resolved)
      if (!valid) {
        warnings.push(
          `${name} points to "${variable.value}", which no longer contains the expected files. Repair the related package or update the variable manually.`
        )
      }
    }

    return { actions, warnings }
  }

  async validate(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = []
    const winget = await this.getWingetVersion()
    checks.push({
      id: 'winget',
      label: 'Windows Package Manager (WinGet)',
      status: winget ? 'ok' : 'error',
      detail: winget ? `WinGet ${winget} is available.` : 'WinGet could not be executed.',
      packageId: null,
      fixHint: winget ? null : 'Install or repair App Installer from the Microsoft Store.'
    })

    try {
      const snapshot = await this.readSnapshot(true)
      const expand = this.getExpander(snapshot)
      const userPath = snapshot.user.get('path')
      const duplicates = userPath ? findDuplicatePathEntries(userPath.value, expand) : []
      checks.push({
        id: 'path-user',
        label: 'User PATH',
        status: duplicates.length > 0 ? 'warning' : 'ok',
        detail:
          duplicates.length > 0
            ? `${duplicates.length} duplicate PATH ${duplicates.length === 1 ? 'entry' : 'entries'} found.`
            : `${splitPathValue(userPath?.value).filter(Boolean).length} PATH entries configured.`,
        packageId: null,
        fixHint: duplicates.length > 0 ? 'Review PATH entries and remove duplicates.' : null
      })

      const activeManaged = this.db.listActiveManagedPathEntries()
      const missing = activeManaged.filter((entry) => {
        const source = entry.scope === 'user' ? snapshot.user : snapshot.system
        const raw = source.get('path')?.value ?? ''
        const present = splitPathValue(raw).some(
          (candidate) => normalizePathEntry(candidate, expand) === normalizePathEntry(entry.entry, expand)
        )
        return !present || !existsSync(stripQuotes(expand(entry.entry)))
      })
      checks.push({
        id: 'path-managed',
        label: 'DevForge PATH entries',
        status: missing.length > 0 ? 'error' : 'ok',
        detail:
          missing.length > 0
            ? `${missing.length} DevForge-managed PATH ${missing.length === 1 ? 'entry is' : 'entries are'} missing or point to deleted folders.`
            : 'All DevForge-managed PATH entries are present.',
        packageId: null,
        fixHint: missing.length > 0 ? 'Use Repair Configuration on the affected package.' : null
      })

      for (const name of ['JAVA_HOME', 'MAVEN_HOME', 'GOROOT']) {
        const variable = snapshot.user.get(name.toLowerCase()) ?? snapshot.system.get(name.toLowerCase())
        if (!variable) continue
        const resolved = expand(variable.value)
        const javaCheck = name === 'JAVA_HOME' ? existsSync(`${stripQuotes(resolved)}\\bin\\java.exe`) : undefined
        const valid = javaCheck === undefined ? existsSync(stripQuotes(resolved)) : javaCheck
        checks.push({
          id: `var-${name.toLowerCase()}`,
          label: name,
          status: valid ? 'ok' : 'error',
          detail: valid ? `${name} points to ${resolved}` : `${name} does not point to a valid directory.`,
          packageId: name === 'JAVA_HOME' ? 'java-jdk' : name === 'MAVEN_HOME' ? 'maven' : 'go',
          fixHint: valid ? null : 'Repair the package configuration or remove the stale variable.'
        })
      }

      for (const scope of ['user', 'system'] as EnvScope[]) {
        const source = scope === 'user' ? snapshot.user : snapshot.system
        const path = source.get('path')?.value ?? ''
        if (path.length > 30000) {
          checks.push({
            id: `path-length-${scope}`,
            label: `${scope === 'user' ? 'User' : 'System'} PATH length`,
            status: 'warning',
            detail: `PATH is ${path.length} characters long and may be truncated by some tools.`,
            packageId: null,
            fixHint: 'Remove unused PATH entries.'
          })
        }
      }
    } catch (error) {
      checks.push({
        id: 'path-read',
        label: 'Windows environment',
        status: 'error',
        detail: 'DevForge could not read the Windows environment.',
        packageId: null,
        fixHint: 'Restart DevForge and try again.'
      })
      this.logger.warn('Environment validation failed', { error: String(error) })
    }

    return checks
  }

  async getMergedProcessEnv(extraDirs: string[] = []): Promise<Record<string, string>> {
    const snapshot = await this.readSnapshot()
    const expand = this.getExpander(snapshot)
    const merged = new Map<string, { name: string; value: string }>()
    const setVar = (name: string, value: string): void => {
      const key = name.toLowerCase()
      if (!merged.has(key)) merged.set(key, { name, value })
      else merged.set(key, { name, value })
    }

    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value === 'string') setVar(name, value)
    }
    for (const variable of snapshot.system.values()) {
      setVar(variable.name, expand(variable.value))
    }
    for (const variable of snapshot.user.values()) {
      setVar(variable.name, expand(variable.value))
    }

    const systemPath = snapshot.system.get('path')?.value ?? ''
    const userPath = snapshot.user.get('path')?.value ?? ''
    const processPath = process.env.PATH ?? ''
    const ordered = [...extraDirs, ...splitPathValue(userPath), ...splitPathValue(systemPath), ...splitPathValue(processPath)]
      .map((entry) => stripQuotes(expand(entry)))
      .filter(Boolean)
    const seen = new Set<string>()
    const finalPath: string[] = []
    for (const entry of ordered) {
      const key = normalizePathEntry(entry, (value) => value)
      if (seen.has(key)) continue
      seen.add(key)
      finalPath.push(entry)
    }

    setVar('PATH', finalPath.join(';'))
    if (!merged.has('pathext')) setVar('PATHEXT', '.COM;.EXE;.BAT;.CMD')
    return Object.fromEntries([...merged.values()].map((entry) => [entry.name, entry.value]))
  }

  async getHealthSummary(): Promise<HealthCheck[]> {
    return this.validate()
  }

  async backups(limit = 100): Promise<EnvBackup[]> {
    return this.db.listEnvironmentBackups(limit)
  }
}
