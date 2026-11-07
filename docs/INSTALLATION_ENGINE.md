# Installation Engine

The installation engine turns a validated package definition plus a user request into a real, observable Windows installation. It never simulates progress, never reports a failed operation as successful, and never executes anything that is not declared in the package registry.

Relevant source files:

- [`electron/main/services/planner/Planner.ts`](../electron/main/services/planner/Planner.ts) — pure dependency and plan resolution
- [`electron/main/services/planner/PlannerService.ts`](../electron/main/services/planner/PlannerService.ts) — adds installed state, architecture, disk and WinGet facts
- [`electron/main/services/install/InstallationQueue.ts`](../electron/main/services/install/InstallationQueue.ts) — serialized queue and cancellation
- [`electron/main/services/install/InstallationEngine.ts`](../electron/main/services/install/InstallationEngine.ts) — install, uninstall, repair and version switching
- [`electron/main/services/download/DownloadManager.ts`](../electron/main/services/download/DownloadManager.ts) — HTTPS download and checksum verification
- [`electron/main/services/detection/SoftwareDetector.ts`](../electron/main/services/detection/SoftwareDetector.ts) — detection and verification

## Lifecycle at a glance

```
request
  → planner.preview()          dependency resolution, version choice, compatibility
  → plan dialog                user reviews steps, admin/restart/size warnings
  → queue.enqueue()            one queue item per installable step
  → queue.start()              serialized execution
  → engine.install(step)
       checking
       resolving
       downloading            (archive / official installer only)
       verifying-download     (archive / official installer only)
       installing
       configuring
       verifying
       completed
  → installation record, activity, notification, history and logs
```

The queue reports each stage transition as it actually happens. WinGet packages explicitly mark `downloading` and `verifying-download` as **skipped** because WinGet performs both operations itself. Automatic verification can also be skipped when the user disables it in Settings, and the stage says so.

## Supported installation methods

| Method | Used for | Behavior |
| --- | --- | --- |
| `winget` | Python, Node.js, Java JDK, Git, Go (future), databases, Docker Desktop and other vendor packages | Runs `winget install --id <id> --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity --silent`. WinGet resolves, downloads, verifies signatures and runs the vendor installer. |
| `archive` | Maven, MinGW-w64, Go | Downloads a ZIP over HTTPS, verifies the checksum, extracts into a staging folder, validates expected executables and atomically moves the result into the tools directory. |
| `official-installer` | Rust (rustup-init) | Downloads the vendor executable, verifies its checksum, then runs it with the exact argument list declared in the registry. |
| `project-recipe` | Django, Flask, React + Vite, Spring Boot | Does not install globally. The UI shows copyable setup commands to run inside the user's project. |

The method is chosen per package by the registry. Users can set a default preference, but the engine always follows what the package definition declares so that unsupported combinations are rejected instead of guessed.

## Planning

`buildInstallationPlan` is a pure function. It receives the requested packages, the registry map, installed records, CPU architecture, free disk space and WinGet availability.

1. **Duplicate requests** are rejected with a clear error.
2. **Dependencies** are resolved recursively. Required dependencies are always included; missing optional packages produce a warning. Version minimums are recorded from `minVersion`.
3. **Cycles** are detected through a visiting stack and reported with the full chain (`a → b → a`).
4. **Versions** are selected in this order: exact requested version, highest version satisfying a dependency minimum, package default version (the one marked `isDefault`, otherwise the first).
5. **Installed state** turns an identical version into `skip`. If the package declares environment changes and the installation's `envStatus` is not `configured`, the step becomes `configure` instead: only the missing environment configuration runs, the files are not downloaded or replaced. An older version becomes `upgrade`.
6. **Compatibility** checks the declared architecture and Windows versions. Unsupported packages are marked `unsupported` with a reason.
7. **Project recipes** become `project-recipe` steps instead of install steps.
8. **Aggregates** collect whether administrator rights, a restart and downloads are required, plus the estimated size.
9. **Disk space** produces a warning below 1 GB and an error below the estimated need plus a safety margin.
10. **WinGet availability** produces a warning when a WinGet package is selected on a machine without WinGet.

Steps are topologically ordered so dependencies appear before dependents. `PlannerService` supplies the OS facts; the pure function is covered by unit tests.

## Downloads

`DownloadManager` enforces the following rules:

