import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractZipSafely,
  safeZipEntrySegments
} from '../electron/main/services/install/ZipExtractor'

interface ZipEntrySpec {
  name: string
  data?: Buffer | string
  encrypted?: boolean
  symlink?: boolean
  unixMode?: number
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/** Minimal stored (uncompressed) ZIP writer so extraction tests need no extra dependency. */
function buildZip(entries: ZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const name = Buffer.from(entry.name, 'utf8')
    const isDirectory = entry.name.endsWith('/')
    const unixMode =
      entry.unixMode ?? (isDirectory ? 0o040755 : entry.symlink ? 0o120777 : 0o100644)
    const flags = 0x0800 | (entry.encrypted ? 0x0001 : 0)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(((unixMode << 16) >>> 0), 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + data.length
  }

  const central = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, central, end])
}

let directory: string
let zipPath: string
let destination: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'devforge-zip-'))
  zipPath = join(directory, 'archive.zip')
  destination = join(directory, 'out')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function writeZip(entries: ZipEntrySpec[]): void {
  writeFileSync(zipPath, buildZip(entries))
}

describe('extractZipSafely', () => {
  it('extracts nested files and directory entries', async () => {
    writeZip([
      { name: 'bin/' },
      { name: 'bin/tool.exe', data: 'binary' },
      { name: 'share/doc/readme.txt', data: 'hello' }
    ])

    const result = await extractZipSafely(zipPath, destination)
    expect(result.files).toBe(2)
    expect(readFileSync(join(destination, 'bin', 'tool.exe'), 'utf8')).toBe('binary')
    expect(readFileSync(join(destination, 'share', 'doc', 'readme.txt'), 'utf8')).toBe('hello')
  })

  it('normalizes backslash separators from Windows-created archives', async () => {
    writeZip([{ name: 'bin\\tool.exe', data: 'x' }])
    await extractZipSafely(zipPath, destination)
    expect(readFileSync(join(destination, 'bin', 'tool.exe'), 'utf8')).toBe('x')
  })

  it('rejects traversal, absolute and drive-letter paths', async () => {
    writeZip([{ name: '../escape.txt', data: 'bad' }])
    await expect(extractZipSafely(zipPath, destination)).rejects.toThrow(/escape|traversal|outside/i)

    writeZip([{ name: '/absolute.txt', data: 'bad' }])
    await expect(extractZipSafely(zipPath, destination)).rejects.toThrow(/absolute/i)

    writeZip([{ name: 'C:/windows/evil.txt', data: 'bad' }])
    await expect(extractZipSafely(zipPath, destination)).rejects.toThrow(/absolute/i)
  })

  it('rejects alternate data streams and reserved Windows names', async () => {
    writeZip([{ name: 'bin/tool.exe:stream', data: 'bad' }])
    await expect(extractZipSafely(zipPath, destination)).rejects.toThrow(/colon/i)

    writeZip([{ name: 'CON', data: 'bad' }])
    await expect(extractZipSafely(zipPath, destination)).rejects.toThrow(/reserved/i)
  })

  it('rejects symlinks and special files', async () => {
    writeZip([{ name: 'link', data: 'target', symlink: true }])
    await expect(extractZipSafely(zipPath, destination)).rejects.toThrow(/link or special/i)
  })

  it('rejects encrypted entries', async () => {
    writeZip([{ name: 'secret.txt', data: 'data', encrypted: true }])
    await expect(extractZipSafely(zipPath, destination)).rejects.toThrow()
  })

  it('does not overwrite a file already extracted from a duplicate entry', async () => {
    writeZip([
      { name: 'duplicate.txt', data: 'first' },
      { name: 'duplicate.txt', data: 'second' }
    ])
    await expect(extractZipSafely(zipPath, destination)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(join(destination, 'duplicate.txt'), 'utf8')).toBe('first')
  })

  it('enforces the configured entry and size limits', async () => {
    writeZip([
      { name: 'a.txt', data: 'a' },
      { name: 'b.txt', data: 'b' }
    ])
    await expect(
      extractZipSafely(zipPath, join(directory, 'out-entries'), { maxEntries: 1 })
    ).rejects.toThrow(/more than 1/)
    await expect(
      extractZipSafely(zipPath, join(directory, 'out-size'), { maxTotalBytes: 1 })
    ).rejects.toThrow(/size limit/)
  })
})

describe('safeZipEntrySegments', () => {
  it('keeps ordinary nested segments', () => {
    expect(safeZipEntrySegments('bin/tools/python.exe')).toEqual(['bin', 'tools', 'python.exe'])
  })

  it('rejects empty, oversized and trailing-dot names', () => {
    expect(() => safeZipEntrySegments('')).toThrow(/invalid/i)
    expect(() => safeZipEntrySegments(`${'a'.repeat(1025)}.txt`)).toThrow(/too long/i)
    expect(() => safeZipEntrySegments('folder./file.txt')).toThrow(/dot or space/i)
  })
})
