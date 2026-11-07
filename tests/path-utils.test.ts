import { describe, expect, it } from 'vitest'
import {
  addPathEntries,
  createSimpleExpander,
  dedupePathEntries,
  findDuplicatePathEntries,
  isPathEntryPresent,
  normalizePathEntry,
  removePathEntries,
  sameVariableName,
  splitPathValue,
  stripQuotes
} from '@shared/path-utils'

const vars = {
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\dev'
}
const expand = createSimpleExpander(vars)

describe('normalizePathEntry', () => {
  it('normalizes separators, quotes, trailing slashes and case', () => {
    expect(normalizePathEntry('"C:/DevForge/Tools/"', expand)).toBe('c:\\devforge\\tools')
  })

  it('keeps drive roots intact', () => {
    expect(normalizePathEntry('C:\\', expand)).toBe('c:\\')
    expect(normalizePathEntry('D:/', expand)).toBe('d:\\')
  })

  it('expands well-known environment variables', () => {
    expect(normalizePathEntry('%LOCALAPPDATA%\\Programs', expand)).toBe(
      'c:\\users\\dev\\appdata\\local\\programs'
    )
  })
})

describe('PATH splitting and helpers', () => {
  it('splits semicolon separated values and ignores empty input', () => {
    expect(splitPathValue('C:\\a;C:\\b')).toEqual(['C:\\a', 'C:\\b'])
    expect(splitPathValue(null)).toEqual([])
    expect(splitPathValue('')).toEqual([])
  })

  it('strips only fully quoted values', () => {
    expect(stripQuotes('  "C:\\Tools"  ')).toBe('C:\\Tools')
    expect(stripQuotes('C:\\Tools')).toBe('C:\\Tools')
    expect(stripQuotes('"partial')).toBe('"partial')
  })

  it('detects entries regardless of case, quoting or trailing slash', () => {
    const existing = ['C:\\Windows', '"C:\\Tools\\"']
    expect(isPathEntryPresent(existing, 'c:/tools', expand)).toBe(true)
    expect(isPathEntryPresent(existing, 'C:\\Other', expand)).toBe(false)
  })

  it('compares variable names case-insensitively', () => {
    expect(sameVariableName('Path', 'PATH')).toBe(true)
    expect(sameVariableName('Path', 'PATHEXT')).toBe(false)
  })
})

describe('addPathEntries', () => {
  it('appends new entries without deleting existing ones', () => {
    const result = addPathEntries('C:\\Windows;C:\\Tools', ['C:\\DevForge\\Python'], expand, 'append')
    expect(result.value).toBe('C:\\Windows;C:\\Tools;C:\\DevForge\\Python')
    expect(result.added).toEqual(['C:\\DevForge\\Python'])
    expect(result.unchanged).toBe(false)
  })

  it('prepends when requested', () => {
    const result = addPathEntries('C:\\Windows', ['C:\\DevForge\\Node'], expand, 'prepend')
    expect(result.value).toBe('C:\\DevForge\\Node;C:\\Windows')
  })

  it('skips duplicates including differently formatted paths', () => {
    const result = addPathEntries('C:\\Tools\\', ['c:/tools'], expand)
    expect(result.unchanged).toBe(true)
    expect(result.value).toBe('C:\\Tools\\')
    expect(result.added).toEqual([])
  })

  it('deduplicates the candidate list itself', () => {
    const result = addPathEntries(null, ['C:\\DevForge\\Go', 'c:/devforge/go/'], expand)
    expect(result.value).toBe('C:\\DevForge\\Go')
    expect(result.added).toHaveLength(1)
  })

  it('never removes unrelated entries', () => {
    const original = '%USERPROFILE%\\bin;C:\\Windows;C:\\Program Files\\Git\\cmd'
    const result = addPathEntries(original, ['C:\\DevForge\\Python'], expand)
    expect(result.value.startsWith(original)).toBe(true)
    expect(result.removed).toEqual([])
  })
})

describe('removePathEntries', () => {
  it('removes only targeted entries', () => {
    const result = removePathEntries(
      'C:\\Windows;C:\\DevForge\\Python;C:\\Tools',
      ['c:/devforge/python/'],
      expand
    )
    expect(result.value).toBe('C:\\Windows;C:\\Tools')
    expect(result.removed).toEqual(['C:\\DevForge\\Python'])
    expect(result.unchanged).toBe(false)
  })

  it('reports unchanged when the entry is absent', () => {
    const result = removePathEntries('C:\\Windows', ['C:\\DevForge\\Python'], expand)
    expect(result.unchanged).toBe(true)
    expect(result.value).toBe('C:\\Windows')
  })

  it('drops empty segments while preserving remaining order', () => {
    const result = removePathEntries(';C:\\Windows;;C:\\Git;', ['C:\\Git'], expand)
    expect(result.value).toBe('C:\\Windows')
  })
})

describe('findDuplicatePathEntries', () => {
  it('finds duplicates after normalization', () => {
    expect(findDuplicatePathEntries('C:\\Tools;c:/tools/;C:\\Windows', expand)).toEqual(['c:/tools/'])
  })

  it('returns an empty list for a clean PATH', () => {
    expect(findDuplicatePathEntries('C:\\Windows;C:\\Tools', expand)).toEqual([])
  })
})

describe('dedupePathEntries', () => {
  it('keeps the first occurrence and the original order', () => {
    const result = dedupePathEntries('C:\\Windows;C:\\Tools;c:/windows/;C:\\Git', expand)
    expect(result.value).toBe('C:\\Windows;C:\\Tools;C:\\Git')
    expect(result.removed).toEqual(['c:/windows/'])
    expect(result.unchanged).toBe(false)
  })

  it('treats quoted and variable-based duplicates as the same entry', () => {
    const result = dedupePathEntries(
      '%LOCALAPPDATA%\\Programs;"C:\\Users\\dev\\AppData\\Local\\Programs"',
      expand
    )
    expect(result.value).toBe('%LOCALAPPDATA%\\Programs')
    expect(result.removed).toHaveLength(1)
  })

  it('reports unchanged when there are no duplicates', () => {
    const raw = 'C:\\Windows;C:\\Tools'
    const result = dedupePathEntries(raw, expand)
    expect(result.unchanged).toBe(true)
    expect(result.value).toBe(raw)
    expect(result.removed).toEqual([])
  })

  it('drops empty segments when duplicates are removed', () => {
    const result = dedupePathEntries(';C:\\Windows;;C:\\Windows;', expand)
    expect(result.value).toBe('C:\\Windows')
  })
})

describe('createSimpleExpander', () => {
  it('expands known variables recursively and leaves unknown ones', () => {
    const nested = createSimpleExpander({
      A: 'C:\\root',
      B: '%A%\\child'
    })
    expect(nested('%B%\\%UNKNOWN%')).toBe('C:\\root\\child\\%UNKNOWN%')
  })

  it('is case-insensitive on variable names', () => {
    expect(expand('%localappdata%\\Programs')).toBe('C:\\Users\\dev\\AppData\\Local\\Programs')
  })
})