- Only `https:` URLs are accepted. Redirects must also remain on HTTPS.
- A 64–128 character hexadecimal SHA-256/SHA-512 checksum is mandatory before any network request.
- Data streams into `<file>.part` while hashing; progress is reported at most every 120 ms.
- A checksum mismatch deletes the partial file and raises `CHECKSUM_MISMATCH`.
- A successful file is renamed from `.part` to its final name and recorded in `download_cache` as `verified`.
- A cached file is reused only after its checksum is verified again. Invalid cache entries are removed and re-downloaded.
- Cancellation removes the partial file.
- When a proxy is configured, requests use the declared proxy and bypass list; the same settings reach child installer processes.
- The size from the registry is only a progress hint; a mismatch is logged, not treated as a fatal error, because checksums are authoritative.

The download cache lives in the configured downloads directory (`<Downloads>/DevForge` by default). It can be cleared from Settings → Maintenance.

## WinGet path

1. `checking` reports whether this is a fresh install or an upgrade.
2. `resolving` reports dependency resolution.
3. Downloading and verification stages are marked skipped with the reason.
4. `installing` runs WinGet with argument arrays and a 30-minute timeout. A `--version` argument is added for curated WinGet definitions; packages prepared through software discovery omit it so WinGet always installs from its current manifest instead of a stale discovered version.
5. Exit codes are mapped:
   - `0` — success (or “already installed” detected from output),
   - `3010` — success, restart required,
   - `1223` — elevation was cancelled,
   - other known codes — actionable message,
   - unknown codes — a failure that includes the exit code.
6. The install directory, detected version and environment state are discovered from real detection afterwards.

Dynamic WinGet packages prepared from discovery use the same code path. They have no environment or executable expectations of their own; WinGet or the vendor installer owns those, and verification checks WinGet's package registration.

WinGet does not accept a custom installation directory through DevForge. The plan dialog shows the tools-directory setting for information only; WinGet packages install where the vendor installer decides.

## Archive path

1. Resolve the target directory from `installDirectoryTemplate` (or `{toolsDir}/<name>/<version>` when absent).
2. Inspect the folder **before downloading**. A `.devforge-package.json` marker records the owning package, version, method and install time. `expectedExecutables` decides whether the tree is complete.
3. Classify the existing folder:
   - **Complete and owned by this package (or unmarked but complete):** validate it, reuse it, skip download and install stages, and report `already-installed`.
   - **Complete but marked by another DevForge package:** fail with `DIRECTORY_CONFLICT`; never overwrite, even with recovery enabled.
   - **Incomplete and unowned:** fail with `DIRECTORY_CONFLICT`; files DevForge did not create are never deleted.
   - **Incomplete and DevForge-owned** (matching marker or a recorded install directory): fail with `DIRECTORY_CONFLICT` and explain that folder recovery is available. Only when the user retries with `recoverDirectory` is the folder renamed to `<path>.devforge-backup-<time>` and kept on disk.
   - **Same package, different version with complete files:** replace the DevForge-owned tree, quarantining the old folder rather than deleting it.
   - **Empty folder:** install into it without deleting anything.
4. Download and checksum verification as above.
5. Extract into `{toolsDir}/.staging/<transactionId>` and optionally strip a single root folder.
6. Validate every path in `expectedExecutables` **in staging**. A vendor layout change fails before the live directory is touched.
7. Move the staging directory into place. A copy-and-delete fallback handles cross-volume renames. Write the DevForge marker.

Archives are currently ZIP only. Extraction uses `ZipExtractor` (`yauzl` with entry-size validation): entry names are normalized and confined to the staging root, and absolute paths, drive letters, traversal, alternate data streams, reserved device names, symlinks, encrypted entries and duplicate targets are rejected. The checksum is authoritative for integrity, but it does not establish publisher identity beyond the registry entry that contains it. Quarantined folders are never cleaned up automatically; they are reported in the installation result so the user can inspect or remove them.

## Official installer path

The executable is downloaded and verified exactly like an archive, then run with the registry-defined `installArgs` array. Arguments are never concatenated into a shell string. If the installer requests a restart (`3010`), the result is reported as `requires-restart`, not silently completed.

Official installer definitions may also declare `download.signature`:

```json
"signature": {
  "publisher": "Rust Foundation",
  "thumbprint": "0123456789ABCDEF0123456789ABCDEF01234567"
}
```

