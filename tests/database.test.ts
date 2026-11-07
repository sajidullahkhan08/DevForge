import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import { AppDatabase } from '../electron/main/services/database/Database'

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

let db: AppDatabase

beforeEach(() => {
  db = new AppDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('AppDatabase migrations', () => {
  it('creates every table tracked by diagnostics', () => {
    const counts = db.counts()
    expect(Object.keys(counts).sort()).toEqual(
      [
        'activity_log',
        'environment_backups',
        'environment_profiles',
        'installation_logs',
        'installation_transactions',
        'installations',
        'package_versions',
        'packages'
      ].sort()
    )
    expect(Object.values(counts).every((count) => count === 0)).toBe(true)
  })

  it('reports the database file path', () => {
    expect(db.filePath).toBe(':memory:')
  })
})

describe('settings persistence', () => {
  it('round-trips settings as JSON and clears them', () => {
    db.saveSettings(settings)
    const stored = db.getSettings()
    expect(Object.keys(stored)).toHaveLength(Object.keys(settings).length)
    expect(JSON.parse(stored.concurrentDownloads)).toBe(2)
    expect(JSON.parse(stored.theme)).toBe('dark')

    db.clearSettings()
    expect(db.getSettings()).toEqual({})
  })

  it('updates existing values instead of duplicating keys', () => {
    db.saveSettings(settings)
    db.saveSettings({ ...settings, theme: 'light' })
    const stored = db.getSettings()
    expect(Object.keys(stored).filter((key) => key === 'theme')).toHaveLength(1)
    expect(JSON.parse(stored.theme)).toBe('light')
  })
})

describe('installations', () => {
  it('upserts by package, version and source', () => {
    const first = db.upsertInstallation({
      packageId: 'python',
      version: '3.12.4',
      method: 'winget',
      source: 'devforge',
      installDir: 'C:\\DevForge\\Tools\\Python',
      detectedVersion: '3.12.4',
      verificationStatus: 'verified'
    })
    const second = db.upsertInstallation({
      packageId: 'python',
      version: '3.12.4',
      method: 'winget',
      source: 'devforge',
      installDir: 'C:\\DevForge\\Tools\\Python',
      detectedVersion: '3.12.5',
      verificationStatus: 'failed'
    })
    expect(second).toBe(first)
    const records = db.listInstallations()
    expect(records).toHaveLength(1)
    expect(records[0].detectedVersion).toBe('3.12.5')
    expect(records[0].verificationStatus).toBe('failed')
  })

  it('tracks a single active version per package', () => {
    db.upsertInstallation({
      packageId: 'nodejs',
      version: '22.12.0',
      method: 'archive',
      source: 'devforge',
      installDir: 'C:\\DevForge\\Tools\\nodejs\\22.12.0'
    })
    db.upsertInstallation({
      packageId: 'nodejs',
      version: '20.18.0',
      method: 'archive',
      source: 'devforge',
      installDir: 'C:\\DevForge\\Tools\\nodejs\\20.18.0'
    })
    expect(db.listInstallationsForPackage('nodejs').filter((record) => record.isActive)).toHaveLength(2)

    db.setActiveInstallation('nodejs', '20.18.0')
    const records = db.listInstallationsForPackage('nodejs')
    expect(records.find((record) => record.isActive)?.version).toBe('20.18.0')
    expect(records.filter((record) => record.isActive)).toHaveLength(1)
  })

  it('marks packages removed without deleting history', () => {
    const id = db.upsertInstallation({
      packageId: 'git',
      version: '2.47.1',
      method: 'winget',
      source: 'devforge',
      installDir: 'C:\\Program Files\\Git'
    })
    db.markPackageRemoved('git')
    const record = db.getInstallation(id)
    expect(record?.status).toBe('removed')
    expect(record?.isActive).toBe(false)
    expect(db.listInstallations()).toHaveLength(1)
  })

  it('records a failed status and later metadata updates', () => {
    const id = db.upsertInstallation({
      packageId: 'go',
      version: '1.23.4',
      method: 'archive',
      source: 'devforge',
      installDir: null,
      status: 'failed'
    })
    db.updateInstallationAfterInstall(id, {
      installDir: 'C:\\DevForge\\Tools\\Go\\1.23.4',
      detectedVersion: '1.23.4',
      envStatus: 'configured',
      verificationStatus: 'verified',
      status: 'installed'
    })
    const record = db.getInstallation(id)
    expect(record).toMatchObject({
      status: 'installed',
      envStatus: 'configured',
      verificationStatus: 'verified',
      detectedVersion: '1.23.4',
      installDir: 'C:\\DevForge\\Tools\\Go\\1.23.4'
    })
  })

  it('stores and clears update availability', () => {
    db.upsertInstallation({
      packageId: 'rust',
      version: '1.82.0',
      method: 'archive',
      source: 'devforge',
      installDir: null
    })
    db.setAvailableVersion('rust', '1.83.0')
    expect(db.listInstallations()[0].availableVersion).toBe('1.83.0')
    db.setAvailableVersion('rust', null)
    expect(db.listInstallations()[0].availableVersion).toBeNull()
  })
})

describe('transactions and logs', () => {
  it('records a transaction with logs, failure details and environment changes', () => {
    db.createTransaction({
      id: 'tx-1',
      packageId: 'python',
      version: '3.12.4',
      method: 'winget',
      installationId: null,
      status: 'running'
    })
    db.addLog({
      transactionId: 'tx-1',
      level: 'info',
      stage: 'download',
      message: 'Downloading installer',
      command: 'winget',
      args: ['install', '--id', 'Python.Python.3.12'],
      exitCode: 0,
      stdout: 'ok',
      stderr: ''
    })
    db.finishTransaction('tx-1', 'failed', {
      errorCode: 'INSTALL_FAILED',
      errorMessage: 'Installer exited with code 1'
    })

    const records = db.listTransactions()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: 'tx-1',
      packageId: 'python',
      packageName: 'python',
      status: 'failed',
      errorCode: 'INSTALL_FAILED',
      logCount: 1
    })
    expect(records[0].finishedAt).not.toBeNull()

    const detail = db.getTransaction('tx-1')
    expect(detail?.logs).toHaveLength(1)
    expect(detail?.logs[0].args).toEqual(['install', '--id', 'Python.Python.3.12'])
    expect(detail?.logs[0].exitCode).toBe(0)
    expect(detail?.verification).toBeNull()
  })

  it('marks previously running transactions as interrupted on startup', () => {
    db.createTransaction({
      id: 'tx-running',
      packageId: 'nodejs',
      version: '22.12.0',
      method: 'archive',
      installationId: null,
      status: 'running'
    })
    db.createTransaction({
      id: 'tx-queued',
      packageId: 'go',
      version: '1.23.4',
      method: 'archive',
      installationId: null,
      status: 'queued'
    })
    expect(db.markInterruptedTransactions()).toBe(2)
    const records = db.listTransactions()
    expect(records.every((record) => record.status === 'interrupted')).toBe(true)
    expect(records.every((record) => record.errorMessage?.includes('DevForge closed'))).toBe(true)
  })

  it('links a verification run to its transaction', () => {
    db.createTransaction({
      id: 'tx-verify',
      packageId: 'git',
      version: '2.47.1',
      method: 'winget',
      installationId: null,
      status: 'running'
    })
    const runId = db.createVerificationRun('git', '2.47.1', 'tx-verify')
    db.addVerificationCheck(runId, {
      id: 'version',
      label: 'git --version',
      command: 'git --version',
      passed: true,
      output: 'git version 2.47.1',
      expected: '2.47.1',
      error: null,
      optional: false
    })
    db.finishVerificationRun(runId, 'passed')
    db.finishTransaction('tx-verify', 'completed', { verificationRunId: runId })

    const run = db.getLatestVerificationRun('git')
    expect(run?.status).toBe('passed')
    expect(run?.checks).toHaveLength(1)
    expect(run?.checks[0].passed).toBe(true)
    expect(db.getTransaction('tx-verify')?.verification?.id).toBe(runId)
  })
})

