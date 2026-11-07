# Testing

DevForge has three layers of automated tests plus a manual verification checklist. Unit and integration tests are fast, deterministic and do not touch the real system. End-to-end tests launch the actual Electron application with an isolated temporary user-data directory.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run all Vitest unit/integration suites once |
| `npm run test:watch` | Re-run Vitest on change |
| `npm run typecheck` | TypeScript check for main/preload (node config) and renderer (web config) |
| `npm run build` | Typecheck, then build main, preload and renderer with electron-vite |
| `npm run verify` | Typecheck, full unit suite and production build in sequence |
| `npm run audit:prod` | Audit production dependencies and fail on high-severity advisories |
| `npm run sbom` | Generate `dist/sbom.cdx.json` (CycloneDX 1.5) from the lockfile |
| `npm run test:e2e` | Build, then run Playwright against the development build |
| `npx playwright test` | Run Playwright without rebuilding (requires a previous build) |
| `npm run package:dir` | Build an unpacked application in `dist/win-unpacked` |
| `npm run package` | Build the NSIS installer in `dist/` |

Environment notes:

- `node:sqlite` prints an `ExperimentalWarning`. This is expected and does not affect test results.
- E2E tests on Windows open a real window. Run them in an interactive session, not in a service session with no desktop.
- Playwright is configured with one worker and a 120-second timeout because Electron startup and Windows detection can be slow on first run.
- The Vite native-loader warning about `__dirname` in `vitest.config.mts` is harmless.

## Unit and integration tests

Vitest runs in the Node environment with the `@shared` and `@` aliases. Configuration: [`vitest.config.mts`](../vitest.config.mts). Tests live in [`tests/`](../tests) and match `tests/**/*.test.ts`.

