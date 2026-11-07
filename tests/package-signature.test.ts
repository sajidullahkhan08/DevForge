import { describe, expect, it } from 'vitest'
import { validatePackageDefinition, validatePackageSemantics } from '@shared/registry'

function officialInstaller(signature?: { publisher: string; thumbprint?: string }) {
  return {
    schemaVersion: 1,
    id: 'signed-tool',
    name: 'Signed Tool',
    category: 'developer-tool',
    description: 'A test package with a signed installer.',
    publisher: 'Example',
    homepage: 'https://example.com',
    license: 'MIT',
    icon: 'terminal',
    installationMethod: 'official-installer',
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
    versions: [
      {
        version: '1.2.3',
        channel: 'stable',
        isDefault: true,
        installArgs: ['/S'],
        download: {
          url: 'https://example.com/tool-1.2.3.exe',
          checksum: 'a'.repeat(64),
          checksumAlgorithm: 'sha256',
          ...(signature ? { signature } : {})
        }
      }
    ],
    dependencies: [],
    environment: [],
    verification: [],
    detection: { args: [], knownPaths: [] }
  }
}

describe('package Authenticode metadata', () => {
  it('accepts a publisher and thumbprint pin', () => {
    const thumbprint = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'
    const result = validatePackageDefinition(
      officialInstaller({ publisher: 'Example Corporation', thumbprint })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.versions[0].download?.signature).toEqual({
        publisher: 'Example Corporation',
        thumbprint
      })
      expect(validatePackageSemantics(result.value)).toEqual([])
    }
  })

  it('accepts a publisher without a thumbprint', () => {
    const result = validatePackageDefinition(officialInstaller({ publisher: 'Example Corporation' }))
    expect(result.ok).toBe(true)
  })

  it('rejects malformed thumbprints and unknown signature fields', () => {
    const short = validatePackageDefinition(
      officialInstaller({ publisher: 'Example Corporation', thumbprint: 'not-a-thumbprint' })
    )
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.issues[0].message).toContain('Thumbprint')

    const extra = validatePackageDefinition({
      ...officialInstaller({ publisher: 'Example Corporation' }),
      versions: [
        {
          ...officialInstaller().versions[0],
          download: {
            ...officialInstaller().versions[0].download,
            signature: { publisher: 'Example Corporation', subject: 'ignored' }
          }
        }
      ]
    })
    expect(extra.ok).toBe(false)
  })

  it('requires a non-empty publisher when a signature is declared', () => {
    const result = validatePackageDefinition(officialInstaller({ publisher: '' }))
    expect(result.ok).toBe(false)
  })
})
