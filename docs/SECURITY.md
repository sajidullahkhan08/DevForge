# Security

DevForge executes installers and edits Windows environment variables, so its security model is deliberately conservative. The renderer has no direct operating-system access, the main process only runs operations declared in local registry data, and every destructive action is explicit and reversible where possible.

## Threat model

DevForge assumes:

- The user is an administrator of their own computer.
- The local package registry and application files are trusted application content, updated only by installing a new DevForge build.
- WinGet, vendor release feeds and the public GitHub API are external, unauthenticated metadata sources. DevForge treats every response as untrusted and validates what it uses before a result can become an installable package.
- Vendor download servers are reachable over HTTPS; checksums bind downloads to the definitions shipped with the app. Official archive candidates are accepted only after their published SHA-256 matches.
- The renderer is untrusted in the sense that any future XSS or malicious content must not be able to spawn processes or read arbitrary files.

It does **not** defend against a compromised Windows account, a compromised vendor installer, or a user who intentionally edits registry files to run untrusted commands.

## Electron hardening

Configured in [`electron/main/window.ts`](../electron/main/window.ts) and [`electron.vite.config.ts`](../electron.vite.config.ts):

| Control | Setting |
| --- | --- |
| Context isolation | `contextIsolation: true` |
| Node integration in renderer | `nodeIntegration: false` |
| Chromium sandbox | `sandbox: true` |
| Web security | `webSecurity: true`, `allowRunningInsecureContent: false` |
| Preload exposure | One frozen `window.devforge` API through `contextBridge`; no Node primitives |
| New windows | Denied; HTTPS links open in the default browser via `shell.openExternal` |
| In-app navigation | Blocked unless it is the current URL |
| Webviews | `will-attach-webview` prevented |
| Permissions | All permission requests denied |
| Menu | Removed |
| Single instance | Lock prevents a second uncontrolled instance |
| CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'` |

The CSP allows inline styles because the UI uses CSS variables and a few component style attributes. It allows no remote scripts, no remote frames and no renderer network connections.

Production loads a local `file://` bundle; development loads the Vite dev server. There is no remote content in either mode.

## IPC boundary

- Every request uses a named channel from [`shared/ipc.ts`](../shared/ipc.ts).
- `assertTrustedSender` accepts only the current main window's `webContents.id`.
- Payloads are validated with zod before reaching a service: package ids, versions, ids, scopes, mutation unions (including PATH de-duplication), queue directions, imported package definitions, profile/manifest input, settings patch, history limits and URL types.
- The custom package import handler reads at most 512 KB from a path chosen through the native open dialog, parses JSON in the main process, and re-runs the full schema plus semantic validation before registration. The renderer never supplies a file path or a definition object.
- The preload exposes only fixed wrappers. It cannot be used to call arbitrary channel names or pass functions to main.
- Errors thrown in main are converted to a sanitized `CODE: message` string for IPC. Stack traces are not returned to the renderer.
- Event subscriptions are one-way (`main → renderer`) on dedicated channels.

There is no `execute-command` channel. Renderer code cannot ask the main process to run an arbitrary program with arbitrary arguments.

## Registry as data

Package definitions cannot contain scripts. The engine understands only:

- WinGet ids and argument arrays,
- HTTPS URLs with checksums,
- official installer argument arrays,
- ZIP extraction,
- environment templates,
- verification/detection commands and arguments,
- uninstall commands and arguments.

A malformed or malicious JSON file can at worst define a bad install command that the user sees in the plan and can cancel. It cannot inject arbitrary code into DevForge itself. Files that fail validation are skipped and reported.

Runtime discovery definitions are treated the same way. `DiscoveryService` builds WinGet candidates from parsed WinGet output and official-archive candidates from vendor feeds, re-validates them with the same schema and semantic rules, and binds each result to a canonical identity from the shipped identity registry. The renderer can only submit a short-lived result id — never a definition or an arbitrary URL.

Locally imported package files are re-validated with the same schema and semantic checks as shipped definitions, cannot replace an existing package id, and are stored as discovery metadata. Importing a file never executes it. The resulting package still has to pass plan review, and only the declared installation method (validated WinGet manifest or checksum-verified HTTPS archive/installer) can run.

## Process execution

[`ProcessExecutor`](../electron/main/services/process/ProcessExecutor.ts):

