import type { ReleaseArchive, ReleaseChannel, ReleaseRecord, ReleaseSourceInfo, VersionResolution } from '@shared/releases'
import { sortVersionRecordsDescending } from '@shared/version'

const prereleasePattern = /(?:^|[-._\s])(alpha|beta|rc|pre|preview|nightly|dev|snapshot|canary)(?:[-._\s]?\d*)/i

export function looksLikePrerelease(version: string): boolean {
  return prereleasePattern.test(version)
}

/**
 * Removes a leading "v" or product word from a tag while preserving suffix
 * information such as "2.5.0-Beta2" or "3.15.0a1".
 */
export function cleanVersion(raw: string): string {
  const value = raw.trim()
  if (!value) return value
  if (/^python\s+/i.test(value)) return value.replace(/^python\s+/i, '').trim()
  if (/^v\d/i.test(value)) return value.slice(1)
  return value
}

function record(
  version: string,
  channel: ReleaseChannel,
  publishedAt: string | null,
  archive: ReleaseArchive | null = null
): ReleaseRecord | null {
  const cleaned = cleanVersion(version)
  if (!cleaned) return null
  return {
    version: cleaned,
    channel,
    publishedAt: publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? publishedAt : null,
    archive
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseSize(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const match = value.match(/^([\d.]+)\s*(bytes|kb|mb|gb)?$/i)
    if (!match) return null
    const amount = Number(match[1])
    if (!Number.isFinite(amount)) return null
    const unit = (match[2] ?? 'bytes').toLowerCase()
    const factor = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1
    return Math.round(amount * factor)
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Node.js                                                             */
/* ------------------------------------------------------------------ */

export function parseNodeReleases(payload: unknown): ReleaseRecord[] {
  if (!Array.isArray(payload)) return []
  const records: ReleaseRecord[] = []
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const version = text(item.version)
    if (!version) continue
    const lts = typeof item.lts === 'string' && item.lts.length > 0
    const channel: ReleaseChannel = lts ? 'lts' : looksLikePrerelease(version) ? 'preview' : 'stable'
    const parsed = record(version, channel, text(item.date) || null)
    if (parsed) records.push(parsed)
  }
  return records
}

/* ------------------------------------------------------------------ */
/* Python                                                              */
/* ------------------------------------------------------------------ */

export function parsePythonReleases(payload: unknown): ReleaseRecord[] {
  if (!Array.isArray(payload)) return []
  const records: ReleaseRecord[] = []
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const name = text(item.name)
    if (!name) continue
    const pre = item.pre_release === true || looksLikePrerelease(name)
    const parsed = record(name, pre ? 'preview' : 'stable', text(item.release_date) || null)
    if (parsed) records.push(parsed)
  }
  return records
}

/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */

export function parseGoReleases(payload: unknown): ReleaseRecord[] {
  if (!Array.isArray(payload)) return []
  const records: ReleaseRecord[] = []
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const version = text(item.version)
    if (!version) continue
    const stable = item.stable === true
    const parsed = record(version, stable ? 'stable' : 'preview', null)
    if (parsed) records.push(parsed)
  }
  return records
}

/* ------------------------------------------------------------------ */
/* PHP for Windows                                                     */
/* ------------------------------------------------------------------ */

export const phpReleasesBaseUrl = 'https://windows.php.net/downloads/releases/'

export function parsePhpReleases(payload: unknown): ReleaseRecord[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const records: ReleaseRecord[] = []
  for (const branch of Object.values(payload as Record<string, unknown>)) {
    if (!branch || typeof branch !== 'object') continue
    const entry = branch as Record<string, unknown>
    const version = text(entry.version)
    if (!version) continue

    const flavorNames = Object.keys(entry)
    const flavor =
      flavorNames.find((key) => /^nts-vs\d+-x64$/.test(key)) ??
      flavorNames.find((key) => /^ts-vs\d+-x64$/.test(key))
    const flavorEntry = flavor ? (entry[flavor] as Record<string, unknown>) : null
    const zip = flavorEntry?.zip as Record<string, unknown> | undefined
    const path = text(zip?.path)
    const sha256 = text(zip?.sha256)
    const archive: ReleaseArchive | null =
      path && /^[a-f0-9]{64}$/i.test(sha256)
        ? {
            url: `${phpReleasesBaseUrl}${path}`,
            checksum: sha256.toLowerCase(),
            checksumAlgorithm: 'sha256',
            archiveType: 'zip',
            sizeBytes: parseSize(zip?.size)
          }
        : null

    const parsed = record(
      version,
      looksLikePrerelease(version) ? 'preview' : 'stable',
      text(flavorEntry?.mtime) || null,
      archive
    )
    if (parsed) records.push(parsed)
  }
  return records
}

