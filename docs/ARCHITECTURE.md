# Architecture

## Overview

DevForge is a three-layer Electron application:

```
┌──────────────────────────────────────────────────────────────────┐
│ Renderer (React 19 + Vite)                                       │
│ HashRouter pages · TanStack Query · Zustand · Radix UI · Recharts│
└──────────────────────────────┬───────────────────────────────────┘
                               │ window.devforge (contextBridge)
┌──────────────────────────────▼───────────────────────────────────┐
│ Preload (sandboxed)                                              │
│ Typed invoke wrappers + event subscriptions, no Node access      │
└──────────────────────────────┬───────────────────────────────────┘
                               │ ipcMain.handle (sender-checked, zod)
┌──────────────────────────────▼───────────────────────────────────┐
│ Main process                                                     │
│ AppContext · SQLite · registry · discovery · install engine · queue │
│ PowerShell / WinGet / installers · filesystem · environment      │
└──────────────────────────────────────────────────────────────────┘
```

The renderer is a normal web app. It has no `require`, no filesystem, no process APIs and no path to arbitrary shell execution. Every privileged operation goes through a named channel in [`shared/ipc.ts`](../shared/ipc.ts), is validated by [`electron/main/ipc.ts`](../electron/main/ipc.ts) and is executed by a service.

## Process lifecycle

1. Electron starts [`electron/main/index.ts`](../electron/main/index.ts), acquires a single-instance lock and waits for `app.whenReady()`.
2. `AppContext` is constructed:
   - opens or creates the SQLite database,
   - creates the logger,
   - loads the package registry, built-in profiles, persisted discovery metadata and canonical software identities,
   - creates the release resolver with its persisted provenance cache,
   - resolves settings (creating tools and download directories if necessary),
   - composes the remaining services.
3. `AppContext.initialize()` marks interrupted transactions, syncs accepted registry definitions into SQLite and logs startup counts.
4. IPC handlers are registered with a window getter, then the hardened window is created. The tray controller is created only when the `keepInTray` setting is enabled.
5. After `did-finish-load`, `startBackgroundTasks()` runs real detection for every registry package (commands, known paths, services and a single cached WinGet listing), records results and emits activity. Detection of independent packages runs with a small concurrency limit after shared caches are warmed; database writes stay ordered. It then restores persisted queue items when `resumeQueueOnStartup` is enabled and refreshes metadata for packages added through software discovery when that metadata is at least 12 hours old.
6. The renderer subscribes to queue, activity, verification and notification events and uses TanStack Query for request/response data.

When the last window closes the app quits, unless `keepInTray` is enabled and the tray exists, in which case the window is hidden and the queue can continue. `before-quit` shuts down the queue: it pauses processing and aborts any controller-backed process. Closing the window while the tray is active only hides it; Quit from the tray sets the quitting flag first.

## Main-process services