- uses `spawn` with **argument arrays**, never a concatenated shell string;
- disables the shell for normal executables;
- sets `windowsHide: true`;
- enforces timeouts, output caps and abort signals;
- kills the process tree on cancellation/timeout where possible;
- quotes `.cmd`/`.bat` shims for `cmd.exe` and rejects arguments containing `"`, newlines, `&`, `|`, `<`, `>`, `^` or `%`, preventing shell-operator injection from registry data;
- never passes user-entered free text to command execution.

PowerShell operations use fixed scripts, `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`. Payload values are passed as base64 JSON through an environment variable, not interpolated into script text.

## Download and supply-chain controls

[`DownloadManager`](../electron/main/services/download/DownloadManager.ts):

- rejects anything except `https:`;
- rejects HTTPS redirects that land on a non-HTTPS URL;
- requires a 64–128 hex SHA-256/SHA-512 checksum before downloading;
- hashes while streaming and refuses to keep or execute a mismatched file;
- writes to `.part` and moves into place only after verification;
- re-verifies cached downloads before reuse;
- deletes partial downloads on cancellation or failure;
- can route requests through a configured HTTP/HTTPS proxy without exposing proxy credentials to the renderer.

[`ZipExtractor`](../electron/main/services/install/ZipExtractor.ts) does not trust archive entry names. It uses `yauzl` with entry-size validation and rejects:

- absolute paths, drive letters and `..` traversal,
- backslash-normalized paths, NTFS alternate-data-stream colons and reserved Windows device names,
- symbolic links and other special file types,
- encrypted entries and unsupported compression methods,
- duplicate targets (`wx` create mode), entry counts above 200,000 and more than 32 GiB of declared uncompressed data.

Every resolved path is checked against the staging root, so a malformed archive cannot write outside the DevForge staging folder.

Official installers support optional Authenticode pinning through the registry (`download.signature.publisher`, optional 40–64 hex `thumbprint`). After the checksum matches, DevForge queries `Get-AuthenticodeSignature` and refuses to execute the installer unless the status is valid, the subject contains the expected publisher and the thumbprint matches when specified. This is opt-in metadata: archive packages and WinGet installs rely on checksums and WinGet's own validation.

WinGet packages rely on WinGet and the vendor's installer for signature validation. DevForge does not perform an additional signature check for WinGet-managed installs.

## Software discovery and version resolution

Discovery is one identity-aware pipeline, deliberately split between identity, metadata, compatibility and installation:

- **Network calls are made by the main process only.** WinGet uses the local `winget` client. Version resolution uses fixed vendor endpoints (nodejs.org, python.org, go.dev, windows.php.net, Google storage for Flutter/Dart) or GitHub Releases for an identity's declared official repository, with `https://api.github.com`, a fixed user agent, `Accept: application/vnd.github+json`, bounded timeouts and no credentials. The renderer's CSP forbids direct network access.
- **Identity first.** A query is normalised and matched against the shipped identity registry. Exact names, executables and strong aliases rank first; controlled fuzzy matches appear only as related results. Text that matches no identity still shows validated WinGet rows, but never a fabricated identity or version.
- **GitHub is a version source, not an install source.** Repositories are not searched as install candidates. GitHub Releases are queried only for identities whose registry entry declares an official repository and a `github` version strategy.
- **Only validated candidates are installable.** A result is installable only when it is an existing curated package, a `winget show` manifest with a safe version and HTTPS homepage, or an official archive built from an identity's declared release source whose published SHA-256 was parsed successfully. WinGet rows without a validated manifest, failed archive checks and metadata-only entries never expose an Install action.
- **Versions have provenance.** A version is shown as latest/stable only when a version-resolution provider returned it. The UI distinguishes stable, LTS and preview channels, shows the source and retrieval time, and marks cached results as stale when refresh fails. Search-result text is never interpreted as a version.
- **Prepare is not an injection point.** `discovery:prepare` accepts only an id from the service's bounded, expiring result index. The associated candidate is re-validated by zod and semantic checks before registration. Metadata-only and expired results are rejected.
- **No automatic installs.** Preparing a result opens the normal plan dialog. The user confirms every installation, sees the same warnings and can cancel.
- **Bounded resources.** Search queries are 2–80 characters, results are capped, provider and release responses are size-limited, caches are pruned, and per-provider timeouts prevent one slow source from hanging the UI. Provider failures degrade to a report instead of fabricating data.
- **Persistence is metadata only.** `discovered-packages.json` (version 2) contains package metadata, refresh timestamps and cached version resolutions. It contains no secrets, installers or downloaded artifacts.
- **Refresh is conservative.** If WinGet or a release feed is unavailable, refresh is skipped and the existing definition or cached resolution is preserved. A failed manifest or release parse never replaces a working package definition with fabricated data.

