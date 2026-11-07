import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  matchIdentities,
  matchProviderIdentity,
  normalizeSoftwareText,
  resolveIntent,
  scoreIdentityMatch,
  scoreTextMatch,
  validateIdentity,
  validateIdentitySemantics,
  type CanonicalIdentity
} from '@shared/identity'

function identity(overrides: Partial<CanonicalIdentity> & { id: string }): CanonicalIdentity {
  const { id, ...rest } = overrides
  return {
    schemaVersion: 1,
    id,
    name: id,
    officialName: id,
    publisher: 'Test Publisher',
    homepage: 'https://example.com/',
    category: 'language',
    description: 'Test software identity',
    icon: 'terminal',
    aliases: [],
    executables: [],
    packageIds: [],
    wingetIds: [],
    githubRepo: null,
    versionSource: 'none',
    installationAdapters: ['winget'],
    officialArchive: null,
    relatedTools: [],
    tags: [],
    platforms: ['windows'],
    architectures: ['x64'],
    ...rest
  }
}

const kotlin = identity({
  id: 'kotlin',
  name: 'Kotlin',
  officialName: 'Kotlin Programming Language',
  publisher: 'JetBrains',
  aliases: ['Kotlin', 'kotlinc', 'Kotlin compiler', 'Kotlin CLI'],
  executables: ['kotlinc', 'kotlin']
})

const flutter = identity({
  id: 'flutter',
  name: 'Flutter',
  officialName: 'Flutter SDK',
  publisher: 'Google',
  aliases: ['Flutter', 'Flutter SDK'],
  executables: ['flutter'],
  wingetIds: ['Google.Flutter'],
  officialArchive: 'flutter',
  installationAdapters: ['official-archive'],
  versionSource: 'flutter'
})

describe('normalizeSoftwareText', () => {
  it('removes case, punctuation and the .exe suffix', () => {
    expect(normalizeSoftwareText('Node.js')).toBe('node js')
    expect(normalizeSoftwareText('node.exe')).toBe('node')
    expect(normalizeSoftwareText('  Kotlin   Compiler ')).toBe('kotlin compiler')
  })

  it('preserves compiler-significant characters', () => {
    expect(normalizeSoftwareText('C++')).toBe('c++')
    expect(normalizeSoftwareText('C#')).toBe('c#')
    expect(normalizeSoftwareText('gcc.exe')).toBe('gcc')
  })
})

describe('scoreTextMatch', () => {
  it('scores exact and compact-equal names highest', () => {
    expect(scoreTextMatch('Kotlin', 'kotlin')).toBe(100)
    expect(scoreTextMatch('Node.js', 'node js')).toBe(100)
  })

  it('accepts a trailing qualifier but scores loose suffixes lower', () => {
    expect(scoreTextMatch('Node.js', 'node.js sdk')).toBe(88)
    expect(scoreTextMatch('Node.js', 'node.js runtime')).toBe(88)
    expect(scoreTextMatch('Ruby', 'Ruby on Rails')).toBe(60)
  })

  it('scores containment and trailing words below the intent threshold', () => {
    expect(scoreTextMatch('Visual Studio Code', 'code')).toBe(70)
    expect(scoreTextMatch('Windows Terminal', 'windows')).toBe(64)
  })

  it('allows a small typo tolerance only', () => {
    expect(scoreTextMatch('Kotlin', 'kottlin')).toBe(55)
    expect(scoreTextMatch('Kotlin', 'swift')).toBe(0)
  })
})

describe('scoreIdentityMatch', () => {
  it('matches canonical, official, alias and command names', () => {
    expect(scoreIdentityMatch(kotlin, 'Kotlin')?.score).toBe(100)
    expect(scoreIdentityMatch(kotlin, 'Kotlin Programming Language')?.matchedField).toBe('official-name')
    expect(scoreIdentityMatch(kotlin, 'Kotlin Compiler')?.matchedField).toBe('alias')
    expect(scoreIdentityMatch(kotlin, 'kotlinc')?.tier).toBe('alias')
    expect(scoreIdentityMatch(kotlin, 'flutter')).toBeNull()
  })

  it('does not infer an identity from a publisher-qualified identifier alone', () => {
    expect(scoreIdentityMatch(flutter, 'Google.Flutter')).toBeNull()
  })
})

