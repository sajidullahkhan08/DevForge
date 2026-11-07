import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QueueStateStore } from '../electron/main/services/install/QueueStateStore'
import { Logger } from '../electron/main/services/logging/Logger'

let directory: string
let filePath: string
let store: QueueStateStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'devforge-queue-state-'))
  filePath = join(directory, 'state', 'queue-state.json')
  mkdirSync(join(directory, 'state'), { recursive: true })
  store = new QueueStateStore(filePath, new Logger(join(directory, 'logs')))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('QueueStateStore', () => {
  it('returns null when nothing has been saved', () => {
    expect(store.load()).toBeNull()
  })

  it('round-trips pending requests and the auto-start flag', () => {
    store.save({
      requests: [{ packageId: 'nodejs', version: '22.11.0' }, { packageId: 'python' }],
      autoStart: true
    })

    expect(store.load()).toEqual({
      requests: [{ packageId: 'nodejs', version: '22.11.0' }, { packageId: 'python' }],
      autoStart: true
    })
  })

  it('writes a versioned, timestamped document', () => {
    store.save({ requests: [{ packageId: 'go' }], autoStart: false })
    const stored = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(stored.schemaVersion).toBe(1)
    expect(typeof stored.savedAt).toBe('string')
    expect(stored.autoStart).toBe(false)
  })

  it('clears the file when the queue becomes empty', () => {
    store.save({ requests: [{ packageId: 'go' }], autoStart: false })
    store.save({ requests: [], autoStart: false })
    expect(store.load()).toBeNull()
  })

  it('ignores malformed JSON and unknown schema versions', () => {
    writeFileSync(filePath, '{not json', 'utf8')
    expect(store.load()).toBeNull()

    writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, requests: [{ packageId: 'go' }] }), 'utf8')
    expect(store.load()).toBeNull()
  })

  it('filters out invalid requests and ignores an empty result', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        requests: [{ packageId: '' }, { version: '1.0.0' }, { packageId: 'go', version: 3 }],
        autoStart: false
      }),
      'utf8'
    )
    expect(store.load()).toBeNull()
  })

  it('ignores an unexpectedly large state file', () => {
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, requests: [{ packageId: 'go' }], padding: 'x'.repeat(600 * 1024) }),
      'utf8'
    )
    expect(store.load()).toBeNull()
  })

  it('does not leave a temporary file behind', () => {
    store.save({ requests: [{ packageId: 'go' }], autoStart: true })
    expect(() => readFileSync(`${filePath}.tmp`, 'utf8')).toThrow()
  })
})
