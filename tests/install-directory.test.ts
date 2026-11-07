import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PackageDefinition } from '@shared/registry'
import {
  decideExistingDirectory,
  inspectDirectoryContents,
  packageMarkerFile,
  readPackageMarker
} from '../electron/main/services/install/InstallationEngine'

function pkg(id: string, executables: string[] = ['bin\\tool.exe']): PackageDefinition {
  return {
    schemaVersion: 1,
    id,
    name: id,
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
    expectedExecutables: executables,
    supportsVersionSwitching: false,
    versions: [],
    dependencies: [],
    environment: [],
    verification: [],
    detection: { args: [], knownPaths: [] }
  }
}

function writeMarker(directory: string, packageId: string, version: string): void {
  writeFileSync(
    join(directory, packageMarkerFile),
    JSON.stringify({
      managedBy: 'devforge',
      packageId,
      version,
      method: 'archive',
      installedAt: new Date().toISOString()
    }),
    'utf8'
  )
}

function createExecutable(directory: string, relative = 'bin\\tool.exe'): void {
  const target = join(directory, relative)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, 'binary', 'utf8')
}

function inspect(target: string, definition = pkg('tool'), managedByDatabase = false) {
  return { ...inspectDirectoryContents(definition, target), managedByDatabase }
}

let directory: string
let installDir: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'devforge-install-'))
  installDir = join(directory, 'MinGW', '16.2.0')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('package markers', () => {
  it('returns null when the marker is missing or malformed', () => {
    expect(readPackageMarker(installDir)).toBeNull()
    mkdirSync(installDir, { recursive: true })
    expect(readPackageMarker(installDir)).toBeNull()

    writeFileSync(join(installDir, packageMarkerFile), '{"managedBy":"someone-else"}', 'utf8')
    expect(readPackageMarker(installDir)).toBeNull()

    writeFileSync(join(installDir, packageMarkerFile), 'not json', 'utf8')
    expect(readPackageMarker(installDir)).toBeNull()
  })

  it('reads a marker written by DevForge', () => {
    mkdirSync(installDir, { recursive: true })
    writeMarker(installDir, 'mingw', '16.2.0')
    expect(readPackageMarker(installDir)).toMatchObject({
      managedBy: 'devforge',
      packageId: 'mingw',
      version: '16.2.0'
    })
  })
})

describe('inspectDirectoryContents', () => {
  it('reports a missing folder with all expected executables missing', () => {
    const inspection = inspect(installDir)
    expect(inspection.exists).toBe(false)
    expect(inspection.empty).toBe(false)
    expect(inspection.marker).toBeNull()
    expect(inspection.missingExecutables).toEqual(['bin\\tool.exe'])
  })

  it('reports an empty folder', () => {
    mkdirSync(installDir, { recursive: true })
    const inspection = inspect(installDir)
    expect(inspection).toMatchObject({ exists: true, empty: true })
    expect(inspection.missingExecutables).toEqual(['bin\\tool.exe'])
  })

  it('detects a complete installation', () => {
    mkdirSync(installDir, { recursive: true })
    createExecutable(installDir)
    const inspection = inspect(installDir)
    expect(inspection.empty).toBe(false)
    expect(inspection.missingExecutables).toEqual([])
  })

  it('lists only the executables that are actually missing', () => {
    mkdirSync(installDir, { recursive: true })
    createExecutable(installDir)
    const inspection = inspect(installDir, pkg('tool', ['bin\\tool.exe', 'bin\\helper.exe']))
    expect(inspection.missingExecutables).toEqual(['bin\\helper.exe'])
  })
})

describe('decideExistingDirectory', () => {
  it('reuses a complete installation with a matching marker', () => {
    mkdirSync(installDir, { recursive: true })
    createExecutable(installDir)
    writeMarker(installDir, 'mingw', '16.2.0')

    const decision = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir), false)
    expect(decision).toEqual({ reuse: true, replace: false, notes: [], conflict: null })
  })

  it('adopts a complete installation that has no marker', () => {
    mkdirSync(installDir, { recursive: true })
    createExecutable(installDir)

    const decision = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir), false)
    expect(decision.reuse).toBe(true)
    expect(decision.conflict).toBeNull()
  })

  it('never overwrites a folder owned by another DevForge package', () => {
    mkdirSync(installDir, { recursive: true })
    createExecutable(installDir)
    writeMarker(installDir, 'clang', '18.0.0')

    const decision = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir), true)
    expect(decision.reuse).toBe(false)
    expect(decision.replace).toBe(false)
    expect(decision.conflict?.message).toContain('another DevForge package (clang)')
    expect(decision.conflict?.message).toContain(installDir)
  })

  it('never overwrites unrelated files in a folder DevForge does not own', () => {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'user-notes.txt'), 'keep me', 'utf8')

    const decision = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir), true)
    expect(decision.reuse).toBe(false)
    expect(decision.replace).toBe(false)
    expect(decision.conflict?.message).toContain('did not create')
    expect(decision.conflict?.details).toContain('bin\\tool.exe')
  })

  it('requires confirmation before replacing an incomplete DevForge install', () => {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'partial.bin'), 'partial', 'utf8')
    writeMarker(installDir, 'mingw', '16.2.0')

    const withoutRecovery = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir), false)
    expect(withoutRecovery.conflict?.message).toContain('incomplete DevForge installation')

    const withRecovery = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir), true)
    expect(withRecovery.conflict).toBeNull()
    expect(withRecovery.replace).toBe(true)
    expect(withRecovery.notes.join(' ')).toContain('moved aside, not deleted')
  })

  it('treats a database-tracked folder as recoverable even without a marker', () => {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'partial.bin'), 'partial', 'utf8')

    const undecided = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir, pkg('mingw'), false), false)
    expect(undecided.conflict?.message).toContain('did not create')

    const managed = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir, pkg('mingw'), true), false)
    expect(managed.conflict?.message).toContain('incomplete DevForge installation')
  })

  it('replaces a different version only when it is a complete DevForge-owned install', () => {
    mkdirSync(installDir, { recursive: true })
    createExecutable(installDir)
    writeMarker(installDir, 'mingw', '15.0.0')

    const decision = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir), false)
    expect(decision.conflict).toBeNull()
    expect(decision.replace).toBe(true)
    expect(decision.notes.join(' ')).toContain('Replaced the existing DevForge installation 15.0.0')
  })

  it('requests a fresh install for an empty folder without deleting it', () => {
    mkdirSync(installDir, { recursive: true })
    const decision = decideExistingDirectory(pkg('mingw'), '16.2.0', installDir, inspect(installDir), false)
    expect(decision).toEqual({ reuse: false, replace: false, notes: [], conflict: null })
  })
})
