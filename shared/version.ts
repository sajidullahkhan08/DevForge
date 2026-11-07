/**
 * Version comparison used by dependency constraints and update detection.
 * Handles real-world Windows package versions such as "21.0.13.9",
 * "17.11-5", "2.56.0.4", "v22.23.4", "go1.27.3".
 */

export interface ParsedVersion {
  segments: (number | string)[]
  raw: string
}

export function parseVersion(value: string): ParsedVersion | null {
  if (!value) return null
  const cleaned = String(value)
    .trim()
    .replace(/^(go|v)\s*/i, '')
    .replace(/\s+.*$/, '')
  const match = cleaned.match(/\d+(?:\.\d+)*(?:[-+._][A-Za-z0-9]+)*/)
  if (!match) return null

  const segments: (number | string)[] = []
  for (const part of match[0].split(/[.\-_+]/)) {
    if (part === '') continue
    if (/^\d+$/.test(part)) {
      segments.push(Number(part))
    } else {
      segments.push(part.toLowerCase())
    }
  }
  if (segments.length === 0) return null
  return { segments, raw: match[0] }
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1

  const length = Math.max(left.segments.length, right.segments.length)
  for (let i = 0; i < length; i += 1) {
    const l = left.segments[i]
    const r = right.segments[i]
    if (l === undefined) {
      if (typeof r === 'number' && r === 0) continue
      return typeof r === 'number' ? -1 : 1
    }
    if (r === undefined) {
      if (typeof l === 'number' && l === 0) continue
      return typeof l === 'number' ? 1 : -1
    }
    if (typeof l === 'number' && typeof r === 'number') {
      if (l !== r) return l < r ? -1 : 1
    } else if (typeof l === 'number') {
      return 1
    } else if (typeof r === 'number') {
      return -1
    } else if (l !== r) {
      return l < r ? -1 : 1
    }
  }
  return 0
}

export function satisfiesMinimum(installed: string | null | undefined, minimum: string | undefined): boolean {
  if (!installed) return false
  if (!minimum) return true
  return compareVersions(installed, minimum) >= 0
}

export function isSameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return compareVersions(a, b) === 0
}

const defaultVersionPattern = /\b(\d+(?:\.\d+){1,3})\b/

export function extractVersion(text: string, pattern?: string): string | null {
  if (!text) return null
  if (pattern) {
    try {
      const regex = new RegExp(pattern, 'i')
      const match = text.match(regex)
      if (match) {
        return match[1] ?? match[0]
      }
      return null
    } catch {
      return null
    }
  }
  const match = text.match(defaultVersionPattern)
  return match ? match[1] : null
}

export function testPattern(text: string, pattern: string | undefined): boolean {
  if (!pattern) return true
  try {
    return new RegExp(pattern, 'i').test(text)
  } catch {
    return false
  }
}

export function sortVersionsDescending(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a))
}

/**
 * Returns the highest valid version among the supplied values. Update checks
 * use this so a stale detection result can never make an installed package
 * look older than the version DevForge actually recorded.
 */
export function highestVersion(values: Array<string | null | undefined>): string | null {
  let highest: string | null = null
  for (const value of values) {
    if (!value) continue
    if (highest === null || compareVersions(value, highest) > 0) highest = value
  }
  return highest
}

export function sortVersionRecordsDescending<T extends { version: string }>(versions: T[]): T[] {
  return [...versions].sort((a, b) => compareVersions(b.version, a.version))
}

export function isVersionConstraintSatisfied(installed: string | null, minimum?: string): boolean {
  return satisfiesMinimum(installed, minimum)
}
