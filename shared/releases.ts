import { compareVersions } from './version'

export const releaseChannels = ['stable', 'lts', 'preview'] as const
export type ReleaseChannel = (typeof releaseChannels)[number]

export interface ReleaseArchive {
  url: string
  checksum: string
  checksumAlgorithm: 'sha256' | 'sha512'
  archiveType: 'zip'
  sizeBytes: number | null
}

export interface ReleaseRecord {
  version: string
  channel: ReleaseChannel
  publishedAt: string | null
  archive: ReleaseArchive | null
}

export interface ReleaseSourceInfo {
  id: string
  label: string
  url: string | null
  kind: 'official' | 'package' | 'catalogue'
}

/**
 * Version information with provenance. A resolution is only labelled latest
 * when it came from an authoritative source; stale and fallback data remains
 * explicitly marked.
 */
export interface VersionResolution {
  latestStable: ReleaseRecord | null
  latestLts: ReleaseRecord | null
  latestPreview: ReleaseRecord | null
  others: ReleaseRecord[]
  source: ReleaseSourceInfo
  retrievedAt: string
  stale: boolean
  error: string | null
}

export function recommendedRelease(resolution: VersionResolution | null): ReleaseRecord | null {
  if (!resolution) return null
  return resolution.latestLts ?? resolution.latestStable ?? resolution.latestPreview
}

export function emptyResolution(
  source: ReleaseSourceInfo,
  error: string | null,
  retrievedAt = new Date().toISOString()
): VersionResolution {
  return {
    latestStable: null,
    latestLts: null,
    latestPreview: null,
    others: [],
    source,
    retrievedAt,
    stale: false,
    error
  }
}

export function isVersionNewer(candidate: string | null, current: string | null): boolean {
  if (!candidate || !current) return false
  return compareVersions(candidate, current) > 0
}
