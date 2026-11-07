import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { InstallRequest } from '@shared/types'
import type { Logger } from '../logging/Logger'

export interface PersistedQueueState {
  requests: InstallRequest[]
  autoStart: boolean
}

interface StoredFile {
  schemaVersion: 1
  savedAt: string
  requests: InstallRequest[]
  autoStart: boolean
}

/**
 * Persists the pending portion of the installation queue so an interrupted
 * session can be reviewed and resumed instead of silently losing work.
 * Only package ids and versions are stored; plans are rebuilt on startup
 * against the current registry and installed state.
 */
export class QueueStateStore {
  constructor(
    private readonly filePath: string,
    private readonly logger: Logger
  ) {}

  load(): PersistedQueueState | null {
    if (!existsSync(this.filePath)) return null
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      if (raw.length > 512 * 1024) {
        this.logger.warn('Queue state file is unexpectedly large; ignoring it')
        return null
      }
      const parsed = JSON.parse(raw) as Partial<StoredFile>
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.requests)) return null
      const requests = parsed.requests.filter(
        (request): request is InstallRequest =>
          Boolean(request) &&
          typeof request === 'object' &&
          typeof (request as InstallRequest).packageId === 'string' &&
          (request as InstallRequest).packageId.length > 0 &&
          ((request as InstallRequest).version === undefined ||
            typeof (request as InstallRequest).version === 'string')
      )
      if (requests.length === 0) return null
      return { requests, autoStart: parsed.autoStart === true }
    } catch (error) {
      this.logger.warn('Could not read saved queue state', { error: String(error) })
      return null
    }
  }

  save(state: PersistedQueueState): void {
    if (state.requests.length === 0) {
      this.clear()
      return
    }
    const payload: StoredFile = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      requests: state.requests,
      autoStart: state.autoStart
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.tmp`
      writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(temporary, this.filePath)
    } catch (error) {
      this.logger.warn('Could not persist queue state', { error: String(error) })
    }
  }

  clear(): void {
    try {
      rmSync(this.filePath, { force: true })
    } catch (error) {
      this.logger.warn('Could not clear saved queue state', { error: String(error) })
    }
  }
}
