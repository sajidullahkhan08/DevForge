import type { PackageCategory, PackageDefinition } from './registry'
import { inferCategory } from './discovery'

export interface WinGetSearchRow {
  name: string
  id: string
  version: string | null
  match: string | null
  source: string | null
}

export interface WinGetInstalledRow {
  name: string
  id: string
  version: string | null
  available: string | null
}

export interface WinGetShowInfo {
  name: string | null
  id: string | null
  version: string | null
  publisher: string | null
  publisherUrl: string | null
  homepage: string | null
  license: string | null
  description: string | null
  tags: string[]
  moniker: string | null
  hasInstaller: boolean
}

const wingetIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const versionPattern = /^\d+(\.\d+){0,3}([-+][A-Za-z0-9.]+)?$/

function linesOf(output: string): string[] {
  return output
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\t/g, '    '))
}

function headerIndex(lines: string[], required: string[]): number {
  return lines.findIndex((line) => required.every((token) => line.includes(token)))
}

export function parseWinGetSearchTable(output: string): WinGetSearchRow[] {
  const lines = linesOf(output)
  const index = headerIndex(lines, ['Name', 'Id', 'Version'])
  if (index < 0) return []
  const header = lines[index]
  const idStart = header.indexOf('Id')
  const versionStart = header.indexOf('Version')
  const matchStart = header.indexOf('Match')
  const sourceStart = header.indexOf('Source')
  if (idStart < 0 || versionStart <= idStart) return []

  const rows: WinGetSearchRow[] = []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^-{3,}/.test(trimmed)) continue
    if (trimmed.startsWith('<') || /^no (installed )?package found/i.test(trimmed)) break
    if (line.length <= idStart) continue

    const name = line.slice(0, idStart).trim()
    const id = line.slice(idStart, versionStart).trim()
    if (!wingetIdPattern.test(id)) continue

    let versionEnd = line.length
    let match: string | null = null
    let source: string | null = null
    if (matchStart > versionStart) {
      const matchEnd = sourceStart > matchStart ? sourceStart : line.length
      match = line.slice(matchStart, matchEnd).trim() || null
      versionEnd = matchStart
    }
    if (sourceStart > versionStart) {
      source = line.slice(sourceStart).trim() || null
      versionEnd = Math.min(versionEnd, sourceStart)
    }

    const version = line.slice(versionStart, versionEnd).trim() || null
    rows.push({ name: name || id, id, version, match, source })
  }
  return rows
}

export function parseWinGetListTable(output: string): WinGetInstalledRow[] {
  const lines = linesOf(output)
  const index = headerIndex(lines, ['Name', 'Id', 'Version'])
  if (index < 0) return []
  const header = lines[index]
  const idStart = header.indexOf('Id')
  const versionStart = header.indexOf('Version')
  const availableStart = header.indexOf('Available')
  const sourceStart = header.indexOf('Source')
  if (idStart < 0 || versionStart <= idStart) return []

  const rows: WinGetInstalledRow[] = []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^-{3,}/.test(trimmed)) continue
    if (/^no installed package found/i.test(trimmed)) break
    if (line.length <= idStart) continue

    const name = line.slice(0, idStart).trim()
    const id = line.slice(idStart, versionStart).trim()
    if (!wingetIdPattern.test(id)) continue

    const boundaries = [availableStart, sourceStart].filter((value) => value > versionStart)
    const versionEnd = boundaries.length > 0 ? Math.min(...boundaries) : line.length
    const version = line.slice(versionStart, versionEnd).trim() || null
    let available: string | null = null
    if (availableStart > versionStart) {
      const availableEnd = sourceStart > availableStart ? sourceStart : line.length
      available = line.slice(availableStart, availableEnd).trim() || null
    }
    rows.push({ name: name || id, id, version, available })
  }
  return rows
}

