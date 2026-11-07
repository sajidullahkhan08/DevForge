import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  validatePackageDefinition,
  validatePackageSemantics,
  validateProfileDefinition,
  type PackageDefinition,
  type ProfileDefinition
} from '@shared/registry'

const root = resolve(__dirname, '..')
const registryDir = join(root, 'packages', 'registry')
const profilesDir = join(root, 'packages', 'profiles')

function jsonFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

const packageFiles = jsonFiles(registryDir)
const packages = new Map<string, PackageDefinition>()
const packageIssues: string[] = []

for (const file of packageFiles) {
  const parsed = validatePackageDefinition(JSON.parse(readFileSync(file, 'utf8')), file)
  if (!parsed.ok) {
    packageIssues.push(...parsed.issues.map((issue) => `${issue.file} ${issue.path}: ${issue.message}`))
    continue
  }
  packages.set(parsed.value.id, parsed.value)
  packageIssues.push(
    ...validatePackageSemantics(parsed.value).map(
      (issue) => `${issue.file} ${issue.path}: ${issue.message}`
    )
  )
}

const profileFiles = jsonFiles(profilesDir)
const profiles = new Map<string, ProfileDefinition>()
const profileIssues: string[] = []

for (const file of profileFiles) {
  const parsed = validateProfileDefinition(JSON.parse(readFileSync(file, 'utf8')), file)
  if (!parsed.ok) {
    profileIssues.push(...parsed.issues.map((issue) => `${issue.file} ${issue.path}: ${issue.message}`))
    continue
  }
  profiles.set(parsed.value.id, parsed.value)
}

describe('package registry', () => {
  it('contains the curated catalogue', () => {
    expect(packageFiles.length).toBeGreaterThanOrEqual(20)
    expect(packages.size).toBe(packageFiles.length)
  })

  it('passes schema and semantic validation for every package', () => {
    expect(packageIssues).toEqual([])
  })

  it('covers the core development languages and runtimes', () => {
    for (const id of ['python', 'nodejs', 'java-jdk', 'go', 'rust', 'dotnet-sdk']) {
      expect(packages.has(id), `missing package ${id}`).toBe(true)
    }
  })

  it('covers databases and essential developer tools', () => {
    for (const id of ['postgresql', 'mysql', 'mongodb', 'git', 'github-cli', 'docker-desktop']) {
      expect(packages.has(id), `missing package ${id}`).toBe(true)
    }
  })

  it('declares exactly one default version and unique versions', () => {
    for (const [id, pkg] of packages) {
      if (pkg.installationMethod === 'project-recipe') continue
      expect(pkg.versions.length, `${id} has no versions`).toBeGreaterThan(0)
      expect(pkg.versions.filter((version) => version.isDefault), `${id} default version`).toHaveLength(1)
      expect(new Set(pkg.versions.map((version) => version.version)).size).toBe(pkg.versions.length)
    }
  })

  it('resolves every dependency inside the registry', () => {
    for (const [id, pkg] of packages) {
      for (const dependency of pkg.dependencies) {
        expect(packages.has(dependency.packageId), `${id} depends on missing ${dependency.packageId}`).toBe(true)
        expect(dependency.packageId).not.toBe(id)
      }
    }
  })

  it('only references HTTPS sources with checksums for archive packages', () => {
    for (const [id, pkg] of packages) {
      if (pkg.installationMethod !== 'archive') continue
      for (const version of pkg.versions) {
        expect(version.download, `${id} ${version.version} has no download metadata`).toBeDefined()
        expect(version.download?.url.startsWith('https://'), `${id} uses a non-HTTPS source`).toBe(true)
        expect(version.download?.checksum.length, `${id} checksum length`).toBeGreaterThanOrEqual(64)
      }
    }
  })
})

describe('environment profiles', () => {
  it('loads every built-in profile', () => {
    expect(profiles.size).toBe(profileFiles.length)
    expect(profiles.size).toBeGreaterThanOrEqual(5)
  })

  it('passes schema validation', () => {
    expect(profileIssues).toEqual([])
  })

  it('only references registry packages and has no duplicate components', () => {
    for (const [id, profile] of profiles) {
      expect(profile.components.length).toBeGreaterThan(0)
      const componentIds = profile.components.map((component) => component.packageId)
      expect(new Set(componentIds).size, `${id} has duplicate components`).toBe(componentIds.length)
      for (const component of profile.components) {
        expect(packages.has(component.packageId), `${id} references missing ${component.packageId}`).toBe(true)
      }
    }
  })
})
