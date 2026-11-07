import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  extractVersion,
  highestVersion,
  isSameVersion,
  parseVersion,
  satisfiesMinimum,
  sortVersionRecordsDescending,
  sortVersionsDescending,
  testPattern
} from '@shared/version'

describe('parseVersion', () => {
  it('parses dotted numeric versions', () => {
    expect(parseVersion('21.0.13.9')).toEqual({ segments: [21, 0, 13, 9], raw: '21.0.13.9' })
  })

  it('strips common prefixes used by Go and release tags', () => {
    expect(parseVersion('go1.27.3')?.segments).toEqual([1, 27, 3])
    expect(parseVersion('v22.23.4')?.segments).toEqual([22, 23, 4])
  })

  it('keeps textual pre-release suffixes as string segments', () => {
    expect(parseVersion('1.2.3-beta')?.segments).toEqual([1, 2, 3, 'beta'])
    expect(parseVersion('17.11-5')?.segments).toEqual([17, 11, 5])
  })

  it('returns null when there is no version', () => {
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders numeric segments', () => {
    expect(compareVersions('21.0.13.9', '17.0.0')).toBe(1)
    expect(compareVersions('2.56.0.4', '2.57.0.0')).toBe(-1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('treats trailing zero segments as equal', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })

  it('orders release versions above pre-releases', () => {
    expect(compareVersions('1.2.3', '1.2.3-beta')).toBe(1)
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(-1)
  })

  it('sorts arrays descending', () => {
    expect(sortVersionsDescending(['1.9.0', '1.10.0', '1.2.0'])).toEqual(['1.10.0', '1.9.0', '1.2.0'])
  })

  it('sorts version records without mutating input', () => {
    const records = [
      { version: '3.0.0', channel: 'stable' },
      { version: '1.0.0', channel: 'lts' },
      { version: '2.0.0', channel: 'stable' }
    ]
    expect(sortVersionRecordsDescending(records).map((record) => record.version)).toEqual([
      '3.0.0',
      '2.0.0',
      '1.0.0'
    ])
    expect(records[0].version).toBe('3.0.0')
  })
})

describe('highestVersion', () => {
  it('returns the greatest of the recorded and detected versions', () => {
    expect(highestVersion(['16.2.0', '6.3.0'])).toBe('16.2.0')
    expect(highestVersion(['9.0.4', '2.9.2'])).toBe('9.0.4')
  })

  it('handles mixed formats and ignores empty values', () => {
    expect(highestVersion([null, 'v22.23.4', undefined, '22.9.0'])).toBe('v22.23.4')
    expect(highestVersion([null, undefined, ''])).toBeNull()
  })

  it('keeps the first value when versions are equivalent', () => {
    expect(highestVersion(['1.2', '1.2.0'])).toBe('1.2')
  })
})

describe('version constraints', () => {
  it('checks minimum versions', () => {
    expect(satisfiesMinimum('20.0.0', '18.0.0')).toBe(true)
    expect(satisfiesMinimum('16.0.0', '18.0.0')).toBe(false)
    expect(satisfiesMinimum(null, '18.0.0')).toBe(false)
    expect(satisfiesMinimum('1.0.0', undefined)).toBe(true)
  })

  it('compares versions for equality across formats', () => {
    expect(isSameVersion('v20.0.0', '20.0.0')).toBe(true)
    expect(isSameVersion('20.0.1', '20.0.0')).toBe(false)
    expect(isSameVersion(null, '20.0.0')).toBe(false)
  })
})

describe('extractVersion', () => {
  it('extracts the first dotted version from command output', () => {
    expect(extractVersion('Python 3.12.4')).toBe('3.12.4')
    expect(extractVersion('git version 2.45.1.windows.1')).toBe('2.45.1')
  })

  it('uses a custom pattern when provided', () => {
    expect(extractVersion('openjdk 21.0.2 2024-01-16', 'openjdk (\\d+\\.\\d+\\.\\d+)')).toBe('21.0.2')
  })

  it('returns null for unparseable output', () => {
    expect(extractVersion('command not found')).toBeNull()
  })
})

describe('testPattern', () => {
  it('matches case-insensitively', () => {
    expect(testPattern('Python 3.12.4', 'python\\s+\\d')).toBe(true)
    expect(testPattern('Python 3.12.4', 'ruby')).toBe(false)
  })

  it('treats an invalid pattern as a failed match instead of throwing', () => {
    expect(testPattern('anything', '([unclosed')).toBe(false)
  })

  it('accepts everything when no pattern is given', () => {
    expect(testPattern('anything', undefined)).toBe(true)
  })
})