export function parseWinGetShow(output: string): WinGetShowInfo {
  const info: WinGetShowInfo = {
    name: null,
    id: null,
    version: null,
    publisher: null,
    publisherUrl: null,
    homepage: null,
    license: null,
    description: null,
    tags: [],
    moniker: null,
    hasInstaller: false
  }

  const found = output.match(/^Found\s+(.*?)\s*\[([^\]]+)\]/m)
  if (found) {
    info.name = found[1].trim() || null
    info.id = found[2].trim()
  }

  const fields = new Map<string, string>()
  let currentKey: string | null = null
  for (const line of linesOf(output)) {
    if (/^WARNING:/i.test(line.trim())) continue
    if (/^\s/.test(line)) {
      if (!currentKey) continue
      const text = line.trim()
      if (!text) continue
      const previous = fields.get(currentKey) ?? ''
      fields.set(currentKey, previous ? `${previous}\n${text}` : text)
      continue
    }
    if (!line.trim()) {
      currentKey = null
      continue
    }
    const field = line.match(/^([A-Za-z][A-Za-z0-9 ._()/-]{0,40}):\s*(.*)$/)
    if (!field) {
      currentKey = null
      continue
    }
    currentKey = field[1].trim().toLowerCase()
    fields.set(currentKey, field[2].trim())
    if (currentKey === 'installer') info.hasInstaller = true
  }

  const value = (key: string): string | null => {
    const raw = fields.get(key)
    if (!raw) return null
    const cleaned = raw.trim()
    return cleaned ? cleaned : null
  }

  info.version = value('version')
  info.publisher = value('publisher')
  info.publisherUrl = value('publisher url')
  info.homepage = value('homepage')
  info.license = value('license')
  info.moniker = value('moniker')

  const description = fields.get('description')
  info.description = description
    ? description.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim() || null
    : null

  const tags = fields.get('tags')
  info.tags = tags
    ? tags
        .split(/[\n,]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    : []

  return info
}

export function normalizeWinGetVersion(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/^v/i, '').trim()
  if (!cleaned || cleaned.length > 40 || !versionPattern.test(cleaned)) return null
  return cleaned
}

export function wingetDiscoveryId(wingetId: string): string {
  return `winget:${wingetId}`
}

export function githubDiscoveryId(fullName: string): string {
  return `github:${fullName}`
}