| Service | Responsibility |
| --- | --- |
| `RegistryService` | Reads JSON packages and profiles, validates with zod plus semantic checks, reports issues, syncs accepted definitions into SQLite, and merges user-added discovery packages |
| `IdentityRegistry` | Loads the canonical identity registry, validates it, exposes matching and maps packages to identities independently of their source |
| `ReleaseResolver` | Resolves stable/LTS/preview channels from the provider declared by each identity, with provenance, in-flight de-duplication, TTL caching, stale-on-error handling and persistence |
| `DiscoveryService` | Runs one identity-aware search across the catalogue, WinGet and authoritative release feeds; ranks, deduplicates and merges results per product; validates candidates before prepare; refreshes discovered metadata |
| `DiscoveryStore` | Persists discovery-added package definitions, per-source refresh timestamps and the release cache to `userData/discovered-packages.json` (versioned, atomic, v1-compatible) without touching the SQLite schema |
| `SettingsService` | Validated preferences, directory checks, diagnostics export, download cache cleanup, database info |
| `AppDatabase` | Schema migrations, repositories for catalog, installations, transactions, logs, verification, activity, environment backups and settings |
| `Planner` / `PlannerService` | Pure dependency resolution and plan construction; service adds installed state, architecture, disk and WinGet availability |
| `InstallationQueue` | Serialized execution, stage/state tracking, cancel/retry/remove/move/clear, notifications, ETA inputs and persisted pending state |
| `QueueStateStore` | Atomically persists pending `{packageId, version}` requests and the auto-start flag to `<userData>/queue-state.json`; plans are rebuilt on restore |
| `TrayController` | Optional tray icon, queue-aware menu and tooltip, pause/resume and quit |
| `InstallationEngine` | WinGet, archive, official-installer and recipe execution, environment configuration, verification, uninstall, repair, switching and registry/upstream update checks. Optional Authenticode publisher/thumbprint pinning is enforced for official installers after the checksum |
| `DownloadManager` | HTTPS-only streaming download, `.part` file, SHA-256/SHA-512 verification, cache reuse, optional proxy agent |
| `ZipExtractor` | `yauzl`-based extraction with path confinement, symlink/encryption rejection, duplicate protection and entry/size limits |
| `SoftwareDetector` / `VerificationEngine` | Detection from commands, files, services and WinGet; verification runs with per-check output. Detection concurrency is bounded while shared WinGet/uninstall caches are reused |
| `EnvironmentManager` | User/system variable reads and writes, PATH normalization, idempotent preview/apply with already-satisfied detection, targeted duplicate cleanup, doctor findings, backups and targeted reversal |
| `ProjectService` | Inspects a project folder, validates pinned installed versions, generates `.devforge/environment.json` plus activation/deactivation PowerShell scripts, and removes only its own files |
| `TemplateResolver` | Expands `{toolsDir}`, `{installDir}`, `{version}` and related placeholders in paths |
| `CatalogueService` | Combines registry definitions, canonical identity metadata and installation records into catalogue items |
| `ProfileService` | Built-in and custom profile listing and validation, plus version-pinned manifest export/import with schema validation, name collision avoidance and warning propagation |
| `DashboardService` | Real metrics, health checks and recent activity for the dashboard |
| `PowerShellService` / `ProcessExecutor` | Fixed-script PowerShell operations and argument-array process execution with logging; bare Windows commands are resolved through PATH/PATHEXT so npm/yarn `.cmd` shims run without a free-form shell |

## Unified software discovery and version resolution

There is one search path. The renderer sends a query; the main process resolves canonical identities, queries providers and release feeds in parallel, then merges everything into one result per product:

```
DiscoverPage (renderer, debounced)
  → discovery:search ──► DiscoveryService.search()
                           ├─ IdentityRegistry            canonical matches and intent
                           ├─ WinGetProvider              winget search/show/list
                           ├─ ReleaseResolver             authoritative version channels
                           └─ official archive candidates Flutter / Dart / PHP
  → ranked, de-duplicated UnifiedDiscoveryResult[] + provider reports
  → discovery:prepare ─► re-validates the cached candidate
                          → RegistryService.registerDynamicPackage()
                          → DiscoveryStore.save() + SQLite catalogue sync
```