After the checksum passes, DevForge reads the installer's Authenticode signature with `Get-AuthenticodeSignature`. It requires a valid status, a subject containing the expected publisher and, when present, an exactly matching thumbprint. Any mismatch fails with `VERIFICATION_FAILED` before the executable runs. This metadata is optional and only applies to official installers.

## Environment configuration

After a successful install the engine:

1. Invalidates detection and environment caches.
2. Detects the real installation directory and version.
3. Creates or updates the installation record with `verificationStatus` set to `pending` (or `unknown` when auto-verification is off).
4. Resolves each `environment` entry with `{installDir}`, `{toolsDir}`, `{version}` and `{packageName}`.
5. Applies PATH additions as **additive** mutations, never by replacing the whole variable.
6. Applies variables with protection rules: `PATH` itself cannot be overwritten as a normal variable and core Windows variables are protected.
7. Creates a backup row per actual write, then verifies the effective value by re-reading the environment.

Configuration is idempotent. `preview()` compares every requested PATH entry and variable with the current snapshot before anything is written:

| Situation | Preview outcome | Apply behavior |
| --- | --- | --- |
| Every PATH entry already present and every variable already equal | `already-satisfied`, no changes | No registry writes, no backups; reported as success |
| Some PATH entries or variables missing or different | `pending` with per-change before/after | Writes only the missing pieces, backs each up |
| All entries present but a directory does not exist or PATH contains unrelated duplicates | `already-satisfied` with warnings | No PATH rewrite; warnings explain what DevForge left untouched |
| Windows rejects a write after earlier writes succeeded | — | `ENVIRONMENT_PARTIALLY_APPLIED` with the applied count; earlier changes remain backed up and the package stays `not-configured` |
| Windows rejects the first write, or system scope without elevation | `errors` populated | `ENVIRONMENT_FAILED`; nothing is claimed as applied |

Zero changes is therefore a **successful** result, not a failure. This is what allows a retry after a partial or interrupted configuration to finish cleanly without reinstalling the package.

If environment configuration fails, the package stays installed but is marked `not-configured`. The transaction reports “installed, but DevForge could not update its environment variables” with a route to Repair Configuration. It does not claim the installation failed. The operation summary distinguishes installation (`installed`, `already-installed`, `configured-only`), configuration (`applied`, `already-configured`, `not-required`, `failed`) and verification (`passed`, `failed`, `skipped`, `not-run`).

## Verification

Packages may define command, file, service and WinGet checks. Each check supports expectations and optional status. Verification runs after installation when `autoVerify` is enabled, and can be repeated from Installed Software or the Version Manager.

A failed required check marks the installation `failed` and the transaction stage `failed` with the failing check output. The software may still be present; the message says so rather than pretending it was never installed.

Verification commands run with a merged environment built from the process, system and user scopes so that a tool added milliseconds earlier can be found without restarting DevForge. On Windows, bare command names are resolved through `PATH` and `PATHEXT`, so package-manager shims such as `npm.cmd` and `yarn.cmd` are executed through `cmd.exe` with validated, quoted arguments rather than failing as "not found".

## Queue behavior

- The live queue is in-memory, with pending items mirrored to `<userData>/queue-state.json` and history/logs persisted in SQLite. Only not-yet-finished requests are stored; plans are rebuilt on restore.
- Installation is serialized: one package at a time. This is deliberate, because installers, PATH and the tools directory are shared resources.
- `start`, `pause`, `resume`, `cancel`, `retry`, `remove`, `move` and `clearCompleted` are real operations. Only pending items can be reordered.
- Pause stops before the next package starts; it cannot suspend an installer already running.
- Cancel aborts a download immediately. For a running installer it terminates the child process where possible, but WinGet or a vendor installer may continue in the background. The UI states this limitation.
- Retry creates a new attempt with a new transaction id; previous attempts remain in history.
- A restart request never blocks the rest of the queue permanently; the item completes as `requires-restart` and the UI surfaces the restart notice.
- Restore on startup re-enqueues saved requests through normal validation. An interrupted attempt is still marked as interrupted in history; it is not silently treated as completed.

## Uninstall

Uninstall behavior is driven by the registry:

