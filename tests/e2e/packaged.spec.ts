import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, _electron as electron } from '@playwright/test'

const root = resolve(__dirname, '..', '..')
const candidates = [
  resolve(root, 'dist', 'win-unpacked', 'DevForge.exe'),
  resolve(root, 'dist-build', 'win-unpacked', 'DevForge.exe')
]
  .filter((candidate) => existsSync(candidate))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
const executable = process.env.DEVFORGE_PACKAGED_EXE
  ? process.env.DEVFORGE_PACKAGED_EXE
  : candidates[0]

test.describe('packaged application', () => {
  test.skip(!executable, 'Packaged build not present; run "npm run package:dir" first.')

  test('boots from the packaged executable', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'devforge-packaged-'))
    const app = await electron.launch({
      executablePath: executable as string,
      args: [`--user-data-dir=${userDataDir}`]
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible({
        timeout: 60_000
      })
      await page.getByRole('link', { name: /Discover Software/ }).click()
      await expect(page.getByRole('heading', { name: 'Discover Software', exact: true })).toBeVisible()
      await expect(page.getByRole('textbox', { name: 'Search software' })).toBeVisible({
        timeout: 60_000
      })
      await expect(
        page.getByPlaceholder('Search for a language, framework, compiler, database or command…')
      ).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Online' })).toHaveCount(0)
      await expect(page.getByRole('tab', { name: 'Local' })).toHaveCount(0)
    } finally {
      await app.close()
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        // A background process may still release the temporary directory.
      }
    }
  })
})
