import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettings, EnvScope, EnvironmentMutation } from '@shared/types'
import type { PackageDefinition } from '@shared/registry'
import { AppDatabase } from '../electron/main/services/database/Database'
import { EnvironmentManager } from '../electron/main/services/environment/EnvironmentManager'
import { Logger } from '../electron/main/services/logging/Logger'
import type { ProcessExecutor } from '../electron/main/services/process/ProcessExecutor'
import { powershellScripts, type PowerShellService } from '../electron/main/services/system/PowerShellService'

interface Row {
  name: string
  value: string
  kind: string
}

class FakeWindows {
  readonly environment: Record<EnvScope, Map<string, Row>> = {
    user: new Map(),
    system: new Map()
  }
  elevated = true
  failWrites = new Set<string>()
  writes: { scope: EnvScope; name: string; value: string; delete: boolean }[] = []

  rows(scope: EnvScope): Row[] {
    return [...this.environment[scope].values()]
  }

  set(scope: EnvScope, name: string, value: string, kind = 'String'): void {
    this.environment[scope].set(name.toLowerCase(), { name, value, kind })
  }

  get(scope: EnvScope, name: string): string | null {
    return this.environment[scope].get(name.toLowerCase())?.value ?? null
  }

  get ps(): PowerShellService {
    return {
      run: async (script: string, payload?: unknown) => {
        if (script === powershellScripts.isElevated) {
          return { stdout: this.elevated ? 'true' : 'false', stderr: '', exitCode: 0 }
        }
        if (script === powershellScripts.broadcastEnvironmentChange) {
          return { stdout: 'broadcast', stderr: '', exitCode: 0 }
        }
        if (script === powershellScripts.writeEnvironment) {
          const input = payload as { scope: EnvScope; name: string; value: string; delete: boolean }
          if (this.failWrites.has(input.name)) {
            throw new Error('Windows rejected the environment write.')
          }
          this.writes.push(input)
          if (input.delete) {
            this.environment[input.scope].delete(input.name.toLowerCase())
          } else {
            this.set(input.scope, input.name, input.value, input.value.includes('%') ? 'ExpandString' : 'String')
          }
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      runJson: async (_script: string, payload?: unknown) => {
        const scope = (payload as { scope: EnvScope }).scope
        return this.rows(scope)
      }
    } as unknown as PowerShellService
  }

  get executor(): ProcessExecutor {
    return {
      run: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
      isCancellation: () => false
    } as unknown as ProcessExecutor
  }
}

const settings: AppSettings = {
  theme: 'dark',
  startupPage: '/dashboard',
  installDir: 'C:\\DevForge\\Tools',
  installScope: 'user',
  defaultMethod: 'auto',
  downloadDir: 'C:\\DevForge\\Downloads',
  concurrentDownloads: 2,
  autoVerify: true,
  confirmInstall: true,
  envScope: 'user',
  pathStrategy: 'append',
  backupBeforeChange: true,
  notifyOnComplete: true,
  notifyOnFailure: true,
  notifyOnUpdates: true,
  checkUpstreamUpdates: true,
  proxyUrl: '',
  proxyBypass: '',
  keepInTray: false,
  resumeQueueOnStartup: true,
  language: 'en'
}

function packageWithEnvironment(environment: PackageDefinition['environment']): PackageDefinition {
  return {
    schemaVersion: 1,
    id: 'test-package',
    name: 'Test Package',
    category: 'language',
    description: 'Test package',
    publisher: 'Tests',
    homepage: 'https://example.com',
    license: 'MIT',
    icon: 'terminal',
    installationMethod: 'archive',
    scope: 'user',
    supportedArchitectures: ['x64'],
    supportedWindowsVersions: ['10', '11'],
    requiresAdmin: false,
    requiresRestart: false,
    advanced: false,
    caveats: [],
    tags: [],
    expectedExecutables: [],
    supportsVersionSwitching: false,
    versions: [],
    dependencies: [],
    environment,
    verification: [],
    detection: { args: [], knownPaths: [] }
  }
}

let directory: string
let toolsDir: string
let db: AppDatabase
let fake: FakeWindows
let manager: EnvironmentManager

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'devforge-env-'))
  toolsDir = join(directory, 'tools')
  mkdirSync(toolsDir, { recursive: true })
  db = new AppDatabase(':memory:')
  fake = new FakeWindows()
  manager = new EnvironmentManager(
    db,
    fake.ps,
    fake.executor,
    new Logger(join(directory, 'logs')),
    () => settings,
    () => toolsDir
  )
})

afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const addPath = (entries: string[], scope: EnvScope = 'user'): EnvironmentMutation => ({
  action: 'add-path',
  scope,
  entries,
  strategy: 'append'
})

