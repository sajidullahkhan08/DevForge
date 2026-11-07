import { describe, expect, it } from 'vitest'
import {
  buildActivationScript,
  buildDeactivationScript,
  parseProjectConfig,
  type ProjectActivationEntry
} from '@shared/project'

function entry(overrides: Partial<ProjectActivationEntry> = {}): ProjectActivationEntry {
  return {
    packageId: 'nodejs',
    name: 'Node.js',
    version: '22.11.0',
    installDir: 'C:\\DevForge\\Tools\\nodejs\\22.11.0',
    environment: [],
    ...overrides
  }
}

describe('parseProjectConfig', () => {
  it('accepts pinned package versions', () => {
    const result = parseProjectConfig({
      schemaVersion: 1,
      name: 'Storefront',
      packages: { nodejs: '22.11.0', python: '3.13.0' }
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.packages.nodejs).toBe('22.11.0')
  })

  it('requires at least one package', () => {
    const result = parseProjectConfig({ schemaVersion: 1, packages: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.join(' ')).toContain('at least one package')
  })

  it('rejects malformed package ids and versions', () => {
    const badId = parseProjectConfig({ schemaVersion: 1, packages: { 'Node JS': '22.0.0' } })
    expect(badId.ok).toBe(false)

    const badVersion = parseProjectConfig({ schemaVersion: 1, packages: { nodejs: '' } })
    expect(badVersion.ok).toBe(false)
  })

  it('rejects unknown fields, other schema versions and non-objects', () => {
    expect(
      parseProjectConfig({ schemaVersion: 2, packages: { nodejs: '22.0.0' } }).ok
    ).toBe(false)
    expect(
      parseProjectConfig({ schemaVersion: 1, packages: { nodejs: '22.0.0' }, extra: true }).ok
    ).toBe(false)
    expect(parseProjectConfig(null).ok).toBe(false)
  })
})

describe('buildActivationScript', () => {
  it('adds unique directories to PATH and escapes single quotes', () => {
    const script = buildActivationScript(
      [entry({ installDir: "C:\\O'Brien\\node" })],
      'Storefront'
    )
    expect(script).toContain("'C:\\O''Brien\\node'")
    expect(script).toContain('if (-not $env:DEVFORGE_ORIGINAL_PATH)')
    expect(script).toContain('$env:PATH = "$devforgeDir;$env:PATH"')
    expect(script).toContain('Storefront')
  })

  it('does not add the same PATH directory twice', () => {
    const shared = 'C:\\Shared\\bin'
    const script = buildActivationScript(
      [
        entry({ packageId: 'a', installDir: shared }),
        entry({ packageId: 'b', installDir: shared })
      ],
      'Deduped'
    )
    expect(script.split(shared).length - 1).toBe(1)
  })

  it('prefers explicit path entries and skips the install directory', () => {
    const script = buildActivationScript(
      [
        entry({
          installDir: 'C:\\Install\\node',
          environment: [{ kind: 'path', name: 'Path', value: 'C:\\Explicit\\bin' }]
        })
      ],
      'Explicit'
    )
    expect(script).toContain('C:\\Explicit\\bin')
    expect(script).not.toContain('C:\\Install\\node')
  })

  it('sets variables once, case-insensitively', () => {
    const script = buildActivationScript(
      [
        entry({
          packageId: 'a',
          environment: [{ kind: 'variable', name: 'JAVA_HOME', value: 'C:\\Java\\21' }]
        }),
        entry({
          packageId: 'b',
          environment: [{ kind: 'variable', name: 'java_home', value: 'C:\\Java\\17' }]
        })
      ],
      'Java'
    )
    expect(script).toContain('$env:JAVA_HOME = \'C:\\Java\\21\'')
    expect(script).not.toContain('C:\\Java\\17')
    expect(script.split('$env:JAVA_HOME').length - 1).toBe(1)
  })

  it('uses CRLF line endings and flags missing directories at runtime', () => {
    const script = buildActivationScript([entry()], 'Line endings')
    expect(script).toContain('\r\n')
    expect(script).toContain('Write-Warning "DevForge project path is missing: $devforgeDir"')
  })

  it('strips newlines from the project name', () => {
    const script = buildActivationScript([], 'Bad\r\nName')
    expect(script).toContain('# Project: Bad  Name')
  })
})

describe('buildDeactivationScript', () => {
  it('restores the original PATH captured on activation', () => {
    const script = buildDeactivationScript()
    expect(script).toContain('if ($env:DEVFORGE_ORIGINAL_PATH)')
    expect(script).toContain('$env:PATH = $env:DEVFORGE_ORIGINAL_PATH')
    expect(script).toContain('Remove-Item Env:DEVFORGE_ORIGINAL_PATH')
    expect(script).toContain('\r\n')
  })
})
