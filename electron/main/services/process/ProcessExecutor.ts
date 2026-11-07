import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { AppError } from '../errors'

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  maxOutputBytes?: number
}

export interface RunResult {
  command: string
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
}

const defaultMaxOutput = 1024 * 1024

function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  try {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    // Best effort.
  }
}

/**
 * Command shims (.cmd/.bat) cannot be started directly without a command
 * interpreter. Every argument is validated and quoted before reaching cmd.exe
 * so that trusted registry definitions cannot smuggle shell operators.
 */
function quoteForCmd(value: string): string {
  if (/["\r\n&|<>^%]/.test(value)) {
    throw new AppError('VALIDATION', `Unsafe character in command argument: ${value}`)
  }
  return /[\s]/.test(value) ? `"${value}"` : value
}

function environmentValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

/**
 * Resolves a bare command to a real Windows executable. Node's spawn (without
 * a shell) only searches for .exe files, so package manager shims such as
 * npm.cmd and yarn.cmd would otherwise fail with ENOENT. Resolution follows
 * PATH and PATHEXT and never invokes a shell.
 */
export function resolveCommandExecutable(
  command: string,
  env: Record<string, string | undefined>,
  options: {
    platform?: NodeJS.Platform
    exists?: (path: string) => boolean
  } = {}
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' || !command) return command
  if (/[\\/]/.test(command)) return command
  if (/\.[A-Za-z0-9]+$/.test(command)) return command

  const exists = options.exists ?? existsSync
  const pathValue = environmentValue(env, 'PATH') ?? process.env.PATH ?? ''
  const pathExt =
    environmentValue(env, 'PATHEXT') ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  const extensions = pathExt
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`))
  if (extensions.length === 0) return command

  for (const rawDirectory of pathValue.split(';')) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, '$1')
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = win32.join(directory, `${command}${extension}`)
      if (exists(candidate)) return candidate
    }
  }
  return command
}

export class ProcessExecutor {
  private baseEnvironmentProvider: (() => Record<string, string>) | null = null

  /** Supplies proxy and related variables for every child process. */
  setBaseEnvironmentProvider(provider: () => Record<string, string>): void {
    this.baseEnvironmentProvider = provider
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    const startedAt = Date.now()
    const baseEnv = this.baseEnvironmentProvider?.() ?? {}
    const environment = { ...baseEnv, ...(options.env ?? {}) }
    const resolvedCommand = resolveCommandExecutable(command, environment)
    const isShim = /\.(cmd|bat)$/i.test(resolvedCommand)

    let executable = resolvedCommand
    let spawnArgs = args
    let windowsVerbatimArguments = false

    if (isShim) {
      const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
      const commandLine = `""${resolvedCommand}" ${args.map(quoteForCmd).join(' ')}"`
      executable = comspec
      spawnArgs = ['/d', '/s', '/c', commandLine]
      windowsVerbatimArguments = true
    }

    return await new Promise<RunResult>((resolve, reject) => {
      const maxOutput = options.maxOutputBytes ?? defaultMaxOutput
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let aborted = false
      let settled = false

      let child: ChildProcess
      try {
        child = spawn(executable, spawnArgs, {
          cwd: options.cwd,
          env: environment,
          windowsHide: true,
          windowsVerbatimArguments,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        reject(
          new AppError('INTERNAL', `Could not start "${command}".`, {
            details: error instanceof Error ? error.message : String(error)
          })
        )
        return
      }

      const append = (current: string, chunk: string): string => {
        const next = current + chunk
        return next.length > maxOutput ? next.slice(-maxOutput) : next
      }

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout = append(stdout, chunk)
        options.onStdout?.(chunk)
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr = append(stderr, chunk)
        options.onStderr?.(chunk)
      })

      const finish = (exitCode: number): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
        const result: RunResult = {
          command,
          args,
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          aborted
        }
        if (aborted) {
          reject(new AppError('CANCELLED', `"${command}" was cancelled.`))
          return
        }
        if (timedOut) {
          reject(
            new AppError('PROCESS_TIMEOUT', `"${command}" did not finish within ${Math.round((options.timeoutMs ?? 0) / 1000)} seconds.`, {
              hint: 'Check your network connection and try again.',
              details: stderr || stdout
            })
          )
          return
        }
        resolve(result)
      }

      const onAbort = (): void => {
        aborted = true
        killProcessTree(child.pid)
      }

      if (options.signal?.aborted) {
        aborted = true
        killProcessTree(child.pid)
      } else {
        options.signal?.addEventListener('abort', onAbort, { once: true })
      }

      let timeout: NodeJS.Timeout | null = null
      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true
          killProcessTree(child.pid)
        }, options.timeoutMs)
      }

      child.on('error', (error) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          reject(
            new AppError('NOT_FOUND', `The command "${command}" was not found.`, {
              hint: 'Install the related package or open a new terminal so PATH changes are applied.'
            })
          )
          return
        }
        reject(
          new AppError('INTERNAL', `Could not run "${command}".`, {
            details: error.message
          })
        )
      })

      child.on('close', (code) => {
        finish(code ?? -1)
      })
    })
  }

  isCancellation(error: unknown): boolean {
    return error instanceof AppError && error.code === 'CANCELLED'
  }
}
