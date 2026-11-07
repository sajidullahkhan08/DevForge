import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

export class Logger {
  private readonly logsDir: string

  constructor(logsDir: string) {
    this.logsDir = logsDir
    mkdirSync(logsDir, { recursive: true })
    this.cleanupOldLogs()
  }

  get directory(): string {
    return this.logsDir
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context)
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context)
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context)
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context)
  }

  private write(level: Level, message: string, context?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString()
    const line = JSON.stringify({ timestamp, level, message, ...(context ?? {}) })
    const prefix = `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`
    if (level === 'error') {
      console.error(prefix)
    } else if (level === 'warn') {
      console.warn(prefix)
    } else {
      console.log(prefix)
    }
    try {
      appendFileSync(join(this.logsDir, `devforge-${timestamp.slice(0, 10)}.log`), `${line}\n`, 'utf8')
    } catch {
      // Logging must never crash the app.
    }
  }

  private cleanupOldLogs(): void {
    try {
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
      for (const file of readdirSync(this.logsDir)) {
        if (!file.startsWith('devforge-') || !file.endsWith('.log')) continue
        const fullPath = join(this.logsDir, file)
        if (statSync(fullPath).mtimeMs < cutoff) {
          unlinkSync(fullPath)
        }
      }
    } catch {
      // Ignore cleanup failures.
    }
  }

  listLogFiles(): string[] {
    try {
      return readdirSync(this.logsDir)
        .filter((file) => file.endsWith('.log'))
        .map((file) => join(this.logsDir, file))
        .filter((file) => existsSync(file))
    } catch {
      return []
    }
  }
}