- `winget` — runs `winget uninstall` for the recorded or package-level WinGet id.
- `command` — runs the declared executable and argument array.
- `directory` — supported when the definition chooses it, with the same safety checks as below.

After the vendor uninstaller:

1. DevForge reverts only the environment changes it recorded for that package. Unrelated PATH entries are preserved, and newer conflicting values are left untouched with a warning.
2. Optional directory removal is restricted to the tools directory. Database packages never have their data directory deleted.
3. The installation is marked `removed`; the record and history remain.
4. If environment cleanup fails, the uninstall still reports the vendor removal truthfully and includes the cleanup error.

## Repair and version switching

- **Repair Configuration** re-resolves and re-applies the package's environment entries for the active installation. It does not reinstall files.
- **Version switching** is available only when a package sets `supportsVersionSwitching`. The target version must already be installed. DevForge reverts the package's recorded environment changes, applies the target version's environment, marks that version active and tells the user to open a new terminal.

## Update checks

`checkUpdates()` compares the highest known installed version — the recorded install version or a fresh detection, whichever is greater — with the highest registry version. This prevents a stale PATH probe from making a just-updated installation look out of date, while still surfacing genuinely newer releases. When `checkUpstreamUpdates` is enabled, packages that declare a canonical version source are also checked against the vendor's release feed through `ReleaseResolver`, and results include which source reported the version. Results are cached in `update_cache` and surfaced on the dashboard and Installed Software.

An upstream version that has no matching registry version is reported as informational only. DevForge will not construct an install procedure for it, because downloads must be declared with an HTTPS URL and checksum in validated package data before they can run. Registry-backed updates continue through the normal plan, queue and verification path.

## Error model

All failures use `AppError` codes with a friendly message, an optional hint and optional details. The renderer displays the friendly message and can show details. Notable codes:

| Code | Meaning |
| --- | --- |
| `VALIDATION` | Invalid input, version or registry data |
| `NOT_FOUND` | Package, installation or backup missing |
| `UNSUPPORTED` | Method not supported (e.g. recipe, switching disabled) |
| `DIRECTORY_CONFLICT` | Target exists with files, is owned by another package, or is an incomplete DevForge install requiring recovery confirmation |
| `DOWNLOAD_FAILED` | Network or HTTP failure |
| `CHECKSUM_MISMATCH` | Integrity verification failed; file deleted |
| `INSTALLER_FAILED` | Vendor installer or extraction failed |
| `INSTALLER_RESTART` | Installer completed and requires a reboot |
| `ENVIRONMENT_FAILED` | Environment update failed before anything was applied |
| `ENVIRONMENT_PARTIALLY_APPLIED` | Some environment changes were written, then Windows rejected a later write; applied changes are backed up individually |
| `ADMIN_REQUIRED` | System-scope change without elevation |
| `VERIFICATION_FAILED` | Required verification check failed |
| `CANCELLED` | User cancellation |
| `PERMISSION_DENIED` | Path outside DevForge-managed folders |

## History and logs

Every attempt creates an `installation_transactions` row and stage-scoped `installation_logs` entries. Commands, arguments, exit codes and truncated stdout/stderr (last 12,000 characters per stream) are stored. Logs are local and can be exported from Settings → Maintenance → Export diagnostics.

## Honest limitations

- WinGet and third-party installers can show their own UI or run to completion after DevForge cancels, depending on how the installer handles termination.
- Some vendor installers require interactive input (for example a database superuser password). DevForge never invents credentials, so such installs fail with the installer's output.
- Archive installation assumes a ZIP layout. Other archive formats are rejected by the registry schema.
- Recovery moves incomplete or replaced folders aside instead of deleting them. DevForge does not automatically clean up `.devforge-backup-*` folders, because they may contain files the user wants to inspect.
- Discovery-added WinGet packages depend on the vendor manifest for install location, environment and verification. DevForge can detect and re-configure what the vendor exposes, but cannot invent missing metadata.
- Verification depends on a new process resolving the updated environment; some tools still require a new terminal or a logoff.
- Downloads are verified against checksums from the local registry. Authenticode pinning is available for official installers when the registry declares it, but WinGet installs rely on WinGet's own signature checks. Treat the registry as trusted application data.
- The queue mirrors pending requests across a normal restart, but an abrupt crash can lose the very last state write. Interrupted transactions are marked as such on the next start rather than reported as successful.
