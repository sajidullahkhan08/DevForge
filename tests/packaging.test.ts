import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const packagesDir = join(root, 'packages')
const archiveExtensions = /\.(exe|msi|msix|zip|7z|tar|gz|tgz|bz2|xz|rar|dmg|pkg|iso|bin)$/i

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('bundle size policy', () => {
  it('ships metadata only, never installers or SDK archives', () => {
    const files = filesUnder(packagesDir)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(file).toMatch(/\.json$/i)
      expect(file).not.toMatch(archiveExtensions)
      expect(statSync(file).size).toBeLessThan(256 * 1024)
    }
  })

  it('limits packaged resources to registry, profiles and identity JSON', () => {
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const extraResources = builder.slice(builder.indexOf('extraResources:'), builder.indexOf('asar:'))
    expect(extraResources).toContain('packages/registry')
    expect(extraResources).toContain('packages/profiles')
    expect(extraResources).toContain('packages/identities.json')
    expect(extraResources.match(/filter:/g)).toHaveLength(2)
    expect(extraResources.match(/- '\*\*\/\*\.json'/g)).toHaveLength(2)
  })

  it('does not add remote metadata services to the runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['yauzl', 'zod'])
  })
})