| Suite | Coverage |
| --- | --- |
| [`tests/version.test.ts`](../tests/version.test.ts) | Version parsing, numeric comparison, pre-release ordering, sorting, minimum satisfaction, version extraction and verification patterns |
| [`tests/path-utils.test.ts`](../tests/path-utils.test.ts) | PATH normalization, case handling, trailing separators, `%VAR%` expansion, duplicate detection and reporting, additive add/remove, duplicate cleanup that keeps the first occurrence, quoted entries, empty segments |
| [`tests/registry.test.ts`](../tests/registry.test.ts) | Every shipped package and profile file: zod schema, semantic rules, at least 20 packages, expected core ids, one default version, resolvable dependencies, HTTPS and checksums for archives, profile references |
| [`tests/identity.test.ts`](../tests/identity.test.ts) | Text normalization, fuzzy/alias scoring, identity resolution thresholds, provider identity matching, publisher disambiguation, schema/semantic validation of `identities.json`, and acceptance of the shipped identity registry for the required queries (Kotlin, kotlinc, Flutter, Dart, PHP, Composer, Ruby, GCC, MinGW, LLVM, Clang, Python, Rust, Node.js, MongoDB, CMake, unknown) |
| [`tests/identity-registry.test.ts`](../tests/identity-registry.test.ts) | Mapping packages to identities by package id, declared package ids, WinGet manager id and exact name plus publisher, rejection of wrong publishers, sorted listing and validation issues |
| [`tests/releases.test.ts`](../tests/releases.test.ts) | Node/Python/Go/PHP/Flutter/Dart release parsers, channel selection, provenance, GitHub Releases parsing, official archive checksum extraction, provider URLs and headers, resolver caching, concurrent dedupe, stale-on-error and fallback behavior |
| [`tests/official.test.ts`](../tests/official.test.ts) | Building schema-valid official archive packages for Flutter, Dart and PHP from resolved versions: LTS default, preview exclusion, missing checksums, environment/verification/uninstall fields and refusal to build without a verified archive |
| [`tests/planner.test.ts`](../tests/planner.test.ts) | Dependency ordering, missing dependencies, cycle detection, already-installed skips, configure-only steps for unapplied environments, configured skips, optional warnings, upgrades, same-version skip, invalid versions, minimum version selection, architecture checks, WinGet availability, project recipes, disk thresholds, aggregated admin/restart/size, duplicate requests |
| [`tests/database.test.ts`](../tests/database.test.ts) | Migrations and table counts, settings round-trip/update/reset, installation upsert/active selection/removal/update, transactions and interrupted marking, logs, verification linkage, activity ordering, profile CRUD, download cache |
| [`tests/template.test.ts`](../tests/template.test.ts) | Template expansion and validation, unknown placeholders, absolute Windows path checks, directory-name sanitization, template context |
| [`tests/download.test.ts`](../tests/download.test.ts) | Download file-name inference: query strings, encoded names, spaces, trailing slashes and invalid URLs |
| [`tests/winget.test.ts`](../tests/winget.test.ts) | WinGet search/list/show parsers, version normalization, provider-scoped ids, safe package-id generation, HTTPS-only URLs, icon inference, generated package schema and semantics |
| [`tests/winget-provider.test.ts`](../tests/winget-provider.test.ts) | Provider classification of known/validated/metadata-only results, installed version comparison, candidate creation, id-collision protection, unavailable WinGet and failed search handling using a fake executor |
| [`tests/discovery.test.ts`](../tests/discovery.test.ts) | Query validation, case-insensitive caching, partial provider failure, identity-aware dedupe, canonical result ranking, prepare of existing/candidate/metadata-only/expired results, official archive candidates, persistence to the discovery store, metadata refresh and 12-hour staleness, and custom package import validation/persistence using fake providers, fake release resolution and a temp store |
| [`tests/environment.test.ts`](../tests/environment.test.ts) | Idempotent preview/apply: already-satisfied PATH and variables, missing-directory warnings, missing-only changes, protected variables, elevation errors, backup recording, no-op apply, repeated apply, partial write failure, applyPackageEnvironment, and doctor findings/fixes for duplicate PATH cleanup and stale variables |
| [`tests/manifest.test.ts`](../tests/manifest.test.ts) | Environment manifest schema validation (strict fields, kind, component ids, empty lists), version pinning, duplicate-component handling, unique profile names and defaults for optional text |
| [`tests/project.test.ts`](../tests/project.test.ts) | Project config parsing, package/version validation, activation-script PATH and variable handling, quoting/escaping, duplicate suppression, CRLF output and deactivation |
| [`tests/queue-state.test.ts`](../tests/queue-state.test.ts) | Atomic queue-state save/load/clear, schema and request filtering, oversized/malformed files, temporary-file cleanup and empty-state deletion |
| [`tests/queue.test.ts`](../tests/queue.test.ts) | Enqueue ordering, pending-item move up/down, no-op boundaries, finished-item rejection, persistence of only unfinished requests and clearing completed state |
| [`tests/package-signature.test.ts`](../tests/package-signature.test.ts) | Optional Authenticode publisher/thumbprint schema, valid SHA-1-length pin, malformed thumbprints, unknown fields and empty publishers |
| [`tests/update-detection.test.ts`](../tests/update-detection.test.ts) | Fresh command evidence overrides a stale recorded detection; catalogue and update-check availability use the highest known installed version, still detect genuinely newer releases and clear stale available-version state |
| [`tests/process-executor.test.ts`](../tests/process-executor.test.ts) | Windows command resolution through PATH/PATHEXT, npm-style `.cmd` shims, quoted and empty PATH entries, explicit paths/extensions and non-Windows fallback |
| [`tests/install-directory.test.ts`](../tests/install-directory.test.ts) | Package marker reading, missing/empty/complete inspections, reuse, adoption, foreign-package and unowned-file conflicts, incomplete-install recovery confirmation, version replacement and empty-folder install decisions |
| [`tests/zip-extract.test.ts`](../tests/zip-extract.test.ts) | Safe ZIP extraction: nested files, Windows separators, traversal/absolute/drive paths, alternate data streams, reserved names, symlinks, encrypted entries, duplicate targets, entry/size limits and name validation |
| [`tests/packaging.test.ts`](../tests/packaging.test.ts) | Registry and profile trees contain only small JSON metadata; electron-builder copies JSON only; runtime dependencies stay minimal |