- **Canonical identity first.** `packages/identities.json` defines ids, official names, aliases, executables, package/WinGet ids, publishers, version source and installation adapters. Identity matching is exactness-biased; loose containment and typos become related suggestions, not the identified product. External rows merge only on an exact identifier or a strong (≥85) name match.
- **One result per product.** Curated packages, official archive candidates and WinGet rows are merged by identity, with normalized-name de-duplication as a fallback. Source precedence is curated, official archive, existing official package, existing WinGet package, then metadata-only.
- **Authoritative versions.** `ReleaseResolver` trusts only the provider declared by an identity (`nodejs`, `python`, `go`, `php`, `flutter`, `dart`, `github`, `winget`, `none`). Channels are populated only when a real record exists; WinGet manifests and curated versions are labelled as manifest versions, never "latest". Every resolution carries source, retrieval time, staleness and error. See [Unified Discovery and Version Resolution](DISCOVERY_AND_VERSIONS.md).
- **Provider boundary.** `DiscoveryProvider` implementations return normalised results, optional validated candidates and per-provider reports. WinGet runs with a 45 s timeout; failures are reported without failing the search. Official feeds are fetched only by HTTPS release providers with fixed endpoints and response-size limits.
- **Compatibility is explicit.** Install is available only for an existing validated package or a candidate backed by a validated WinGet manifest or an official archive with an HTTPS URL and SHA-256 checksum. Preview archives and GitHub repositories are never installable; they remain metadata-only.
- **Prepare is server-side.** The renderer sends a result id that must exist in the service's bounded, expiring index. The candidate is re-validated by zod and semantic rules before registration. Arbitrary package definitions cannot be injected from the renderer.
- **Caching.** Search responses are cached in memory for 10 minutes (case-insensitive, bounded). Release resolutions are cached for 6 hours (30 minutes for empty results), bounded to 120 identities, shared across concurrent requests and persisted. Installed listings are cached for 90 seconds.
- **Persistence.** Discovery-added packages and the release cache live in `<userData>/discovered-packages.json` (version 2; version 1 files remain readable, writes are atomic). Static registry definitions always win an id collision.
- **Metadata refresh.** Background and manual refresh rebuild WinGet packages and official archive packages older than 12 hours, preserving ids/categories/icons. A WinGet outage skips WinGet metadata instead of deleting packages; a release-feed failure keeps the existing package.
- **No bundled payloads.** Discovery stores metadata only. Downloads and installers remain external, checksum-verified and cached separately by `DownloadManager`.

## Reproducible environments and project pinning

Two mechanisms use the same validated registry definitions but solve different problems:

- **Portable environment manifest** (`shared/manifest.ts`). Export writes schema version 2 with `kind: "devforge-environment"`, exact preferred versions, optional flags, the version observed on the exporting machine, app/platform metadata and warnings. Import validates the file strictly, skips packages missing from the catalogue with a warning, removes duplicate components (first wins), and calls the normal profile creation path. Names are made unique case-insensitively, so importing never overwrites an existing profile. Nothing is installed by import.
- **Project environment** (`shared/project.ts`, `ProjectService`). `.devforge/environment.json` pins installed package versions for one folder. Generation verifies each version has a recorded installation folder, expands the package's declared environment templates against that folder, and writes `.devforge/activate.ps1` and `deactivate.ps1`. The activation script only mutates the current PowerShell process: it captures the original PATH once, prepends unique existing directories, sets variables, warns about missing folders and restores PATH on deactivation. Project configs are size-limited, schema-validated, must be absolute existing folders, and are rejected for drive roots and Windows system directories.

## Queue persistence, tray and notifications

The queue keeps its authoritative state in memory and mirrors only the actionable subset to `QueueStateStore`:

- Each enqueue, start, pause, cancel, retry, move, remove, clear or completion rewrites `<userData>/queue-state.json` atomically (temporary file plus rename). Only pending/running `{packageId, version}` pairs and the auto-start flag are stored — never plans or filesystem handles.
- On startup, if `resumeQueueOnStartup` is enabled, requests are re-enqueued through the normal path and plans are rebuilt against the current registry and installed state. Invalid or oversized state files are ignored with a log entry; they are not treated as trusted input.
- Reordering rebuilds the queue map's insertion order, and the processing loop always takes the first pending item, so only not-yet-started entries can move.
- Notifications are raised by the main process and retained until closed; clicking one focuses or recreates the window. Settings changes emit to listeners so the tray can be created or destroyed immediately.
- The tray menu shows the pending count, toggles pause/resume through the same queue API as the renderer and disposes cleanly before quit.

## Proxy and network configuration

`proxyUrl` and `proxyBypass` settings are validated and applied in `AppContext`:

- `FetchHttpClient` and `DownloadManager` route requests through an `undici` `ProxyAgent` with the bypass list.
- Child installer processes receive the matching proxy environment variables.
- The renderer never receives proxy credentials or makes network requests itself; all traffic starts in the main process. WinGet remains a separate client and may need its own proxy configuration.

