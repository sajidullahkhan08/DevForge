import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const root = resolve(__dirname, '..', '..')

let app: ElectronApplication
let page: Page
let userDataDir: string
const pageErrors: string[] = []

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'devforge-e2e-'))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // The OS may still hold a handle to the temporary user data directory.
  }
})

test('boots into the dashboard with real data', async () => {
  await expect(page).toHaveTitle(/DevForge/i)
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  await expect(page.getByText('Installed', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('navigation')).toBeVisible()
})

test('navigates the main sections without runtime errors', async () => {
  await page.getByRole('link', { name: /Discover Software/ }).click()
  await expect(page.getByRole('heading', { name: 'Discover Software', exact: true })).toBeVisible()
  await expect(page.getByText('Python', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Node.js', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Start with an environment profile')).toBeVisible()
  await expect(
    page.getByPlaceholder('Search for a language, framework, compiler, database or command…')
  ).toBeVisible()

  await page.getByRole('link', { name: /^Installed Software$/ }).click()
  await expect(page.getByRole('heading', { name: 'Installed Software', exact: true })).toBeVisible()

  await page.getByRole('link', { name: /^Installation Queue$/ }).click()
  await expect(page.getByRole('heading', { name: 'Installation Queue', exact: true })).toBeVisible()

  await page.getByRole('link', { name: /^Environment Variables$/ }).click()
  await expect(page.getByRole('heading', { name: 'Environment Variables', exact: true })).toBeVisible()

  await page.getByRole('link', { name: /^Version Manager$/ }).click()
  await expect(page.getByRole('heading', { name: 'Version Manager', exact: true })).toBeVisible()

  await page.getByRole('link', { name: /^Installation History$/ }).click()
  await expect(page.getByRole('heading', { name: 'Installation History', exact: true })).toBeVisible()

  await page.getByRole('link', { name: /^Settings$/ }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.getByText('Installation defaults')).toBeVisible()

  expect(pageErrors).toEqual([])
})

test('searches one unified result list per product', async () => {
  await page.getByRole('link', { name: /Discover Software/ }).click()
  const search = page.getByRole('textbox', { name: 'Search software' })
  await search.fill('Python')
  await expect(page.getByRole('link', { name: 'Python', exact: true })).toBeVisible({
    timeout: 90_000
  })
  await expect(page.getByText('Identified as Python')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('tab', { name: 'Online' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Local' })).toHaveCount(0)
  await expect(page.getByText(/metadata only|verified/i).first()).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('loads the environment profiles page', async () => {
  await page.getByRole('link', { name: /^Environments$/ }).click()
  await expect(page.getByRole('heading', { name: 'Development Environments', exact: true })).toBeVisible()
  await expect(page.getByText('Python Development', { exact: true })).toBeVisible({ timeout: 30_000 })
})
