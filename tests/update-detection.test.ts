import { describe, expect, it, vi } from 'vitest'
import type { PackageDefinition } from '@shared/registry'
import type { InstalledSummary } from '@shared/types'
import { CatalogueService } from '../electron/main/services/catalogue/CatalogueService'
import { SoftwareDetector } from '../electron/main/services/detection/SoftwareDetector'
import { InstallationEngine } from '../electron/main/services/install/InstallationEngine'
import type { AppDatabase } from '../electron/main/services/database/Database'
import type { EnvironmentManager } from '../electron/main/services/environment/EnvironmentManager'
import type { Logger } from '../electron/main/services/logging/Logger'
import type { ProcessExecutor } from '../electron/main/services/process/ProcessExecutor'
import type { PowerShellService } from '../electron/main/services/system/PowerShellService'

function record(overrides: Partial<InstalledSummary> = {}): InstalledSummary {
  return {
    id: 1,
    packageId: 'mingw-w64',
    version: '16.2.0',
    method: 'archive',
    source: 'devforge',
    installDir: 'C:\\DevForge\\Tools\\MinGW\\16.2.0',
    status: 'installed',
    detectedVersion: '6.3.0',
    availableVersion: '16.2.0',
    verificationStatus: 'verified',
    envStatus: 'configured',
    isActive: true,
    installedAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides
  } as InstalledSummary
}

const mingw = {
  id: 'mingw-w64',
  name: 'MinGW-w64 (GCC)',
  category: 'compiler',
  description: 'GCC toolchain',
  homepage: 'https://example.test',
  installationMethod: 'archive',
  versions: [{ version: '16.2.0', channel: 'stable', isDefault: true }],
  detection: {
    command: 'gcc',
    args: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    knownPaths: []
  },
  verification: []
} as unknown as PackageDefinition

describe('SoftwareDetector version refresh', () => {
  it('uses fresh command evidence instead of a stale recorded detection', async () => {
    const db = {
      listInstallationsForPackage: () => [record()]
    } as unknown as AppDatabase
    const executor = {
      run: async (command: string) => {
        if (command === 'gcc') {
          return {
            command,
            args: ['--version'],
            exitCode: 0,
            stdout: 'gcc (MinGW-W64 x86_64-ucrt-posix-seh) 16.2.0\r\nCopyright (C) 2026',
            stderr: '',
            durationMs: 1,
            timedOut: false,
            aborted: false
          }
        }
        throw new Error(`Unexpected command ${command}`)
      }
    } as unknown as ProcessExecutor
    const env = {
      getMergedProcessEnv: async () => ({ PATH: 'C:\\DevForge\\Tools\\MinGW\\16.2.0\\bin' })
    } as unknown as EnvironmentManager
    const ps = {
      runJson: async () => []
    } as unknown as PowerShellService
    const logger = {
      debug: () => undefined,
      warn: () => undefined,
      info: () => undefined
    } as unknown as Logger

    const detector = new SoftwareDetector(db, executor, env, ps, logger, () => 'C:\\DevForge\\Tools')
    const detection = await detector.detectPackage(mingw)

    expect(detection.installed).toBe(true)
    expect(detection.version).toBe('16.2.0')
    expect(detection.installDir).toBe('C:\\DevForge\\Tools\\MinGW\\16.2.0')
  })
})

describe('CatalogueService update availability', () => {
  function catalogue(installations: InstalledSummary[], latest: string) {
    const db = { listInstallations: () => installations } as unknown as AppDatabase
    const registry = {
      listPackages: () => [
        {
          ...mingw,
          versions: [{ version: latest, channel: 'stable', isDefault: true }]
        }
      ]
    } as unknown as ConstructorParameters<typeof CatalogueService>[0]
    const identities = {
      forPackage: () => null
    } as unknown as ConstructorParameters<typeof CatalogueService>[2]
    return new CatalogueService(registry, db, identities)
  }

  it('does not offer an update when a stale detection is older than the installed version', () => {
    const [item] = catalogue([record()], '16.2.0').list()
    expect(item.installed?.version).toBe('16.2.0')
    expect(item.installed?.detectedVersion).toBe('6.3.0')
    expect(item.updateAvailable).toBe(false)
    expect(item.availableVersion).toBeNull()
  })

  it('still offers updates when the registry is genuinely newer', () => {
    const [item] = catalogue([record()], '17.0.0').list()
    expect(item.updateAvailable).toBe(true)
    expect(item.availableVersion).toBe('17.0.0')
  })
})

describe('InstallationEngine.checkUpdates', () => {
  it('ignores a stale detection result when comparing versions', async () => {
    const setAvailableVersion = vi.fn()
    const db = {
      listInstallations: () => [record()],
      saveUpdateCache: vi.fn(),
      setAvailableVersion
    } as unknown as AppDatabase
    const registry = {
      getPackage: () => ({ ...mingw, versions: [{ version: '16.2.0', channel: 'stable' }] })
    } as unknown as ConstructorParameters<typeof InstallationEngine>[0]
    const settings = {
      get: () => ({ checkUpstreamUpdates: false })
    } as unknown as ConstructorParameters<typeof InstallationEngine>[2]

    const engine = new InstallationEngine(
      registry,
      db,
      settings,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    )

    await expect(engine.checkUpdates()).resolves.toEqual([])
    expect(setAvailableVersion).toHaveBeenCalledWith('mingw-w64', null)
  })
})
