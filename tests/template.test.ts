import { describe, expect, it } from 'vitest'
import {
  buildTemplateContext,
  isUnsafeShellPath,
  isValidAbsoluteWindowsPath,
  resolveTemplate,
  sanitizeDirectoryName
} from '../electron/main/services/environment/TemplateResolver'

const context = {
  installDir: 'C:\\DevForge\\Tools\\Python\\3.12.4',
  toolsDir: 'C:\\DevForge\\Tools',
  version: '3.12.4',
  packageName: 'Python',
  userProfile: 'C:\\Users\\dev',
  localAppData: 'C:\\Users\\dev\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  windowsDir: 'C:\\Windows'
}

describe('resolveTemplate', () => {
  it('substitutes install and tools directories', () => {
    expect(resolveTemplate('{installDir};{installDir}\\Scripts', context)).toBe(
      'C:\\DevForge\\Tools\\Python\\3.12.4;C:\\DevForge\\Tools\\Python\\3.12.4\\Scripts'
    )
    expect(resolveTemplate('{toolsDir}\\bin', context)).toBe('C:\\DevForge\\Tools\\bin')
  })

  it('substitutes version and package name', () => {
    expect(resolveTemplate('{toolsDir}\\{name}\\{version}', context)).toBe(
      'C:\\DevForge\\Tools\\Python\\3.12.4'
    )
  })

  it('normalizes forward slashes to Windows separators', () => {
    expect(resolveTemplate('{toolsDir}/PostgreSQL/bin', context)).toBe(
      'C:\\DevForge\\Tools\\PostgreSQL\\bin'
    )
  })

  it('throws a validation error when a placeholder has no value', () => {
    expect(() =>
      resolveTemplate('{installDir}', { ...context, installDir: null })
    ).toThrowError(/installDir/)
  })

  it('rejects unknown placeholders instead of leaving them in the value', () => {
    expect(() => resolveTemplate('{toolsDir}\\{unknown}', context)).toThrowError(/Unknown template placeholder/)
  })
})

describe('path validation', () => {
  it('accepts absolute Windows paths', () => {
    expect(isValidAbsoluteWindowsPath('C:\\DevForge\\Tools')).toBe(true)
    expect(isValidAbsoluteWindowsPath('D:\\a')).toBe(true)
  })

  it('rejects relative, UNC and malformed paths', () => {
    expect(isValidAbsoluteWindowsPath('DevForge\\Tools')).toBe(false)
    expect(isValidAbsoluteWindowsPath('\\\\server\\share')).toBe(false)
    expect(isValidAbsoluteWindowsPath('C:\\bad"path')).toBe(false)
    expect(isValidAbsoluteWindowsPath('C:\\bad|path')).toBe(false)
  })

  it('flags characters that are unsafe inside shell command strings', () => {
    expect(isUnsafeShellPath('C:\\DevForge\\Tools')).toBe(false)
    expect(isUnsafeShellPath('C:\\Tools & more')).toBe(true)
    expect(isUnsafeShellPath('C:\\Tools%PATH%')).toBe(true)
    expect(isUnsafeShellPath('C:\\Tools!')).toBe(true)
  })
})

describe('sanitizeDirectoryName', () => {
  it('removes Windows-reserved characters and trims', () => {
    expect(sanitizeDirectoryName('  Node.js: LTS <x64>  ')).toBe('Node.js LTS x64')
  })

  it('falls back when nothing usable remains', () => {
    expect(sanitizeDirectoryName('***')).toBe('package')
    expect(sanitizeDirectoryName('   ')).toBe('package')
  })
})

describe('buildTemplateContext', () => {
  it('fills missing optional values with null', () => {
    const built = buildTemplateContext({ toolsDir: 'C:\\DevForge\\Tools' })
    expect(built.toolsDir).toBe('C:\\DevForge\\Tools')
    expect(built.installDir).toBeNull()
    expect(built.version).toBeNull()
    expect(built.packageName).toBeNull()
    expect(built.programFiles).toBeTruthy()
    expect(built.windowsDir).toBeTruthy()
  })
})