describe('activity log', () => {
  it('returns entries newest first', () => {
    db.addActivity({ type: 'install', level: 'info', title: 'First', message: null, packageId: 'python' })
    db.addActivity({ type: 'error', level: 'error', title: 'Second', message: 'boom', packageId: 'git' })
    const entries = db.listActivity()
    expect(entries).toHaveLength(2)
    expect(entries[0].title).toBe('Second')
    expect(entries[0].level).toBe('error')
  })
})

describe('profiles', () => {
  it('creates, updates and deletes a custom profile', () => {
    const created = db.createProfile({
      name: 'My stack',
      description: 'Custom tools',
      audience: 'Testing',
      icon: 'python',
      components: [{ packageId: 'python' }, { packageId: 'git', optional: true }]
    })
    expect(created.isBuiltin).toBe(false)
    expect(created.components).toHaveLength(2)
    expect(created.components.find((component) => component.packageId === 'git')?.optional).toBe(true)

    const updated = db.updateProfile(created.id, {
      name: 'My stack v2',
      description: 'Updated',
      audience: 'Testing',
      icon: 'python',
      components: [{ packageId: 'python' }]
    })
    expect(updated.name).toBe('My stack v2')
    expect(updated.components).toHaveLength(1)

    db.deleteProfile(created.id)
    expect(db.listProfiles().some((profile) => profile.id === created.id)).toBe(false)
  })
})

describe('download cache', () => {
  it('stores and clears cached downloads', () => {
    db.saveDownload({
      packageId: 'python',
      version: '3.12.4',
      url: 'https://www.python.org/ftp/python/3.12.4/python-3.12.4-amd64.exe',
      filePath: 'C:\\DevForge\\Downloads\\python.exe',
      sizeBytes: 1024,
      checksum: 'a'.repeat(64),
      status: 'complete'
    })
    expect(db.listDownloads()).toHaveLength(1)
    db.clearDownloads()
    expect(db.listDownloads()).toHaveLength(0)
  })
})
