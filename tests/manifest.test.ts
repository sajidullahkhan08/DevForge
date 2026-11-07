import { describe, expect, it } from 'vitest'
import { manifestToProfileInput, parseEnvironmentManifest } from '@shared/manifest'
import type { EnvironmentManifest, EnvironmentProfile } from '@shared/types'

function validManifest(overrides: Partial<EnvironmentManifest> = {}): EnvironmentManifest {
  return {
    schemaVersion: 2,
    kind: 'devforge-environment',
    name: 'Web team',
    description: 'Everything needed for the web stack.',
    audience: 'Web developers',
    icon: 'Globe',
    exportedAt: '2026-01-01T00:00:00.000Z',
    appVersion: '1.0.0',
    platform: 'win32-x64',
    components: [
      { packageId: 'nodejs', name: 'Node.js', version: '22.11.0', optional: false, installedVersion: '22.11.0' },
      { packageId: 'python', name: 'Python', version: null, optional: true, installedVersion: null }
    ],
    warnings: [],
    ...overrides
  }
}

function profile(id: string, name: string): EnvironmentProfile {
  return {
    id,
    name,
    description: '',
    audience: '',
    icon: 'Layers',
    isBuiltin: false,
    notes: [],
    components: [],
    createdAt: null,
    updatedAt: null
  }
}

describe('parseEnvironmentManifest', () => {
  it('accepts a complete manifest', () => {
    const result = parseEnvironmentManifest(validManifest())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.components).toHaveLength(2)
  })

  it('rejects a manifest for another tool and unknown fields', () => {
    const wrongKind = parseEnvironmentManifest(validManifest({ kind: 'something-else' as never }))
    expect(wrongKind.ok).toBe(false)
    if (!wrongKind.ok) expect(wrongKind.issues.join(' ')).toContain('kind')

    const extra = parseEnvironmentManifest({ ...validManifest(), extra: true })
    expect(extra.ok).toBe(false)
  })

  it('rejects an empty component list and malformed package ids', () => {
    expect(parseEnvironmentManifest(validManifest({ components: [] })).ok).toBe(false)

    const badId = parseEnvironmentManifest(
      validManifest({
        components: [
          { packageId: 'Not Valid', name: 'X', version: '1', optional: false, installedVersion: null }
        ]
      })
    )
    expect(badId.ok).toBe(false)
    if (!badId.ok) expect(badId.issues.join(' ')).toContain('components.0.packageId')
  })

  it('rejects a manifest that is not an object', () => {
    expect(parseEnvironmentManifest(null).ok).toBe(false)
    expect(parseEnvironmentManifest('manifest').ok).toBe(false)
  })
})

describe('manifestToProfileInput', () => {
  it('pins the exact versions and preserves component flags', () => {
    const { input, warnings } = manifestToProfileInput(validManifest(), [])
    expect(warnings).toEqual([])
    expect(input.components).toEqual([
      { packageId: 'nodejs', optional: false, preferredVersion: '22.11.0' },
      { packageId: 'python', optional: true, preferredVersion: null }
    ])
    expect(input.name).toBe('Web team')
    expect(input.icon).toBe('Globe')
  })

  it('renames a profile when the name is already taken', () => {
    const { input } = manifestToProfileInput(validManifest(), [profile('1', 'web team')])
    expect(input.name).toBe('Web team (2)')
  })

  it('never overwrites an existing profile and keeps names unique', () => {
    const { input } = manifestToProfileInput(validManifest(), [
      profile('1', 'Web team'),
      profile('2', 'Web team (2)')
    ])
    expect(input.name).toBe('Web team (3)')
  })

  it('drops duplicate components, keeps the first and warns', () => {
    const manifest = validManifest({
      components: [
        { packageId: 'nodejs', name: 'Node.js', version: '22.11.0', optional: false, installedVersion: null },
        { packageId: 'nodejs', name: 'Node.js', version: '20.0.0', optional: true, installedVersion: null }
      ]
    })
    const { input, warnings } = manifestToProfileInput(manifest, [])
    expect(input.components).toEqual([
      { packageId: 'nodejs', optional: false, preferredVersion: '22.11.0' }
    ])
    expect(warnings.join(' ')).toContain('more than once')
  })

  it('keeps warnings from the exporting machine', () => {
    const manifest = validManifest({ warnings: ['Node.js was installed manually.'] })
    expect(manifestToProfileInput(manifest, []).warnings).toContain('Node.js was installed manually.')
  })

  it('falls back to sensible defaults for optional text fields', () => {
    const manifest = validManifest({ name: '  ', description: '', audience: '', icon: '' })
    const { input } = manifestToProfileInput(manifest, [])
    expect(input.name).toBe('Imported environment')
    expect(input.description.length).toBeGreaterThan(0)
    expect(input.audience.length).toBeGreaterThan(0)
    expect(input.icon).toBe('Layers')
  })
})
