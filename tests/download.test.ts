import { describe, expect, it } from 'vitest'
import { inferFileName } from '../electron/main/services/download/DownloadManager'

describe('inferFileName', () => {
  it('uses the final URL path segment', () => {
    expect(inferFileName('https://www.python.org/ftp/python/3.12.4/python-3.12.4-amd64.exe')).toBe(
      'python-3.12.4-amd64.exe'
    )
  })

  it('decodes percent-encoded names and sanitizes spaces', () => {
    expect(inferFileName('https://example.com/files/Go%20installer.msi')).toBe('Go_installer.msi')
  })

  it('sanitizes characters that are invalid in file names', () => {
    expect(inferFileName('https://example.com/files/My%3ATool%3F.zip')).toBe('My_Tool_.zip')
  })

  it('uses the last path segment when the URL ends with a slash', () => {
    expect(inferFileName('https://example.com/downloads/')).toBe('downloads')
  })

  it('falls back for malformed URLs', () => {
    expect(inferFileName('not a url')).toBe('download.bin')
  })
})