## Privilege model

- The application manifest requests `asInvoker`; DevForge does **not** run the whole UI elevated.
- User-scope installs and environment changes run as the current user.
- System-scope changes are previewed with `requiresAdmin`. If DevForge is not elevated, the operation fails with `ADMIN_REQUIRED` instead of silently writing or claiming success.
- The NSIS installer is per-user by default and may request elevation only if the user chooses a machine-wide location.
- WinGet may itself show a UAC prompt; cancellation is reported as a failure.
- There is no auto-elevation via scheduled tasks or a privileged helper. The user must restart DevForge as administrator for system environment changes.

## Environment safety

[`EnvironmentManager`](../electron/main/services/environment/EnvironmentManager.ts) protects Windows:

- PATH is never replaced wholesale. A package can only add or remove specific entries.
- Entries are normalized (case, separators, trailing slashes, `%VAR%` expansion) for duplicate detection but written in their original useful form.
- Protected variables such as `SystemRoot`, `windir`, `TEMP`, `USERPROFILE`, `ProgramFiles` and `ComSpec` cannot be edited.
- Every write is backed up with the previous value and the specific entries added/removed.
- Restore refuses to overwrite newer values. If another program changed the variable after DevForge, the restore is skipped with a warning.
- Uninstall reverses only that package's recorded changes. It does not restore an entire old PATH snapshot over newer changes.
- A change is re-read after writing to confirm the effective value; discrepancies are reported as warnings.
- Preview is idempotent: already-correct entries and variables count as satisfied, so retrying a failed configuration cannot duplicate PATH entries.
- A PATH duplicate cleanup (`dedupe-path`) keeps the first occurrence and removes only later normalized duplicates; it never removes the last occurrence of an entry and is previewed and backed up like any other change.
- The environment doctor only produces findings and targeted mutations for duplicates, missing managed folders and stale well-known variables. Findings are recomputed against the actual value at apply time; the doctor never applies a value captured earlier.
- If Windows rejects a write after earlier writes succeeded, the error is `ENVIRONMENT_PARTIALLY_APPLIED` with the exact count. Applied changes remain backed up individually; the operation is never reported as fully successful.
- System-scope writes require elevation and are checked before writing.
- Input values reject NUL and CR/LF characters and enforce the Windows 32,767-character limit.

## Local data

- SQLite lives at `<userData>/devforge.db`, inside the user's profile, protected by normal Windows file permissions.
- It stores package metadata, installation records, logs, settings, activity and environment backups.
- Packages added through discovery are stored in `<userData>/discovered-packages.json` as versioned metadata, together with cached version resolutions and their retrieval times. The file is written atomically and a malformed file is ignored rather than deleted.
- Pending queue items are mirrored to `<userData>/queue-state.json`. The file contains only package ids, versions and the auto-start flag; it is size-limited, schema-checked and re-enqueued through normal validation. It never contains commands, plans or artifacts.
- Project pinning writes `.devforge/environment.json`, `activate.ps1` and `deactivate.ps1` inside a user-chosen project folder. The scripts contain local paths and variable values, are generated from validated registry templates, and are never executed automatically by DevForge.
- The canonical identity registry (`packages/identities.json`) ships as read-only application content and cannot be modified from the renderer.
- DevForge **does not** ask for or store database passwords, API tokens, GitHub credentials or other secrets. Database packages explicitly state that credential setup is the user's responsibility.
- Command output is stored in transaction logs and may contain paths, versions and vendor messages. Review logs before sharing a diagnostics export.
- Diagnostics export includes app/system information, settings, registry issues and recent logs. It is written to the DevForge logs directory and opened locally; it is not uploaded anywhere.
- There is no telemetry, analytics, cloud sync or remote registry.

## File-system boundaries

`AppContext.assertAllowedPath` restricts `openPath` and `showInFolder` to:

- the configured tools directory,
- DevForge `userData`,
- the configured downloads directory,
- the DevForge logs directory.

Paths are resolved and compared case-insensitively with a directory-boundary check, so `C:\DevForge\Tools-evil` is not treated as inside `C:\DevForge\Tools`.

