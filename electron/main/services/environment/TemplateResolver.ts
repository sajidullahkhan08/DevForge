import { AppError } from '../errors'

export interface TemplateContext {
  installDir?: string | null
  toolsDir: string
  version?: string | null
  packageName?: string | null
  userProfile: string
  localAppData: string
  programFiles: string
  programFilesX86: string
  windowsDir: string
}

const variableMap: Record<string, keyof TemplateContext> = {
  '{installDir}': 'installDir',
  '{toolsDir}': 'toolsDir',
  '{version}': 'version',
  '{name}': 'packageName',
  '{userProfile}': 'userProfile',
  '{localAppData}': 'localAppData',
  '{programFiles}': 'programFiles',
  '{programFilesX86}': 'programFilesX86',
  '{windows}': 'windowsDir'
}

export function resolveTemplate(template: string, context: TemplateContext): string {
  let result = template
  for (const [token, key] of Object.entries(variableMap)) {
    if (!result.toLowerCase().includes(token.toLowerCase())) continue
    const value = context[key]
    if (value === undefined || value === null || value === '') {
      throw new AppError('VALIDATION', `The template "${template}" needs ${token} but no value is available.`, {
        hint: 'This path can only be resolved after the package has been installed and detected.'
      })
    }
    result = result.split(token).join(String(value))
  }
  const unresolved = result.match(/\{[A-Za-z]+\}/)
  if (unresolved) {
    throw new AppError('VALIDATION', `Unknown template placeholder ${unresolved[0]} in "${template}".`)
  }
  return result.replace(/\//g, '\\')
}

export function buildTemplateContext(options: {
  installDir?: string | null
  toolsDir: string
  version?: string | null
  packageName?: string | null
}): TemplateContext {
  const env = process.env
  return {
    installDir: options.installDir ?? null,
    toolsDir: options.toolsDir,
    version: options.version ?? null,
    packageName: options.packageName ?? null,
    userProfile: env.USERPROFILE ?? '',
    localAppData: env.LOCALAPPDATA ?? '',
    programFiles: env.ProgramFiles ?? 'C:\\Program Files',
    programFilesX86: env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    windowsDir: env.SystemRoot ?? 'C:\\Windows'
  }
}

export function sanitizeDirectoryName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'package'
}

export function isValidAbsoluteWindowsPath(value: string): boolean {
  if (!/^[a-zA-Z]:\\/.test(value)) return false
  if (/[\u0000-\u001f]/.test(value)) return false
  if (/["<>|*?]/.test(value)) return false
  return true
}

export function isUnsafeShellPath(value: string): boolean {
  return /[&^%!]/.test(value)
}