## Renderer structure

```
src/
  App.tsx                 QueryClient, event bridge, router, toaster
  pages/                  Dashboard, Discover, PackageDetail, Environments,
                          Installed, Queue, EnvironmentVariables, Versions,
                          History, Settings
  components/
    layout/               AppShell, Sidebar and CommandPalette (Ctrl+K)
    common/               PageHeader, PlanDialog, RecipeDialog, StageList,
                          VerificationDialog, ConfirmDialog, EmptyState, ...
    ui/                   Button, Dialog, Select, Switch, Tabs, Tooltip, ...
  hooks/
    useData.ts            Query keys and query hooks
    useTheme.ts           Resolves dark/light/system preference
  store/ui.ts             Persisted sidebar state
  lib/                    IPC facade, formatting, icons, feedback, navigation
```

`AppShell` provides a skip link and a focusable `<main>` region. `CommandPalette` is a Radix dialog with a screen-reader title, keyboard navigation and a shared action list for routes, common operations and catalogue packages. The sidebar search button and `Ctrl/Cmd+K` both dispatch the same open event.

### Data flow

- **Request/response:** hooks call `api.*`, which invokes a channel. Errors thrown in main are normalized into `CODE: message` strings and parsed back into friendly messages by `parseIpcError`.
- **Server events:** `EventBridge` in [`src/App.tsx`](../src/App.tsx) subscribes once and writes updates into the query cache:
  - queue snapshots update the queue and dashboard immediately,
  - new activity refreshes dashboard and history,
  - verification completions invalidate installation, catalogue and dashboard queries,
  - notifications become toasts and are also raised as Windows notifications by the main process.
- **Settings:** persisted through the database; `useResolvedTheme` reads the query and toggles the `dark` class, so saved theme changes apply without a restart. The startup page setting is honored by the index route redirect.
- **Unified discovery:** `useDiscoverySearch` is enabled at two or more characters with a 10-minute stale time. `DiscoverPage` debounces the query, shows instant catalogue matches while external sources run, ignores outdated responses through query keys, and renders one result per identity with optional details. Preparing a result mutates the catalogue server-side; the page then invalidates catalogue, installation and discovery queries before opening the normal plan dialog.
- **Canonical identity in the catalogue:** `CatalogueService` attaches the mapped identity to each `CatalogueItem`, so package details can show the official product, upstream version source and command names without a second lookup.

### UI system

Dark-first CSS variables define background, card, border, primary, success, warning, destructive, sidebar and chart tokens. Components follow shadcn/ui conventions but only Radix primitives that are installed are used (dialog, label, scroll area, select, slot, switch, tabs, tooltip); progress, separator and confirmation dialogs are small local components. Recharts renders catalogue coverage on the dashboard. Brand icons come from `simple-icons` with explicit dark-theme color overrides and a generic terminal fallback.

## Database schema

SQLite is accessed through Node's built-in `node:sqlite` `DatabaseSync`. The file lives at `<userData>/devforge.db`. WAL, foreign keys and a busy timeout are enabled; migrations are versioned and transactional.

| Table | Contents |
| --- | --- |
| `packages`, `package_versions`, `package_dependencies`, `package_environment_specs`, `package_verification_specs`, `package_detection_paths` | Mirror of the validated registry for queries and history display |
| `installations` | One row per package/version/source with status, verification, env status and active flag |
| `installation_transactions` | One row per queue attempt, with errors and optional verification run |
| `installation_logs` | Stage, command, arguments, exit code, stdout and stderr per attempt |
| `verification_runs`, `verification_checks` | Verified output and per-check results |
| `environment_variables`, `environment_backups` | Managed variable state plus additive PATH/variable changes and restore markers |
| `environment_profiles`, `profile_packages` | Built-in and custom profiles |
| `activity_log` | User-visible activity feed |
| `download_cache` | Cached installer metadata |
| `update_cache` | Last known available versions |
| `user_settings` | JSON-encoded validated preferences |
| `schema_migrations` | Applied migration versions |