Current totals: **306 tests across 25 suites**, all passing.

They intentionally avoid real installs and real environment writes:

- The planner is a pure function; tests provide fabricated OS facts.
- Database tests use an in-memory `DatabaseSync` database and run the real migrations.
- PATH tests exercise the shared path utilities, not the Windows registry.
- Environment tests use a fake PowerShell adapter with an in-memory variable store, so no real user or machine environment is touched.
- Discovery tests inject fake providers, a fake release resolver and a fake process executor; no WinGet, vendor feed or GitHub request is made.
- Release-provider tests use a fake HTTP client, so no network access is required.
- Installation-folder tests create temporary directories under the OS temp folder and remove them afterwards.
- ZIP extraction tests build a minimal stored archive in memory, so no external zip tool or downloaded file is needed.
- Registry tests read the actual JSON files, so they catch invalid shipped definitions.

## End-to-end tests

Configuration: [`playwright.config.ts`](../playwright.config.ts). Specs live in [`tests/e2e/`](../tests/e2e).

### Development build

[`tests/e2e/app.spec.ts`](../tests/e2e/app.spec.ts):

1. Launches Electron with `args: ['.', '--user-data-dir=<temp>']` against the built `out/` output.
2. Waits for the dashboard and asserts the title, navigation and real stat labels.
3. Navigates to Discover Software, waits for the bundled catalogue (Python, Node.js), the environment-profile entry point and the unified search field.
4. Searches for `Python` and asserts one identity-labelled result list (`Identified as Python`), result metadata, and that no Local/Online tabs exist.
5. Visits Installed Software, Installation Queue, Environment Variables, Version Manager, Installation History and Settings.
6. Opens Development Environments and asserts the Python Development profile.
7. Fails if any uncaught `pageerror` occurred during navigation.

The temporary user-data directory ensures tests do not reuse your real installations, settings or activity. It is deleted after the run, with a best-effort cleanup if Windows still holds a handle.

This suite performs **no installs**. It verifies boot, IPC, registry loading, routing, rendering, unified discovery and the absence of runtime errors.

### Packaged application

[`tests/e2e/packaged.spec.ts`](../tests/e2e/packaged.spec.ts):

- Uses the newest of `dist/win-unpacked/DevForge.exe`, `dist-build/win-unpacked/DevForge.exe` and `dist-release/win-unpacked/DevForge.exe`; set `DEVFORGE_PACKAGED_EXE` to test a specific build.
- Skips with a clear message when the unpacked build is absent.
- Launches the executable with a temporary user-data directory, waits for the dashboard, then opens Discover Software and asserts the unified search field, its placeholder, and the absence of Local/Online tabs.
- This catches packaging mistakes that do not appear in the development build: missing `extraResources` (including `identities.json`), wrong renderer path, preload path issues and asar problems.

Run it after packaging:

```powershell
npm run package:dir
npx playwright test tests/e2e/packaged.spec.ts
```

## Test design rules

- **No mock success.** Tests assert real outputs. Where a real Windows write is unsafe, the fake adapter models the exact data and errors (duplicate PATH entries, rejected writes, unavailable WinGet, provider failures) and the test asserts the real outcome branches, including failures and partial results.
- **No destructive tests.** Automated tests never install software, edit the live environment, or uninstall packages.
- **Isolation.** Every database test gets a fresh in-memory database. Every E2E run gets a fresh user-data directory.
- **Determinism.** Time-dependent behavior uses injected or explicit values. Planner tests construct their own packages rather than relying on the shipped registry.
- **Regression focus.** New bugs get a test at the lowest layer that can reproduce them (path utility, planner, validation or database), not only an E2E case.

## Manual verification checklist

