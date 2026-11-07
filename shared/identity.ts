import { z } from 'zod'
import { packageCategories } from './registry'

export const versionSourceKinds = [
  'nodejs',
  'python',
  'go',
  'php',
  'flutter',
  'dart',
  'github',
  'winget',
  'none'
] as const

export const installationAdapterKinds = [
  'catalogue',
  'winget',
  'official-archive'
] as const

export const officialArchiveKinds = ['flutter', 'php', 'dart'] as const

const identityEntrySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Identity ids use lowercase letters, digits and hyphens'),
  name: z.string().min(1),
  officialName: z.string().min(1),
  publisher: z.string().min(1),
  homepage: z.string().regex(/^https:\/\/[^\s]+$/, 'Must be a valid HTTPS URL'),
  category: z.enum(packageCategories),
  description: z.string().min(1),
  icon: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  executables: z.array(z.string().min(1)).default([]),
  packageIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
  wingetIds: z.array(z.string().min(1)).default([]),
  githubRepo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Must be an owner/repository pair')
    .nullable()
    .default(null),
  versionSource: z.enum(versionSourceKinds).default('none'),
  installationAdapters: z.array(z.enum(installationAdapterKinds)).default(['catalogue', 'winget']),
  officialArchive: z.enum(officialArchiveKinds).nullable().default(null),
  relatedTools: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  platforms: z.array(z.string().min(1)).default(['windows']),
  architectures: z.array(z.enum(['x64', 'arm64'])).default(['x64'])
})

export const identityRegistryFileSchema = z.object({
  schemaVersion: z.literal(1),
  identities: z.array(z.unknown())
})

export type VersionSourceKind = (typeof versionSourceKinds)[number]
export type InstallationAdapterKind = (typeof installationAdapterKinds)[number]
export type OfficialArchiveKind = (typeof officialArchiveKinds)[number]
export type CanonicalIdentity = z.infer<typeof identityEntrySchema>

export interface IdentityValidationIssue {
  file: string
  path: string
  message: string
}

export function validateIdentity(input: unknown, file = 'identity'):
  | { ok: true; value: CanonicalIdentity }
  | { ok: false; issues: IdentityValidationIssue[] } {
  const parsed = identityEntrySchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        file,
        path: issue.path.join('.') || '(root)',
        message: issue.message
      }))
    }
  }
  return { ok: true, value: parsed.data }
}

export function validateIdentitySemantics(identity: CanonicalIdentity): IdentityValidationIssue[] {
  const issues: IdentityValidationIssue[] = []
  if (identity.officialArchive && !identity.installationAdapters.includes('official-archive')) {
    issues.push({
      file: identity.id,
      path: 'installationAdapters',
      message: 'An official archive source requires the official-archive adapter'
    })
  }
  if (identity.versionSource === 'github' && !identity.githubRepo) {
    issues.push({
      file: identity.id,
      path: 'githubRepo',
      message: 'GitHub release resolution requires githubRepo'
    })
  }
  return issues
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

export type MatchTier = 'exact' | 'alias' | 'executable' | 'package' | 'related' | 'other'

export interface IdentityMatch {
  identity: CanonicalIdentity
  score: number
  tier: MatchTier
  reason: string
  matchedField: 'id' | 'name' | 'official-name' | 'alias' | 'executable' | 'package' | 'winget'
}

const qualifiers = new Set([
  'sdk',
  'cli',
  'compiler',
  'runtime',
  'interpreter',
  'language',
  'tool',
  'tools',
  'command',
  'line',
  'command line',
  'distribution',
  'for windows',
  'windows',
  'x64',
  '64 bit',
  'community',
  'server',
  'development kit'
])

/**
 * Loose comparison form: case, accents, punctuation and ".exe" removed.
 * "Node.js", "node", "node.exe" all become comparable values.
 */
export function normalizeSoftwareText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/\bexe\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function compact(input: string): string {
  return normalizeSoftwareText(input).replace(/\s+/g, '')
}

function isQualifierOrVersion(remainder: string): boolean {
  const value = remainder.trim()
  if (!value) return false
  if (/^v?\d/.test(value)) return true
  if (qualifiers.has(value)) return true
  return value.split(' ').every((word) => qualifiers.has(word))
}

function withinEditDistance(left: string, right: string, max: number): boolean {
  if (Math.abs(left.length - right.length) > max) return false
  if (left === right) return true
  if (left.length > 64 || right.length > 64) return false

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    let rowMin = current[0]
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      const insertion = current[j - 1] + 1
      const deletion = previous[j] + 1
      const value = Math.min(substitution, insertion, deletion)
      current[j] = value
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > max) return false
    previous = current
  }
  return previous[right.length] <= max
}

/**
 * Scores a name-like value against a query. Exact names dominate; loose
 * containment never reaches the "intent" threshold on its own.
 */
export function scoreTextMatch(candidate: string, query: string): number {
  const value = normalizeSoftwareText(candidate)
  const target = normalizeSoftwareText(query)
  if (!value || !target) return 0
  if (value === target) return 100
  if (compact(value) === compact(target)) return 98

  if (value.startsWith(`${target} `)) {
    const remainder = value.slice(target.length + 1)
    if (isQualifierOrVersion(remainder)) return 90
    return 64
  }
  if (target.startsWith(`${value} `)) {
    const remainder = target.slice(value.length + 1)
    if (isQualifierOrVersion(remainder)) return 88
    return 60
  }
  if (value.includes(` ${target} `)) return 72
  if (value.endsWith(` ${target}`)) return 70

  const candidateTokens = new Set(value.split(' '))
  const queryTokens = target.split(' ')
  if (queryTokens.every((token) => candidateTokens.has(token))) return 66

  const maxDistance = compact(target).length >= 7 ? 2 : compact(target).length >= 4 ? 1 : 0
  if (maxDistance > 0 && withinEditDistance(compact(value), compact(target), maxDistance)) {
    return 55
  }
  return 0
}

