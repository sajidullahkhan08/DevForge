/**
 * Pure PATH manipulation helpers. No I/O and no Electron imports so these can
 * be unit tested in isolation. Callers pass an expand function (normally
 * Environment.ExpandEnvironmentVariables equivalent) for duplicate detection.
 */

export type ExpandFunction = (value: string) => string

export function splitPathValue(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split(';')
}

export function stripQuotes(entry: string): string {
  const trimmed = entry.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function normalizePathEntry(entry: string, expand: ExpandFunction): string {
  let value = stripQuotes(entry).replace(/\//g, '\\')
  try {
    value = expand(value)
  } catch {
    // Leave the entry unexpanded when expansion fails.
  }
  value = value.replace(/\s+$/, '')
  // Remove trailing separators but keep drive roots like C:\
  value = value.replace(/\\+$/, '')
  if (/^[a-zA-Z]:$/.test(value)) {
    value += '\\'
  }
  return value.toLowerCase()
}

export function isPathEntryPresent(
  existingEntries: string[],
  candidate: string,
  expand: ExpandFunction
): boolean {
  const normalized = normalizePathEntry(candidate, expand)
  if (!normalized) return true
  return existingEntries.some((entry) => normalizePathEntry(entry, expand) === normalized)
}

export interface PathUpdateResult {
  value: string
  added: string[]
  removed: string[]
  unchanged: boolean
}

export function addPathEntries(
  rawValue: string | null | undefined,
  entries: string[],
  expand: ExpandFunction,
  strategy: 'append' | 'prepend' = 'append'
): PathUpdateResult {
  const existing = splitPathValue(rawValue)
  const working = existing.filter((entry) => entry.trim() !== '')
  const added: string[] = []

  for (const candidate of entries) {
    const cleaned = stripQuotes(candidate)
    if (!cleaned) continue
    if (isPathEntryPresent(working, cleaned, expand)) continue
    if (added.some((entry) => normalizePathEntry(entry, expand) === normalizePathEntry(cleaned, expand))) {
      continue
    }
    if (strategy === 'prepend') {
      working.unshift(cleaned)
    } else {
      working.push(cleaned)
    }
    added.push(cleaned)
  }

  if (added.length === 0) {
    return {
      value: rawValue ?? '',
      added: [],
      removed: [],
      unchanged: true
    }
  }

  return {
    value: working.join(';'),
    added,
    removed: [],
    unchanged: false
  }
}

/**
 * Removes repeated PATH entries while keeping the first occurrence and the
 * original ordering. Unlike removePathEntries this never removes the entry
 * entirely, so it is safe to use for cleanup.
 */
export function dedupePathEntries(
  rawValue: string | null | undefined,
  expand: ExpandFunction
): PathUpdateResult {
  const existing = splitPathValue(rawValue)
  const seen = new Set<string>()
  const kept: string[] = []
  const removed: string[] = []
  for (const entry of existing) {
    if (entry.trim() === '') continue
    const normalized = normalizePathEntry(entry, expand)
    if (normalized && seen.has(normalized)) {
      removed.push(entry)
      continue
    }
    if (normalized) seen.add(normalized)
    kept.push(entry)
  }
  if (removed.length === 0) {
    return { value: rawValue ?? '', added: [], removed: [], unchanged: true }
  }
  return { value: kept.join(';'), added: [], removed, unchanged: false }
}

export function removePathEntries(  rawValue: string | null | undefined,
  entries: string[],
  expand: ExpandFunction
): PathUpdateResult {
  const existing = splitPathValue(rawValue)
  const targets = new Set(entries.map((entry) => normalizePathEntry(entry, expand)))
  const removed: string[] = []
  const kept: string[] = []

  for (const entry of existing) {
    if (entry.trim() === '') continue
    if (targets.has(normalizePathEntry(entry, expand))) {
      removed.push(entry)
    } else {
      kept.push(entry)
    }
  }

  return {
    value: kept.join(';'),
    added: [],
    removed,
    unchanged: removed.length === 0
  }
}

export function findDuplicatePathEntries(
  rawValue: string | null | undefined,
  expand: ExpandFunction
): string[] {
  const seen = new Map<string, string>()
  const duplicates = new Set<string>()
  for (const entry of splitPathValue(rawValue)) {
    if (entry.trim() === '') continue
    const normalized = normalizePathEntry(entry, expand)
    if (!normalized) continue
    if (seen.has(normalized)) {
      duplicates.add(entry)
    } else {
      seen.set(normalized, entry)
    }
  }
  return [...duplicates]
}

export function sameVariableName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Very small expansion for well-known variables used in package templates.
 * Comparison-only; never used to rewrite raw registry values.
 */
export function createSimpleExpander(vars: Record<string, string | undefined>): ExpandFunction {
  return (value: string) => {
    let result = value
    for (let i = 0; i < 3; i += 1) {
      const next = result.replace(/%([^%]+)%/g, (match, name: string) => {
        const key = Object.keys(vars).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
        return key && vars[key] !== undefined ? (vars[key] as string) : match
      })
      if (next === result) break
      result = next
    }
    return result
  }
}