export function managerIdForPackage(pkg: PackageDefinition): string | null {
  return (
    pkg.packageManagerId ??
    pkg.versions.find((version) => version.isDefault)?.packageManagerId ??
    pkg.versions.find((version) => version.packageManagerId)?.packageManagerId ??
    null
  )
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function wingetPackageId(wingetId: string): string {
  const slug = wingetId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = `winget-${slug || stableHash(wingetId)}`.replace(/-{2,}/g, '-').replace(/-$/, '')
  if (base.length <= 64) return base
  const head = base.slice(0, 55).replace(/-+$/, '')
  return `${head}-${stableHash(wingetId)}`
}

export function isHttpsUrl(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const iconRules: { pattern: RegExp; icon: string }[] = [
  { pattern: /kotlin/i, icon: 'kotlin' },
  { pattern: /flutter/i, icon: 'flutter' },
  { pattern: /\bdart\b/i, icon: 'dart' },
  { pattern: /\bphp\b/i, icon: 'php' },
  { pattern: /\bruby\b|\brails\b/i, icon: 'ruby' },
  { pattern: /llvm|clang/i, icon: 'llvm' },
  { pattern: /g\+\+|c\+\+|cplusplus|\bcpp\b/i, icon: 'cplusplus' },
  { pattern: /mingw|\bgcc\b|\bgnu\b/i, icon: 'gnu' },
  { pattern: /gradle/i, icon: 'gradle' },
  { pattern: /maven/i, icon: 'apachemaven' },
  { pattern: /cmake/i, icon: 'cmake' },
  { pattern: /django/i, icon: 'django' },
  { pattern: /flask/i, icon: 'flask' },
  { pattern: /spring/i, icon: 'springboot' },
  { pattern: /react/i, icon: 'react' },
  { pattern: /github/i, icon: 'github' },
  { pattern: /\bgit\b/i, icon: 'git' },
  { pattern: /docker/i, icon: 'docker' },
  { pattern: /postgres/i, icon: 'postgresql' },
  { pattern: /mysql|mariadb/i, icon: 'mysql' },
  { pattern: /mongo/i, icon: 'mongodb' },
  { pattern: /python/i, icon: 'python' },
  { pattern: /node(js)?/i, icon: 'nodedotjs' },
  { pattern: /java|jdk/i, icon: 'openjdk' },
  { pattern: /\bgo(lang)?\b/i, icon: 'go' },
  { pattern: /rust|cargo/i, icon: 'rust' },
  { pattern: /\.net|dotnet/i, icon: 'dotnet' }
]

export function inferSoftwareIcon(input: {
  name: string
  id?: string | null
  description?: string | null
  tags?: string[]
}): string {
  const haystack = [input.name, input.id ?? '', input.description ?? '', ...(input.tags ?? [])].join(' ')
  for (const rule of iconRules) {
    if (rule.pattern.test(haystack)) return rule.icon
  }
  return 'terminal'
}

export interface WinGetPackageInput {
  wingetId: string
  name: string
  version: string
  publisher: string
  description: string
  homepage: string
  license: string
  tags: string[]
  category?: PackageCategory
  icon?: string
  packageId?: string
}

export function buildWinGetPackage(input: WinGetPackageInput): PackageDefinition {
  const id = input.packageId ?? wingetPackageId(input.wingetId)
  const category =
    input.category ??
    inferCategory({
      name: input.name,
      description: input.description,
      tags: input.tags,
      id: input.wingetId
    })
  const tags = [...new Set([...input.tags.map((tag) => tag.trim()).filter(Boolean), 'winget'])].slice(0, 8)
  const description =
    input.description.replace(/\s+/g, ' ').trim().slice(0, 500) ||
    `${input.name} is installed from the official WinGet manifest ${input.wingetId}.`

  return {
    schemaVersion: 1,
    id,
    name: input.name.trim().slice(0, 140) || input.wingetId,
    category,
    origin: 'winget',
    description,
    publisher: input.publisher.trim().slice(0, 160) || 'Unknown publisher',
    homepage: input.homepage,
    license: input.license.trim().slice(0, 120) || 'Not reported by WinGet',
    icon: input.icon ?? inferSoftwareIcon({ name: input.name, id: input.wingetId, tags: input.tags }),
    installationMethod: 'winget',
    packageManagerId: input.wingetId,
    scope: 'user',
    supportedArchitectures: ['x64'],
    supportedWindowsVersions: ['10', '11'],
    requiresAdmin: false,
    requiresRestart: false,
    advanced: false,
    caveats: [
      `Installed from the official WinGet manifest ${input.wingetId}. WinGet verifies installer signatures before running them.`,
      'WinGet or the vendor installer manages PATH and other environment settings. Open a new terminal after installation.',
      'DevForge refreshes this package metadata from WinGet, but does not support switching between older versions.',
      'The vendor installer may request administrator permission even when the package is installed for the current user.'
    ],
    tags,
    expectedExecutables: [],
    supportsVersionSwitching: false,
    versions: [
      {
        version: input.version,
        channel: 'stable',
        isDefault: true,
        packageManagerId: input.wingetId,
        installArgs: []
      }
    ],
    dependencies: [],
    environment: [],
    verification: [
      {
        id: 'winget-registered',
        label: 'WinGet package registration',
        kind: 'winget',
        args: [],
        optional: false
      }
    ],
    detection: { args: [], knownPaths: [] },
    uninstall: { method: 'winget', keepData: true, args: [] }
  }
}