Uninstall directory removal has an additional check: the target must be inside the tools directory, must not be the tools directory itself, and databases never have their data directory deleted.

## Network exposure

- The renderer cannot make arbitrary network requests; CSP `connect-src 'self'`.
- The main process makes HTTPS requests to URLs declared in the registry or identity registry, to the local WinGet client (which uses its own network stack), and to fixed vendor release endpoints used for version resolution: `nodejs.org`, `www.python.org`, `go.dev`, `windows.php.net`, `storage.googleapis.com` (Flutter/Dart) and `api.github.com` for declared repositories. No other remote host is contacted, and the renderer cannot choose a host.
- Discovery sends only the user's search text to WinGet. Version resolution sends the identity's declared repository or release endpoint, never user text. It does not send machine identifiers, installed-package lists or credentials.
- An optional proxy URL is validated to `http://` or `https://` and stored locally. It is passed to the main-process HTTP client and to child installer environments; it is never exposed to the renderer. A bypass list controls direct connections.
- External links are HTTPS-only; `http:`, `file:` and custom protocols are rejected.
- No listening socket or local server is started by the application.

## Supply-chain and release controls

- Production dependencies are audited in CI with `npm audit --omit=dev --audit-level=high`; the job fails on high-severity findings. The full development tree currently has moderate `minimatch` advisories inside electron-builder; those packages are build-time only, and npm has no non-breaking fix, so they are tracked rather than force-downgraded.
- `npm run sbom` emits a CycloneDX 1.5 bill of materials from `package-lock.json` into `dist/sbom.cdx.json`; CI uploads it as an artifact.
- The release workflow builds on Windows for `v*` tags and uploads the installer and unpacked artifacts to a GitHub release.
- Code signing is supported through electron-builder's `CSC_LINK`/`CSC_KEY_PASSWORD` secrets. No certificate is stored in the repository, so builds without those secrets are unsigned.

## Known limitations and residual risk

- **Unsigned build.** The installer is not code-signed in this repository. Windows SmartScreen may warn. The release workflow can sign when certificate secrets are supplied; sign releases with an EV/OV certificate before public distribution.
- **No live auto-update feed.** DevForge does not ship electron-updater or a signed update feed. Users update by installing a newer setup over the existing version. A tampered download is only distinguishable through the release channel and TLS, not through an in-app signature check.
- **Checksum trust.** Integrity depends on the checksums in the shipped registry. A compromised build or registry file is not detectable at runtime. Authenticode pinning is only as strong as the publisher/thumbprint values in the registry, and is optional.
- **External metadata.** WinGet rows, vendor release feeds and GitHub Releases are untrusted input. DevForge validates the fields it uses and never treats result text as a version, but a compromised WinGet source or release feed can still publish misleading names, descriptions or versions. Installing from WinGet relies on WinGet's own signature and manifest checks; official archives rely on the SHA-256 published by the vendor feed.
- **Proxy trust.** A proxy is an explicit trust decision by the user. Stored proxy settings are not encrypted, and a malicious proxy can observe or modify unauthenticated traffic unless the endpoint uses TLS. WinGet may not honour the DevForge proxy at all.
- **Local imported definitions.** Imported package JSON is validated but is still local user-supplied metadata. Review the source URL, checksum and plan before installing, and note that a valid checksum only proves the file matches whatever checksum the definition declares.
- **No generic web search.** DevForge does not query a general web search engine. Software outside both the curated catalogue and WinGet is not discoverable, which is intentional: it prevents unverifiable pages from being presented as installation sources.
- **Anonymous rate limits.** GitHub Releases is queried without credentials, so rate limiting or an outage can delay version refresh. Cached resolutions remain visible and are marked stale rather than replaced with guessed data.
- **Vendor installers.** Their own security posture, UAC prompts, telemetry and background behavior are outside DevForge's control.
- **Cancellation.** Child installers may ignore termination and continue; this is stated in the UI.
- **No sandbox for vendor installers.** WinGet and official installers run with the current user's privileges, possibly elevated by UAC.
- **Single-user assumption.** The database and logs are not encrypted. Use Windows disk encryption and account separation for shared machines.
- **Development mode.** The Vite dev server is not hardened for production use; do not expose it on a network interface.

## Reporting a vulnerability

Do not open a public issue with exploit details. Provide the affected version, reproduction steps and impact to the maintainer privately, then allow time for a fix before disclosure.