Use a disposable Windows VM or a clean folder when testing real installs. Complete these checks before a release:

### Startup and navigation

- [ ] First launch creates the database and shows the dashboard without errors.
- [ ] All nine sections load; no console errors.
- [ ] Theme switching applies immediately and survives a restart.
- [ ] Startup page preference is honored.
- [ ] Single-instance behavior focuses the existing window instead of starting a second copy.
- [ ] `Ctrl+K` opens the command palette; arrow keys move the selection, Enter navigates, Escape closes it.
- [ ] The skip link focuses the main region, and all primary controls are reachable by keyboard.
- [ ] With **Keep running in the tray** enabled, closing the window hides it and the tray menu can reopen, pause/resume and quit.
- [ ] With the setting disabled, closing the window quits normally.

### Catalogue and planning

- [ ] Search and category filters return expected packages.
- [ ] A WinGet package previews with skipped download stages.
- [ ] An archive package previews download and checksum stages.
- [ ] A recipe package shows commands and cannot be queued.
- [ ] Dependency ordering is visible (for example a profile with Python + dependent tooling).
- [ ] Disk and administrator warnings appear when applicable.

### Unified discovery and version resolution

- [ ] Search for Kotlin, kotlinc, Flutter, Dart, PHP, Composer, Ruby, GCC, MinGW, LLVM, Clang, Python, Rust, Node.js, MongoDB and CMake; each query identifies the intended product and shows one primary result per product.
- [ ] An exact or executable query (`kotlinc`) ranks the canonical product first; partial or misspelled text only appears as a related result.
- [ ] Results show publisher, latest stable or LTS, channel, platform, install method and status without exposing raw provider payloads.
- [ ] A version is labelled latest only when a release provider returned it; the detail page shows its source and retrieval time.
- [ ] A validated WinGet or official-archive result offers Install; a metadata-only result offers only View source and has no Install button.
- [ ] There are no Local/Online tabs; local matches appear immediately while external lookups finish, and typing a new query does not overwrite newer results with an older response.
- [ ] Preparing an official-archive result adds it to the catalogue and opens the normal plan dialog; installing downloads from the declared HTTPS URL and verifies the published SHA-256.
- [ ] Refresh metadata updates a changed WinGet manifest or official release without creating a duplicate product.
- [ ] With WinGet unavailable or a release feed rate-limited, the provider badge shows the failure, cached results remain visible and no version is guessed.
- [ ] **Import package** accepts a valid package JSON, rejects an existing id or malformed definition and shows the imported package in the catalogue.
- [ ] `Check for updates` labels an upstream-only release as informational and does not offer an unverified install.

### Installation

- [ ] WinGet package installs, detects its version and appears in Installed Software.
- [ ] Archive package downloads, verifies, extracts and validates expected executables.
- [ ] Bad checksum is rejected and the file is deleted.
- [ ] Existing non-empty target folder owned by another package or the user produces a conflict error and is not overwritten.
- [ ] An incomplete DevForge-owned folder requires recovery confirmation; confirming moves it to a `.devforge-backup-*` folder and installs a fresh copy.
- [ ] A complete existing installation with the marker is reused without downloading; its version and path are re-detected.
- [ ] Environment changes are additive and backed up; PATH keeps unrelated entries.
- [ ] Re-running environment configuration with everything already present succeeds as “already configured” and writes nothing.
- [ ] Removing one PATH entry, then re-running configuration, adds only the missing entry.
- [ ] A simulated write failure after one successful change reports the applied count (not full success) and keeps the first backup.
- [ ] Verification runs and shows per-check output.
- [ ] A failed verification marks the package as installed but failed, with actionable details.
- [ ] Cancel during download removes the partial file.
- [ ] Pause stops before the next queue item; resume continues.
- [ ] A pending item can be moved up/down; a running or finished item cannot.
- [ ] Elapsed time ticks for the running item and the ETA changes as items complete.
- [ ] Pending items survive a restart and are restored when resume-on-startup is enabled; state is cleared when the queue empties.
- [ ] Clicking a completion notification focuses or recreates the window.
- [ ] Restart-required result is shown honestly.