describe('environment preview idempotency', () => {
  it('reports already-satisfied when every PATH entry is present', async () => {
    const toolPath = join(toolsDir, 'python')
    mkdirSync(toolPath)
    fake.set('user', 'Path', `C:\\Windows;${toolPath}\\`)

    const preview = await manager.preview([addPath([toolPath])])
    expect(preview.changes).toEqual([])
    expect(preview.errors).toEqual([])
    expect(preview.canApply).toBe(false)
    expect(preview.outcome).toBe('already-satisfied')
    expect(preview.warnings.join(' ')).toContain('already present')
  })

  it('warns when the matching PATH entry points at a missing directory', async () => {
    const missing = join(toolsDir, 'not-created')
    fake.set('user', 'Path', `C:\\Windows;${missing}`)

    const preview = await manager.preview([addPath([missing])])
    expect(preview.changes).toEqual([])
    expect(preview.outcome).toBe('already-satisfied')
    expect(preview.warnings.join(' ')).toContain('does not exist yet')
  })

  it('reports already-satisfied when a variable already matches', async () => {
    fake.set('user', 'JAVA_HOME', 'C:\\Java')

    const preview = await manager.preview([
      { action: 'set-variable', scope: 'user', name: 'JAVA_HOME', value: 'C:\\Java' }
    ])
    expect(preview.changes).toEqual([])
    expect(preview.outcome).toBe('already-satisfied')
  })

  it('plans only the missing PATH entries and preserves existing ones', async () => {
    fake.set('user', 'Path', 'C:\\Windows')

    const preview = await manager.preview([addPath(['C:\\Windows', 'C:\\Tools'])])
    expect(preview.changes).toHaveLength(1)
    expect(preview.changes[0]).toMatchObject({
      operation: 'append-path',
      addedEntries: ['C:\\Tools']
    })
    expect(preview.changes[0].after).toBe('C:\\Windows;C:\\Tools')
    expect(preview.outcome).toBe('pending')
    expect(preview.canApply).toBe(true)
  })

  it('distinguishes updating a wrong variable from creating a new one', async () => {
    fake.set('user', 'JAVA_HOME', 'C:\\OldJava')

    const update = await manager.preview([
      { action: 'set-variable', scope: 'user', name: 'JAVA_HOME', value: 'C:\\NewJava' }
    ])
    expect(update.changes[0]).toMatchObject({ operation: 'update', before: 'C:\\OldJava', after: 'C:\\NewJava' })

    const create = await manager.preview([
      { action: 'set-variable', scope: 'user', name: 'CARGO_HOME', value: 'C:\\Cargo' }
    ])
    expect(create.changes[0]).toMatchObject({ operation: 'create', before: null })
  })

  it('rejects protected and malformed variables', async () => {
    const protectedPreview = await manager.preview([
      { action: 'set-variable', scope: 'user', name: 'SYSTEMROOT', value: 'C:\\evil' }
    ])
    expect(protectedPreview.errors.join(' ')).toContain('protected by Windows')

    const invalid = await manager.preview([
      { action: 'set-variable', scope: 'user', name: 'BAD NAME', value: 'x' }
    ])
    expect(invalid.errors.join(' ')).toContain('letters, digits, underscores and parentheses')
  })

  it('refuses system changes without elevation', async () => {
    fake.elevated = false
    const preview = await manager.preview([addPath(['C:\\Tools'], 'system')])
    expect(preview.requiresAdmin).toBe(true)
    expect(preview.canApply).toBe(false)
    expect(preview.errors.join(' ')).toContain('administrator permission')
  })
})

describe('environment apply', () => {
  it('returns already-satisfied without writing when nothing needs to change', async () => {
    const toolPath = join(toolsDir, 'node')
    mkdirSync(toolPath)
    fake.set('user', 'Path', toolPath)

    const result = await manager.apply([addPath([toolPath])])
    expect(result.outcome).toBe('already-satisfied')
    expect(result.canApply).toBe(true)
    expect(fake.writes).toEqual([])
    expect(db.listEnvironmentBackups()).toEqual([])
  })

  it('writes missing PATH entries, records a backup and verifies the result', async () => {
    const toolPath = join(toolsDir, 'rust')
    mkdirSync(toolPath)
    fake.set('user', 'Path', 'C:\\Windows')

    const result = await manager.apply([addPath([toolPath])], { packageId: 'rust', reason: 'Install Rust' })
    expect(result.outcome).toBe('applied')
    expect(result.appliedBackupIds).toHaveLength(1)
    expect(fake.get('user', 'Path')).toBe(`C:\\Windows;${toolPath}`)

    const backups = db.listEnvironmentBackups()
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatchObject({
      scope: 'user',
      name: 'Path',
      previousValue: 'C:\\Windows',
      changeType: 'append-path'
    })
    expect(db.getEnvironmentBackup(backups[0].id)?.packageId).toBe('rust')
  })

  it('is idempotent: applying the same change again makes no further writes', async () => {
    const toolPath = join(toolsDir, 'go')
    mkdirSync(toolPath)

    const first = await manager.apply([addPath([toolPath])])
    expect(first.outcome).toBe('applied')
    const writesAfterFirst = fake.writes.length

    manager.invalidate()
    const second = await manager.apply([addPath([toolPath])])
    expect(second.outcome).toBe('already-satisfied')
    expect(fake.writes).toHaveLength(writesAfterFirst)
    expect(db.listEnvironmentBackups()).toHaveLength(1)
  })

  it('reports partial application when Windows rejects a later write', async () => {
    fake.set('user', 'JAVA_HOME', 'C:\\OldJava')
    fake.failWrites.add('CARGO_HOME')

    let error: unknown
    try {
      await manager.apply([
        { action: 'set-variable', scope: 'user', name: 'JAVA_HOME', value: 'C:\\NewJava' },
        { action: 'set-variable', scope: 'user', name: 'CARGO_HOME', value: 'C:\\Cargo' }
      ])
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ code: 'ENVIRONMENT_PARTIALLY_APPLIED' })
    expect((error as Error).message).toContain('applying 1 other change')
    expect(fake.get('user', 'JAVA_HOME')).toBe('C:\\NewJava')
    expect(fake.get('user', 'CARGO_HOME')).toBeNull()
    expect(db.listEnvironmentBackups()).toHaveLength(1)
  })

  it('reports a clean failure when the first write is rejected', async () => {
    fake.failWrites.add('JAVA_HOME')

    await expect(
      manager.apply([{ action: 'set-variable', scope: 'user', name: 'JAVA_HOME', value: 'C:\\Java' }])
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_FAILED' })
    expect(db.listEnvironmentBackups()).toEqual([])
  })

  it('throws ADMIN_REQUIRED instead of writing system values without elevation', async () => {
    const systemEntry = join(toolsDir, 'system-tool')
    mkdirSync(systemEntry)
    fake.elevated = false

    await expect(manager.apply([addPath([systemEntry], 'system')])).rejects.toMatchObject({
      code: 'ENVIRONMENT_FAILED'
    })
    expect(fake.writes).toEqual([])
  })
})