/* ------------------------------------------------------------------ */
/* Flutter                                                             */
/* ------------------------------------------------------------------ */

export function parseFlutterReleases(payload: unknown): ReleaseRecord[] {
  if (!payload || typeof payload !== 'object') return []
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.releases)) return []
  const base = text(body.base_url) || 'https://storage.googleapis.com/flutter_infra_release/releases'
  const records: ReleaseRecord[] = []
  for (const entry of body.releases) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const version = text(item.version)
    const channelName = text(item.channel)
    if (!version || !channelName) continue
    const archivePath = text(item.archive)
    const sha256 = text(item.sha256)
    const archive: ReleaseArchive | null =
      /^https:\/\//.test(archivePath) && /^[a-f0-9]{64}$/i.test(sha256)
        ? {
            url: archivePath,
            checksum: sha256.toLowerCase(),
            checksumAlgorithm: 'sha256',
            archiveType: 'zip',
            sizeBytes: null
          }
        : archivePath && /^[a-f0-9]{64}$/i.test(sha256)
          ? {
              url: `${base}/${archivePath.replace(/^\/+/, '')}`,
              checksum: sha256.toLowerCase(),
              checksumAlgorithm: 'sha256',
              archiveType: 'zip',
              sizeBytes: null
            }
          : null
    const channel: ReleaseChannel = channelName === 'stable' ? 'stable' : 'preview'
    const parsed = record(version, channel, text(item.release_date) || null, archive)
    if (parsed) records.push(parsed)
  }
  return records
}

/* ------------------------------------------------------------------ */
/* Dart                                                                */
/* ------------------------------------------------------------------ */

export const dartArchiveBaseUrl = 'https://storage.googleapis.com/dart-archive'
export const dartChecksumPattern = /^[a-f0-9]{64}$/i

export function dartArchiveUrl(channel: 'stable' | 'beta', version: string): string {
  return `${dartArchiveBaseUrl}/channels/${channel}/release/${encodeURIComponent(version)}/sdk/dartsdk-windows-x64-release.zip`
}

export function parseDartVersion(payload: unknown, channel: 'stable' | 'beta'): ReleaseRecord | null {
  if (!payload || typeof payload !== 'object') return null
  const body = payload as Record<string, unknown>
  const version = text(body.version)
  if (!version) return null
  return record(version, channel === 'stable' ? 'stable' : 'preview', text(body.date) || null)
}

export function parseChecksumText(payload: string): string | null {
  const match = payload.trim().match(/^([a-f0-9]{64})(?:\s|\*|$)/i)
  return match ? match[1].toLowerCase() : null
}

/* ------------------------------------------------------------------ */
/* GitHub releases                                                     */
/* ------------------------------------------------------------------ */

export function parseGitHubReleases(payload: unknown): ReleaseRecord[] {
  if (!Array.isArray(payload)) return []
  const records: ReleaseRecord[] = []
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (item.draft === true) continue
    const tag = text(item.tag_name)
    if (!tag) continue
    const prerelease = item.prerelease === true || looksLikePrerelease(tag)
    const parsed = record(tag, prerelease ? 'preview' : 'stable', text(item.published_at) || null)
    if (parsed) records.push(parsed)
  }
  return records
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Turns a provider's release list into the channel-aware resolution shown in
 * the application. A channel is only populated when a record actually exists.
 */
export function buildVersionResolution(
  records: ReleaseRecord[],
  source: ReleaseSourceInfo,
  retrievedAt = new Date().toISOString(),
  error: string | null = null
): VersionResolution {
  const unique = new Map<string, ReleaseRecord>()
  for (const candidate of records) {
    if (!unique.has(candidate.version)) unique.set(candidate.version, candidate)
  }
  const ordered = sortVersionRecordsDescending([...unique.values()])

  const pick = (channel: ReleaseChannel): ReleaseRecord | null =>
    ordered.find((candidate) => candidate.channel === channel) ?? null

  const latestStable = pick('stable')
  const latestLts = pick('lts')
  const latestPreview = pick('preview')
  const selected = new Set(
    [latestStable, latestLts, latestPreview].filter((value): value is ReleaseRecord => value !== null)
  )

  return {
    latestStable,
    latestLts,
    latestPreview,
    others: ordered.filter((candidate) => !selected.has(candidate)).slice(0, 8),
    source,
    retrievedAt,
    stale: false,
    error
  }
}

export function packageVersionResolution(
  version: string,
  source: ReleaseSourceInfo
): VersionResolution {
  return buildVersionResolution(
    [
      {
        version,
        channel: 'stable',
        publishedAt: null,
        archive: null
      }
    ],
    source
  )
}

export function parseJson(textBody: string, label: string): unknown {
  try {
    return JSON.parse(textBody)
  } catch {
    throw new Error(`${label} returned an unreadable response.`)
  }
}