### Management

- [ ] Repair configuration re-applies environment changes.
- [ ] Uninstall removes the package, reverts only its environment changes and preserves unrelated PATH entries.
- [ ] Database packages never lose their data directory.
- [ ] Version switching works for a package that supports it, and is disabled for one that does not.
- [ ] Project environment generation writes only `.devforge` files, activation changes only the current shell, missing folders warn, and deactivation restores PATH.
- [ ] Exporting a profile writes a version-pinned manifest; importing it creates a renamed profile when the name exists and never overwrites.
- [ ] Environment variable add/remove/restore previews and applies correctly.
- [ ] The environment doctor finds duplicate PATH entries and a stale `JAVA_HOME`, previews exact before/after values and applies a targeted fix with a backup.
- [ ] With a proxy configured, downloads and release lookups use it and a bypass host connects directly.
- [ ] Restore refuses to overwrite a newer unrelated change.
- [ ] History shows stages, commands, exit codes and output; interrupted transactions are labeled.

### Packaging

- [ ] `npm run package` produces `dist/DevForge-Setup-1.0.0.exe`.
- [ ] The installer runs, installs per-user, and creates Start menu and desktop shortcuts.
- [ ] The packaged app contains only registry/profile JSON and `identities.json` under `resources/packages`; no installers, archives or discovery cache are bundled.
- [ ] The installed app launches and loads the bundled registry and profiles.
- [ ] Uninstalling DevForge removes the app but leaves user tools, database and logs in place.
- [ ] The artifact is code-signed for public distribution (the current local build is unsigned and may trigger SmartScreen).

## Troubleshooting test failures

| Failure | Likely cause |
| --- | --- |
| E2E cannot find Electron | Run `npm install`; Playwright uses the local Electron package |
| Blank window in E2E | Run `npm run build` first; the E2E launcher uses `out/` |
| Python/Node.js not found in Discover | Registry failed validation; run `npm test` and inspect registry issues |
| Database tests fail after a schema change | Add a new migration instead of editing an applied one |
| Playwright timeout | First launch runs detection for 20 packages; increase the timeout or pre-warm the machine |
| Packaged test skipped | Build an unpacked app with `npm run package:dir` |
| Discovery tests hang or make network calls | They should not; check that a test passes fake providers, a fake release resolver and a fake executor instead of constructing `DiscoveryService` without overrides |
| Locked `dist` folder during packaging | Close running DevForge instances and antivirus scans; repeated builds reuse the local Electron distribution to reduce locks |
| `ExperimentalWarning: SQLite` | Expected with `node:sqlite`; not a test failure |

## Continuous integration

Two workflows are included:

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on Windows for pushes and pull requests: `npm ci`, typecheck, unit tests, build, `npm run audit:prod`, SBOM generation (uploaded as an artifact), Playwright smoke tests and Playwright report upload on failure.
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on `v*` tags or manual dispatch: the same checks, NSIS packaging and upload of the installer and unpacked build to a GitHub release. Code signing is enabled only when `CSC_LINK` and `CSC_KEY_PASSWORD` secrets are configured.

The equivalent local sequence:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run audit:prod
npm run sbom
npx playwright test tests/e2e/app.spec.ts
npm run package
```

Keep `npm run package` as a separate artifact job. Packaged E2E requires a desktop-capable runner; on headless agents, run only Vitest and the type checker, or use a Windows runner with an interactive session. There is no auto-update feed to publish; the release workflow uploads installers only.

`audit:prod` deliberately audits only shipped dependencies. At the time of writing the full development tree reports moderate advisories in `minimatch` through the electron-builder toolchain; npm's suggested fix downgrades electron-builder and no non-breaking patched release is available. These packages are not shipped in the application. Re-run `npm audit` after a builder upgrade instead of applying a forced downgrade.