Interrupted transactions are marked on startup rather than silently reported as successful. Discovery-added packages and release-metadata provenance are deliberately stored outside SQLite in `<userData>/discovered-packages.json`; they are merged into the catalogue on every launch, so no migration or database reset is required when discovery gains fields. The version 2 file remains backward-compatible with version 1.

## Dependency planning

`buildInstallationPlan` is a pure function over registry packages, requests and installed records. It:

1. de-duplicates explicit requests,
2. resolves required dependencies recursively and warns about missing optional ones,
3. records required version minimums,
4. detects circular dependencies with the visiting path,
5. produces a topological order with dependencies first,
6. selects versions (exact request, highest satisfying minimum, or package default),
7. marks steps `install`, `upgrade`, `configure`, `skip`, `project-recipe` or `unsupported`; an installed version whose package declares environment changes but has `envStatus !== 'configured'` becomes `configure`, so a failed configuration can be retried without reinstalling files,
8. aggregates admin, restart and download size requirements,
9. applies disk-space thresholds and WinGet availability checks.

Because it is pure, the logic is covered by targeted unit tests; `PlannerService` only supplies OS facts.

## Queue concurrency

Installations are intentionally serialized. Installers, environment variables, PATH and the tools directory are shared resources, and parallel installs would make truthful stage reporting and rollback difficult. Downloads may use a configured concurrency limit inside the engine, but installation itself runs one item at a time. The live queue is in memory; history persists in SQLite and the pending subset is mirrored to `queue-state.json` as described above.

## Build pipeline

- `electron-vite` builds three targets: main, preload and renderer.
- Main and preload bundle to CommonJS in `out/`; runtime dependencies (`yauzl`, `zod`) are externalized by `externalizeDepsPlugin`.
- The renderer uses the Vite React plugin with `src` as root and aliases `@` and `@shared`.
- A build-only plugin injects a Content-Security-Policy meta tag.
- `electron-builder` packages `out/`, `package.json`, the registry, profiles, `packages/identities.json` and the tray icon (`extraResources`) into an asar application and an NSIS installer. Only JSON files from `packages/registry`, `packages/profiles` and the identity registry are copied; no installers, SDK archives or discovery caches are bundled. The local unpacked Electron distribution is reused to keep repeated builds fast and reliable.
- The app icon is generated in `build/icon.png`; the installer is unsigned unless a signing certificate is configured. When `CSC_LINK` and `CSC_KEY_PASSWORD` are present, electron-builder signs the artifacts; the repository does not contain a certificate.
- `.github/workflows/ci.yml` runs typecheck, unit tests, build, production audit, SBOM generation and Playwright on Windows. `.github/workflows/release.yml` runs on version tags, builds the NSIS installer, and uploads the artifacts to a GitHub release. There is no electron-updater feed; updating is done by installing a newer setup.

## Design decisions and trade-offs

- **Registry as data, not code.** Packages cannot inject arbitrary scripts; only declared commands, URLs, checksums, environment templates and verification rules are executed.
- **Built-in SQLite.** Removes a native module rebuild step and keeps packaging simple. The Node runtime warns that `node:sqlite` is experimental; the API used is stable enough for this application and is covered by tests.
- **No auto-start on enqueue.** The plan dialog offers “Add to queue” and “Install now”; this keeps every execution an explicit user action.
- **Honest cancellation.** Only processes started directly can be reliably stopped. WinGet and third-party installers may continue in the background, and the UI says so rather than claiming a clean stop.
- **Local first, authoritative metadata where available.** There is no DevForge backend, account, telemetry or remote registry to operate. Curated definitions ship with the app; discovery queries the locally installed WinGet client and fixed HTTPS vendor release feeds, and only persists validated metadata. Versions are never inferred from search-result text.
- **Identity is separate from source.** A curated package, WinGet manifest and vendor archive can all describe the same product. Keeping identity, release resolution, discovery, installation and verification as separate adapters prevents one source from silently redefining another.
