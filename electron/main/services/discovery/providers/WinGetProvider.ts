import { compareVersions } from '@shared/version'
import { inferCategory } from '@shared/discovery'
import type { PackageDefinition } from '@shared/registry'
import type { InstalledSummary } from '@shared/types'
import {
  buildWinGetPackage,
  inferSoftwareIcon,
  isHttpsUrl,
  managerIdForPackage,
  normalizeWinGetVersion,
  parseWinGetListTable,
  parseWinGetSearchTable,
  parseWinGetShow,
  wingetDiscoveryId,
  wingetPackageId,
  type WinGetSearchRow,
  type WinGetShowInfo
} from '@shared/winget'
import type { Logger } from '../../logging/Logger'
import type { ProcessExecutor } from '../../process/ProcessExecutor'
import { mapLimit } from '../concurrency'
import type {
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryProviderOutcome,
  ProviderDiscoveryResult
} from '../types'

const searchArgs = (query: string): string[] => [
  'search',
  '--query',
  query,
  '--source',
  'winget',
  '--count',
  '20',
  '--accept-source-agreements',
  '--disable-interactivity'
]

const showArgs = (wingetId: string): string[] => [
  'show',
  '--id',
  wingetId,
  '--exact',
  '--source',
  'winget',
  '--accept-source-agreements',
  '--disable-interactivity'
]

const listArgs = (): string[] => [
  'list',
  '--accept-source-agreements',
  '--disable-interactivity'
]

function firstLine(value: string): string {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? ''
}