function tierFor(field: IdentityMatch['matchedField'], score: number): MatchTier {
  if (score < 80) return 'related'
  if (field === 'executable') return 'executable'
  if (field === 'package' || field === 'winget' || field === 'id') return 'package'
  if (field === 'alias') return 'alias'
  return 'exact'
}

function reasonFor(field: IdentityMatch['matchedField'], score: number): string {
  if (score < 80) return 'Closely related name'
  switch (field) {
    case 'executable':
      return 'Command name match'
    case 'alias':
      return 'Known alias match'
    case 'package':
    case 'winget':
    case 'id':
      return 'Package identifier match'
    case 'official-name':
      return 'Official product name match'
    default:
      return score >= 98 ? 'Exact software name match' : 'Name match'
  }
}

export function scoreIdentityMatch(identity: CanonicalIdentity, query: string): IdentityMatch | null {
  const candidates: { value: string; field: IdentityMatch['matchedField'] }[] = [
    { value: identity.id, field: 'id' },
    { value: identity.name, field: 'name' },
    { value: identity.officialName, field: 'official-name' },
    ...identity.aliases.map((alias) => ({ value: alias, field: 'alias' as const })),
    ...identity.executables.map((executable) => ({
      value: executable,
      field: 'executable' as const
    })),
    ...identity.packageIds.map((id) => ({ value: id, field: 'package' as const })),
    ...identity.wingetIds.map((id) => ({
      value: id.split('.').pop() ?? id,
      field: 'winget' as const
    }))
  ]

  let best: IdentityMatch | null = null
  for (const candidate of candidates) {
    const score = scoreTextMatch(candidate.value, query)
    if (score === 0) continue
    if (
      !best ||
      score > best.score ||
      (score === best.score && fieldPriority(candidate.field) < fieldPriority(best.matchedField))
    ) {
      best = {
        identity,
        score,
        tier: tierFor(candidate.field, score),
        reason: reasonFor(candidate.field, score),
        matchedField: candidate.field
      }
    }
  }
  return best
}

function fieldPriority(field: IdentityMatch['matchedField']): number {
  switch (field) {
    case 'name':
      return 0
    case 'official-name':
      return 1
    case 'alias':
      return 2
    case 'executable':
      return 3
    case 'id':
      return 4
    case 'package':
      return 5
    default:
      return 6
  }
}

export function matchIdentities(
  identities: CanonicalIdentity[],
  query: string,
  minScore = 55
): IdentityMatch[] {
  const matches: IdentityMatch[] = []
  for (const identity of identities) {
    const match = scoreIdentityMatch(identity, query)
    if (match && match.score >= minScore) matches.push(match)
  }
  return matches.sort(
    (left, right) =>
      right.score - left.score || left.identity.name.localeCompare(right.identity.name)
  )
}

export function resolveIntent(
  identities: CanonicalIdentity[],
  query: string
): IdentityMatch | null {
  const best = matchIdentities(identities, query, 80)[0]
  return best && best.score >= 85 ? best : null
}

export interface ProviderIdentityInput {
  name: string
  publisher?: string | null
  wingetId?: string | null
  packageId?: string | null
}

/**
 * Maps an external result to a canonical identity. Only strong matches are
 * merged; a loose name similarity must never silently replace the official
 * product with a similarly named package.
 */
export function matchProviderIdentity(
  identities: CanonicalIdentity[],
  input: ProviderIdentityInput
): IdentityMatch | null {
  const wingetId = input.wingetId?.toLowerCase() ?? null
  const packageId = input.packageId?.toLowerCase() ?? null
  const name = input.name.trim()

  let best: IdentityMatch | null = null
  for (const identity of identities) {
    if (packageId && (packageId === identity.id || identity.packageIds.includes(packageId))) {
      return {
        identity,
        score: 100,
        tier: 'package',
        reason: 'Package identifier match',
        matchedField: 'package'
      }
    }
    if (wingetId && identity.wingetIds.some((id) => id.toLowerCase() === wingetId)) {
      return {
        identity,
        score: 100,
        tier: 'package',
        reason: 'Verified WinGet identifier match',
        matchedField: 'winget'
      }
    }

    const direct = scoreTextMatch(identity.name, name)
    const official = scoreTextMatch(identity.officialName, name)
    const alias = identity.aliases.reduce(
      (highest, value) => Math.max(highest, scoreTextMatch(value, name)),
      0
    )
    const executable = identity.executables.reduce(
      (highest, value) => Math.max(highest, scoreTextMatch(value, name)),
      0
    )
    const score = Math.max(direct, official, alias, executable)
    if (score < 85) continue

    const publisherMatches =
      Boolean(input.publisher) &&
      normalizeSoftwareText(input.publisher ?? '')
        .split(' ')
        .some((word) =>
          word.length >= 4 && normalizeSoftwareText(identity.publisher).includes(word)
        )
    const adjusted = Math.min(100, score + (publisherMatches ? 2 : 0))
    if (!best || adjusted > best.score) {
      const field: IdentityMatch['matchedField'] =
        score === direct
          ? 'name'
          : score === official
            ? 'official-name'
            : score === alias
              ? 'alias'
              : 'executable'
      best = {
        identity,
        score: adjusted,
        tier: tierFor(field, adjusted),
        reason: 'Matched an official software identity',
        matchedField: field
      }
    }
  }
  return best
}