describe('applyPackageEnvironment', () => {
  const pkg = packageWithEnvironment([
    { kind: 'path', name: 'Path', valueTemplate: '{toolsDir}\\python', scope: 'user' },
    { kind: 'variable', name: 'PYTHON_HOME', valueTemplate: '{toolsDir}\\python', scope: 'user' }
  ])

  it('returns already-satisfied when the package environment is complete', async () => {
    const pythonDir = join(toolsDir, 'python')
    mkdirSync(pythonDir)
    fake.set('user', 'Path', `C:\\Windows;${pythonDir}`)
    fake.set('user', 'PYTHON_HOME', pythonDir)

    const result = await manager.applyPackageEnvironment(pkg, pythonDir, { transactionId: 'tx-1' })
    expect(result.outcome).toBe('already-satisfied')
    expect(result.changes).toEqual([])
  })

  it('applies the missing pieces and records both mutations', async () => {
    const pythonDir = join(toolsDir, 'python')
    mkdirSync(pythonDir)
    fake.set('user', 'Path', 'C:\\Windows')

    const result = await manager.applyPackageEnvironment(pkg, pythonDir, { packageId: 'python', version: '3.13.0' })
    expect(result.outcome).toBe('applied')
    expect(result.appliedBackupIds).toHaveLength(2)
    expect(fake.get('user', 'Path')).toContain(pythonDir)
    expect(fake.get('user', 'PYTHON_HOME')).toBe(pythonDir)
  })

  it('is a no-op for packages without environment specifications', async () => {
    const empty = packageWithEnvironment([])
    const result = await manager.applyPackageEnvironment(empty, null, {})
    expect(result.outcome).toBe('nothing-to-do')
    expect(fake.writes).toEqual([])
  })
})

describe('environment doctor', () => {
  it('offers a targeted duplicate PATH cleanup that keeps the first occurrence', async () => {
    fake.set('user', 'Path', 'C:\\Windows;C:\\Tools;C:\\Windows')

    const report = await manager.doctor()
    const action = report.actions.find((candidate) => candidate.id === 'dedupe-path-user')
    expect(action).toBeDefined()
    expect(action?.mutations).toEqual([{ action: 'dedupe-path', scope: 'user' }])

    const preview = await manager.preview(action?.mutations ?? [])
    expect(preview.changes).toHaveLength(1)
    expect(preview.changes[0]).toMatchObject({
      operation: 'dedupe-path',
      removedEntries: ['C:\\Windows'],
      after: 'C:\\Windows;C:\\Tools'
    })

    const applied = await manager.apply(action?.mutations ?? [])
    expect(applied.outcome).toBe('applied')
    expect(fake.get('user', 'Path')).toBe('C:\\Windows;C:\\Tools')
  })

  it('reports no duplicate cleanup when every PATH entry is unique', async () => {
    fake.set('user', 'Path', 'C:\\Windows;C:\\Tools')

    const report = await manager.doctor()
    expect(report.actions.find((candidate) => candidate.id === 'dedupe-path-user')).toBeUndefined()

    const preview = await manager.preview([{ action: 'dedupe-path', scope: 'user' }])
    expect(preview.outcome).toBe('already-satisfied')
    expect(preview.changes).toEqual([])
  })

  it('warns about stale well-known variables', async () => {
    fake.set('user', 'JAVA_HOME', join(toolsDir, 'missing-java'))

    const report = await manager.doctor()
    expect(report.warnings.join(' ')).toContain('JAVA_HOME')
  })
})