export async function fetchWinGetShow(
  executor: ProcessExecutor,
  wingetId: string,
  timeoutMs = 20000
): Promise<{ info: WinGetShowInfo | null; error: string | null }> {
  try {
    const result = await executor.run('winget', showArgs(wingetId), {
      timeoutMs,
      maxOutputBytes: 1024 * 1024
    })
    if (result.exitCode !== 0) {
      return {
        info: null,
        error: firstLine(`${result.stdout}\n${result.stderr}`) || `WinGet exited with code ${result.exitCode}.`
      }
    }
    const info = parseWinGetShow(result.stdout)
    if (!info.id) {
      return { info: null, error: 'WinGet returned an unexpected manifest format.' }
    }
    return { info, error: null }
  } catch (error) {
    return { info: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function relevance(row: WinGetSearchRow, query: string): number {
  const normalizedQuery = query.trim().toLowerCase()
  const name = row.name.toLowerCase()
  const id = row.id.toLowerCase()
  if (name === normalizedQuery || id === normalizedQuery) return 0
  if (name.startsWith(normalizedQuery) || id.endsWith(`.${normalizedQuery}`)) return 1
  if (name.includes(normalizedQuery)) return 2
  if ((row.match ?? '').toLowerCase().startsWith('tag:')) return 3
  return 4
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class WinGetProvider implements DiscoveryProvider {
  readonly id = 'winget'
  readonly label = 'WinGet'
  private availability: { available: boolean; version: string | null; takenAt: number } | null = null
  private installedCache: { rows: Map<string, string | null>; takenAt: number } | null = null

  constructor(
    private readonly executor: ProcessExecutor,
    private readonly logger: Logger
  ) {}

  private async checkAvailability(): Promise<{ available: boolean; version: string | null }> {
    const now = Date.now()
    if (this.availability) {
      const ttl = this.availability.available ? 5 * 60 * 1000 : 30 * 1000
      if (now - this.availability.takenAt < ttl) {
        return { available: this.availability.available, version: this.availability.version }
      }
    }
    try {
      const result = await this.executor.run('winget', ['--version'], {
        timeoutMs: 10000,
        maxOutputBytes: 64 * 1024
      })
      const output = `${result.stdout}\n${result.stderr}`.trim()
      const available = result.exitCode === 0 && output.length > 0
      this.availability = {
        available,
        version: available ? firstLine(output) : null,
        takenAt: now
      }
    } catch (error) {
      this.availability = { available: false, version: null, takenAt: now }
      this.logger.warn('WinGet is not available for discovery', { error: errorMessage(error) })
    }
    return { available: this.availability.available, version: this.availability.version }
  }

  private async installedVersions(): Promise<Map<string, string | null>> {
    const now = Date.now()
    if (this.installedCache && now - this.installedCache.takenAt < 90 * 1000) {
      return this.installedCache.rows
    }
    try {
      const result = await this.executor.run('winget', listArgs(), {
        timeoutMs: 45000,
        maxOutputBytes: 4 * 1024 * 1024
      })
      const rows = new Map<string, string | null>()
      if (result.exitCode === 0) {
        for (const row of parseWinGetListTable(result.stdout)) {
          rows.set(row.id.toLowerCase(), row.version)
        }
      }
      this.installedCache = { rows, takenAt: now }
      return rows
    } catch (error) {
      this.logger.warn('WinGet installed package scan failed during discovery', {
        error: errorMessage(error)
      })
      this.installedCache = { rows: new Map(), takenAt: now }
      return this.installedCache.rows
    }
  }

  private installedByPackage(installations: InstalledSummary[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const record of installations) {
      if (record.status !== 'installed') continue
      const version = record.detectedVersion ?? record.version
      if (!map.has(record.packageId) || record.isActive) {
        map.set(record.packageId, version)
      }
    }
    return map
  }

  private knownByManager(packages: PackageDefinition[]): Map<string, PackageDefinition> {
    const map = new Map<string, PackageDefinition>()
    for (const pkg of packages) {
      const managerId = managerIdForPackage(pkg)
      if (managerId) map.set(managerId.toLowerCase(), pkg)
    }
    return map
  }

  private toResult(options: {
    row: WinGetSearchRow
    show: WinGetShowInfo | null
    error: string | null
    known: PackageDefinition | null
    candidate: PackageDefinition | null
    installedVersion: string | null
    candidateIdConflict: boolean
  }): ProviderDiscoveryResult {
    const { row, show, error, known, candidate, installedVersion, candidateIdConflict } = options
    const name = show?.name ?? row.name
    const version =
      normalizeWinGetVersion(show?.version) ?? normalizeWinGetVersion(row.version)
    const homepage = isHttpsUrl(show?.homepage)
      ? show?.homepage ?? null
      : isHttpsUrl(show?.publisherUrl)
        ? show?.publisherUrl ?? null
        : null

    let compatibility: ProviderDiscoveryResult['compatibility'] = 'metadata-only'
    let compatibilityNote: string | null = null

    if (known) {
      compatibility = 'installable'
      compatibilityNote = `Uses the existing DevForge package "${known.name}".`
    } else if (candidate && !candidateIdConflict) {
      compatibility = 'installable'
      compatibilityNote = 'Validated WinGet manifest with an official HTTPS homepage.'
    } else if (candidateIdConflict) {
      compatibilityNote =
        'This WinGet package maps to a DevForge package id that is already used. Search again or open the WinGet manifest manually.'
    } else if (!show || error) {
      compatibilityNote = `WinGet could not validate this manifest: ${error ?? 'unexpected metadata'}`
    } else if (!version) {
      compatibilityNote = 'WinGet reported a version that DevForge cannot represent safely.'
    } else if (!homepage) {
      compatibilityNote = 'WinGet did not report an official HTTPS homepage, so DevForge will not prepare an install package.'
    } else {
      compatibilityNote = error ?? 'The manifest could not be validated.'
    }

    const tags = (show?.tags ?? [])
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 6)
    if (tags.length === 0) {
      const match = row.match?.replace(/^[^:]+:\s*/, '').trim()
      if (match) tags.push(match)
    }
    if (known) {
      for (const tag of known.tags) {
        if (!tags.includes(tag)) tags.push(tag)
      }
    }

    const category = known?.category ?? candidate?.category ?? inferCategory({
      name,
      description: show?.description ?? '',
      tags,
      id: row.id
    })
    const icon =
      known?.icon ??
      candidate?.icon ??
      inferSoftwareIcon({ name, id: row.id, description: show?.description, tags })

    const updateAvailable = Boolean(
      installedVersion && version && compareVersions(version, installedVersion) > 0
    )

    return {
      id: wingetDiscoveryId(row.id),
      source: 'winget',
      sourceLabel: 'WinGet',
      managerId: row.id,
      name,
      publisher: show?.publisher ?? 'Unknown publisher',
      description:
        show?.description ??
        `${name} is published in the official WinGet community repository as ${row.id}.`,
      version,
      category,
      homepage,
      license: show?.license ?? null,
      tags: tags.slice(0, 8),
      icon,
      compatibility,
      compatibilityNote,
      packageId: known?.id ?? null,
      installedVersion,
      updateAvailable,
      verified: compatibility === 'installable',
      metadataUrl: compatibility === 'installable' ? homepage ?? known?.homepage ?? null : null
    }
  }

  async search(query: string, context: DiscoveryProviderContext): Promise<DiscoveryProviderOutcome> {
    const startedAt = Date.now()
    const availability = await this.checkAvailability()
    if (!availability.available) {
      return {
        results: [],
        candidates: new Map(),
        report: {
          id: this.id,
          label: this.label,
          status: 'error',
          message:
            'WinGet is not available on this computer. Install or repair App Installer from the Microsoft Store.',
          count: 0
        }
      }
    }

    let rows: WinGetSearchRow[]
    try {
      const result = await this.executor.run('winget', searchArgs(query), {
        timeoutMs: 30000,
        maxOutputBytes: 512 * 1024
      })
      if (result.exitCode !== 0) {
        const detail = firstLine(`${result.stderr}\n${result.stdout}`)
        throw new Error(detail || `WinGet exited with code ${result.exitCode}.`)
      }
      rows = parseWinGetSearchTable(result.stdout).slice(0, 40)
    } catch (error) {
      this.logger.warn('WinGet discovery search failed', { query, error: errorMessage(error) })
      return {
        results: [],
        candidates: new Map(),
        report: {
          id: this.id,
          label: this.label,
          status: 'error',
          message: `The WinGet search failed. ${errorMessage(error)}`,
          count: 0
        }
      }
    }

    if (rows.length === 0) {
      return {
        results: [],
        candidates: new Map(),
        report: {
          id: this.id,
          label: this.label,
          status: 'ok',
          message: 'No WinGet packages matched this search.',
          count: 0
        }
      }
    }

    const installedRows = await this.installedVersions()
    const installedByPackage = this.installedByPackage(context.installations)
    const knownByManager = this.knownByManager(context.knownPackages)

    rows.sort(
      (a, b) =>
        relevance(a, query) - relevance(b, query) || a.name.localeCompare(b.name)
    )
    const selected = rows.slice(0, 10)

    const validated = await mapLimit(selected, 4, async (row) => {
      const { info, error } = await fetchWinGetShow(this.executor, row.id)
      return { row, show: info, error }
    })

    const results: ProviderDiscoveryResult[] = []
    const candidates = new Map<string, PackageDefinition>()

    for (const entry of validated) {
      const { row, show, error } = entry
      const known = knownByManager.get(row.id.toLowerCase()) ?? null
      const version = normalizeWinGetVersion(show?.version) ?? normalizeWinGetVersion(row.version)
      const homepage = isHttpsUrl(show?.homepage)
        ? show?.homepage ?? null
        : isHttpsUrl(show?.publisherUrl)
          ? show?.publisherUrl ?? null
          : null
      const resultId = wingetDiscoveryId(row.id)
      let candidate: PackageDefinition | null = null
      let candidateIdConflict = false

      if (!known && show && version && homepage) {
        const proposedId = wingetPackageId(row.id)
        const collision = context.knownPackages.find((pkg) => pkg.id === proposedId)
        if (collision) {
          candidateIdConflict = true
        } else {
          candidate = buildWinGetPackage({
            wingetId: row.id,
            name: show.name ?? row.name,
            version,
            publisher: show.publisher ?? '',
            description: show.description ?? '',
            homepage,
            license: show.license ?? '',
            tags: show.tags,
            category: inferCategory({
              name: show.name ?? row.name,
              description: show.description ?? '',
              tags: show.tags,
              id: row.id
            })
          })
          candidates.set(resultId, candidate)
        }
      }

      const installedVersion =
        installedRows.get(row.id.toLowerCase()) ??
        (known ? installedByPackage.get(known.id) ?? null : null)

      results.push(
        this.toResult({
          row,
          show,
          error,
          known,
          candidate,
          installedVersion,
          candidateIdConflict
        })
      )
    }

    const installable = results.filter((result) => result.compatibility === 'installable').length
    const metadataOnly = results.length - installable
    const notValidated = rows.length - selected.length
    const messageParts: string[] = [`${installable} validated`]
    if (metadataOnly > 0) {
      messageParts.push(`${metadataOnly} metadata-only`)
    }
    if (notValidated > 0) {
      messageParts.push(`${notValidated} more not checked`)
    }
    this.logger.info('WinGet discovery search complete', {
      query,
      results: results.length,
      durationMs: Date.now() - startedAt
    })

    return {
      results,
      candidates,
      report: {
        id: this.id,
        label: this.label,
        status: 'ok',
        message: messageParts.join(' · '),
        count: results.length
      }
    }
  }
}
