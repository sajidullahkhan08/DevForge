import { describe, expect, it } from 'vitest'
import { resolveCommandExecutable } from '../electron/main/services/process/ProcessExecutor'

function resolver(files: string[]) {
  const available = new Set(files.map((file) => file.toLowerCase()))
  return (command: string, env: Record<string, string | undefined>) =>
    resolveCommandExecutable(command, env, {
      platform: 'win32',
      exists: (path) => available.has(path.toLowerCase())
    })
}

describe('resolveCommandExecutable', () => {
  it('resolves an npm shim through PATH and PATHEXT', () => {
    const resolve = resolver(['C:\\Program Files\\nodejs\\npm.cmd'])
    expect(
      resolve('npm', {
        PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
        PATHEXT: '.COM;.EXE;.BAT;.CMD'
      }).toLowerCase()
    ).toBe('c:\\program files\\nodejs\\npm.cmd')
  })

  it('honours PATHEXT precedence and quoted PATH entries', () => {
    const resolve = resolver(['C:\\tools\\yarn.cmd', 'C:\\tools\\yarn.exe'])
    const env = {
      Path: '"";"C:\\tools"',
      Pathext: '.CMD;.EXE'
    }
    expect(resolve('yarn', env).toLowerCase()).toBe('c:\\tools\\yarn.cmd')
    expect(resolve('yarn', { ...env, Pathext: '.EXE;.CMD' }).toLowerCase()).toBe(
      'c:\\tools\\yarn.exe'
    )
  })

  it('skips empty PATH entries and finds the first matching directory', () => {
    const resolve = resolver(['C:\\second\\tool.exe', 'C:\\first\\tool.exe'])
    expect(
      resolve('tool', { PATH: ';;C:\\first;;C:\\second', PATHEXT: '.EXE' }).toLowerCase()
    ).toBe('c:\\first\\tool.exe')
  })

  it('leaves paths, commands with extensions and non-Windows commands untouched', () => {
    expect(
      resolveCommandExecutable('C:\\tools\\run', {}, { platform: 'win32', exists: () => true })
    ).toBe('C:\\tools\\run')
    expect(
      resolveCommandExecutable('npm.cmd', {}, { platform: 'win32', exists: () => true })
    ).toBe('npm.cmd')
    expect(
      resolveCommandExecutable('npm', { PATH: 'C:\\nodejs' }, {
        platform: 'linux',
        exists: () => true
      })
    ).toBe('npm')
  })

  it('returns the original command when nothing matches', () => {
    const resolve = resolver([])
    expect(resolve('missing', { PATH: 'C:\\Windows', PATHEXT: '.EXE' })).toBe('missing')
  })
})
