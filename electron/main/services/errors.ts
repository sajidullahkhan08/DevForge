export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'ADMIN_REQUIRED'
  | 'WINGET_MISSING'
  | 'WINGET_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'DISK_SPACE'
  | 'PERMISSION_DENIED'
  | 'INSTALLER_FAILED'
  | 'INSTALLER_RESTART'
  | 'DIRECTORY_CONFLICT'
  | 'DEPENDENCY_CYCLE'
  | 'DEPENDENCY_UNSUPPORTED'
  | 'VERIFICATION_FAILED'
  | 'ENVIRONMENT_FAILED'
  | 'ENVIRONMENT_PARTIALLY_APPLIED'
  | 'PROCESS_TIMEOUT'
  | 'CANCELLED'
  | 'DATABASE'
  | 'INTERNAL'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly hint: string | null
  readonly details: string | null
  readonly stage: string | null

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string | null; details?: string | null; stage?: string | null } = {}
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.hint = options.hint ?? null
    this.details = options.details ?? null
    this.stage = options.stage ?? null
  }
}

export interface UserFacingError {
  code: string
  message: string
  hint: string | null
  details: string | null
}

export function toUserFacingError(error: unknown): UserFacingError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      details: error.details
    }
  }
  if (error instanceof Error) {
    return {
      code: 'INTERNAL',
      message: error.message,
      hint: 'Check the DevForge logs for technical details.',
      details: null
    }
  }
  return {
    code: 'INTERNAL',
    message: 'An unexpected error occurred.',
    hint: 'Check the DevForge logs for technical details.',
    details: null
  }
}

export function formatErrorForIpc(error: unknown): Error {
  const userFacing = toUserFacingError(error)
  const parts = [`${userFacing.code}: ${userFacing.message}`]
  if (userFacing.hint) parts.push(userFacing.hint)
  return new Error(parts.join('\n'))
}

export function mapWinGetExitCode(exitCode: number, output: string): AppError | null {
  if (exitCode === 0) return null
  const alreadyInstalled = /already installed|no newer package versions|Found an existing package/i.test(output)
  if (alreadyInstalled) return null

  if (exitCode === 3010 || exitCode === 1641) {
    return new AppError('INSTALLER_RESTART', 'The installer completed but requires a Windows restart.', {
      hint: 'Restart Windows to finish the installation, then verify the package again.'
    })
  }
  if (exitCode === 1602 || exitCode === 1223) {
    return new AppError('CANCELLED', 'The installation was cancelled.', {
      hint: 'Approve the Windows permission prompt to install this package.'
    })
  }
  if (exitCode === 1603 || exitCode === 5) {
    return new AppError('INSTALLER_FAILED', 'The installer failed with an access or fatal error.', {
      hint: 'Try again with administrator permission and check that no other installer is running.',
      details: `Exit code ${exitCode}`
    })
  }
  if (exitCode === 1618) {
    return new AppError('INSTALLER_FAILED', 'Another Windows installation is already in progress.', {
      hint: 'Wait for the other installation to finish, then retry.'
    })
  }
  if (exitCode === 1619 || exitCode === 1620) {
    return new AppError('INSTALLER_FAILED', 'The downloaded installer package could not be opened.', {
      hint: 'Clear temporary downloads in Settings, then retry.'
    })
  }
  return new AppError('INSTALLER_FAILED', `The installer exited with code ${exitCode}.`, {
    hint: 'Open the installation details to inspect the installer output.',
    details: output.slice(-4000)
  })
}