describe('resolveIntent', () => {
  it('resolves strong matches but keeps typo suggestions below intent', () => {
    expect(resolveIntent([kotlin], 'kotlinc')?.identity.id).toBe('kotlin')
    expect(resolveIntent([kotlin], 'kottlin')).toBeNull()
    expect(matchIdentities([kotlin], 'kottlin')[0]?.score).toBe(55)
  })

  it('refuses weak containment matches', () => {
    expect(resolveIntent([kotlin], 'Kotlin script')).toBeNull()
    expect(resolveIntent([kotlin], 'ruby')).toBeNull()
  })
})

describe('matchIdentities', () => {
  it('sorts matches by score and filters low scores', () => {
    const node = identity({ id: 'nodejs', name: 'Node.js', aliases: ['Node'] })
    const matches = matchIdentities([node, kotlin, flutter], 'node')
    expect(matches[0]?.identity.id).toBe('nodejs')
    expect(matches.every((match) => match.score >= 55)).toBe(true)
  })
})

describe('matchProviderIdentity', () => {
  it('merges verified package and WinGet identifiers', () => {
    expect(
      matchProviderIdentity([flutter], { name: 'Some Flutter package', wingetId: 'google.flutter' })
        ?.identity.id
    ).toBe('flutter')
    expect(
      matchProviderIdentity([kotlin], { name: 'Unrelated', packageId: 'kotlin' })?.identity.id
    ).toBe('kotlin')
  })

  it('rewards a matching publisher on a strong name match', () => {
    const aliasless = identity({ id: 'flutter', name: 'Flutter', publisher: 'Google' })
    const withPublisher = matchProviderIdentity([aliasless], {
      name: 'Flutter CLI',
      publisher: 'Google LLC'
    })
    const withoutPublisher = matchProviderIdentity([aliasless], { name: 'Flutter CLI' })
    expect(withPublisher?.score).toBe(90)
    expect(withoutPublisher?.score).toBe(88)
    expect(withPublisher?.matchedField).toBe('name')
  })

  it('refuses loose name similarity so a name-alike cannot replace the official product', () => {
    expect(matchProviderIdentity([kotlin], { name: 'Kotlin Script' })).toBeNull()
    expect(matchProviderIdentity([kotlin], { name: 'Kotlin Tools Community Edition' })).toBeNull()
  })
})

describe('shipped identity registry', () => {
  const raw = JSON.parse(
    readFileSync(join(__dirname, '..', 'packages', 'identities.json'), 'utf8')
  ) as { identities: unknown[] }
  const shipped = raw.identities.map((entry) => {
    const result = validateIdentity(entry)
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join(', '))
    return result.value
  })

  const expectations: [string, string][] = [
    ['Kotlin', 'kotlin'],
    ['kotlinc', 'kotlin'],
    ['Flutter', 'flutter'],
    ['Dart', 'dart'],
    ['PHP', 'php'],
    ['Composer', 'composer'],
    ['Ruby', 'ruby'],
    ['GCC', 'mingw-w64'],
    ['MinGW', 'mingw-w64'],
    ['LLVM', 'llvm'],
    ['Clang', 'llvm'],
    ['Python', 'python'],
    ['Rust', 'rust'],
    ['Node.js', 'nodejs'],
    ['MongoDB', 'mongodb'],
    ['CMake', 'cmake']
  ]

  it.each(expectations)('resolves "%s" to %s', (query, expected) => {
    expect(resolveIntent(shipped, query)?.identity.id).toBe(expected)
  })

  it('keeps an unknown product unmatched and every identity schema-valid', () => {
    expect(resolveIntent(shipped, 'unknown-tool-xyz')).toBeNull()
    expect(shipped.length).toBeGreaterThanOrEqual(25)
  })
})

describe('identity validation', () => {
  it('accepts a complete identity', () => {
    const result = validateIdentity({ ...flutter, officialArchive: undefined })
    expect(result.ok).toBe(true)
  })

  it('rejects insecure homepages and unknown categories', () => {
    const insecure = validateIdentity({ ...kotlin, homepage: 'http://example.com/' })
    expect(insecure.ok).toBe(false)
    const category = validateIdentity({ ...kotlin, category: 'browser' })
    expect(category.ok).toBe(false)
  })

  it('flags cross-field inconsistencies', () => {
    const issues = validateIdentitySemantics({
      ...flutter,
      installationAdapters: ['winget']
    })
    expect(issues.some((issue) => issue.path === 'installationAdapters')).toBe(true)

    const githubIssues = validateIdentitySemantics({
      ...kotlin,
      versionSource: 'github',
      githubRepo: null
    })
    expect(githubIssues.some((issue) => issue.path === 'githubRepo')).toBe(true)
  })
})
