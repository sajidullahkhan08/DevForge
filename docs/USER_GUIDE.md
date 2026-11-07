# User Guide

DevForge installs and manages Windows development tools from a single desktop app: languages, runtimes, frameworks, databases, compilers, build tools and developer utilities. Every install is real, every progress stage reflects what is actually happening, and changes to environment variables are backed up.

## Requirements

- Windows 10 or Windows 11, x64.
- Administrator rights for system-scope packages and system environment variables. The app itself runs unelevated.
- WinGet (App Installer) for packages that install through WinGet. DevForge detects it and warns when it is missing.
- An internet connection for downloads and WinGet installs.
- Enough free disk space. The plan warns below 1 GB and blocks when the estimated size plus a safety margin cannot fit.

## Install DevForge

1. Run `DevForge-Setup-1.0.0.exe`.
2. The installer is per-user by default. You may choose a different folder and may allow elevation for a machine-wide location.
3. Windows SmartScreen may warn because the build is not code-signed. Verify you obtained the installer from a trusted source before continuing.
4. Launch DevForge from the Start menu or desktop shortcut.

To update DevForge later, install a newer setup over the existing version. DevForge does not yet ship a live auto-update feed; check the project releases and run the newer installer. Your database and history remain in your user profile.

## Navigation and command palette

Use the sidebar or press **Ctrl+K** (Cmd+K) anywhere in the app to open the command palette. It searches pages, common actions and catalogue packages, and supports arrow keys plus Enter. The main content has a skip link and focus target for keyboard and screen-reader navigation. The sidebar already collapses for narrow windows and the collapsed state is remembered.

## First launch

DevForge creates its local database and reads the built-in catalogue. On startup it detects software that is already installed, records the results, and fills the dashboard. Nothing is installed automatically.

- Default tools directory: `C:\DevForge\Tools`
- Default downloads directory: your Windows Downloads folder under `DevForge`
- Local database, logs and settings: `%APPDATA%\DevForge` (Electron user data)

If the first screen shows no packages, open Settings → About this system and check registry issues. A startup database error is shown in a dialog instead of a broken window.

## Dashboard

The dashboard is built from real state:

- installed package and version counts,
- pending queue items and active transactions,
- environment health checks (WinGet availability, PATH duplicates, managed PATH entries, stale `JAVA_HOME`/`MAVEN_HOME`/`GOROOT`),
- available updates based on the local registry,
- recent activity and catalogue coverage by category.

It refreshes when the queue runs, when installations change and when activity events arrive. There are no hardcoded statistics.

## Discover Software

Browse the catalogue, search by name/tag/publisher and filter by category or installation method.

- **Cards** show publisher, category and the default version.
- **Details** show the long description, versions, dependencies, environment changes, verification checks, caveats and setup notes. The Technical details tab also shows the canonical product identity, the authoritative upstream version source and the commands the package provides.
- **Version selection** lets you pin a specific version before planning.
- **Install** opens the plan dialog. Nothing runs until you confirm.
- **Project recipes** (Django, Flask, React + Vite, Spring Boot) show copyable commands instead of an install button. They are meant to be run in your own project folder.

### Unified search

There is one search box for the whole application. It searches the DevForge catalogue, validated WinGet manifests and authoritative vendor release feeds at the same time — by product name, official name, command or package id. For example: `Kotlin`, `kotlinc`, `Flutter`, `Dart`, `PHP`, `Composer`, `Ruby`, `GCC`, `MinGW`, `LLVM`, `Clang`, `Python`, `Rust`, `Node.js`, `MongoDB` or `CMake`.

- **One result per product.** If your search matches a curated package, a WinGet manifest and an official release feed, you see a single card with the best available installation path — not three duplicates.
- **Canonical identity.** DevForge recognises aliases and command names (for example `kotlinc` for Kotlin, `gcc` for MinGW-w64, `clang` for LLVM) and labels how the result matched. Weakly similar names appear under **Related software**, never as the identified product.
- **Authoritative versions.** A green “Latest stable”/“LTS” badge comes only from the product's declared vendor feed. A “Manifest” badge is the version defined by the DevForge or WinGet package and is not a claim about the newest upstream release. Preview versions are shown but are not installable.
- **Verified vs metadata-only.** A green **Verified** badge means DevForge has a validated installation procedure. **Metadata only** results have no Install button; use **Details** to see the official source and open it in your browser. GitHub is used only to read release versions for an identity's declared official repository, never as an installation source.
- **Filters** narrow results by category and by status (available, installed, updates). Local catalogue matches appear instantly while the external sources finish.
- **Prepare and install** registers a verified result in the catalogue and opens the normal plan dialog. The package definition is re-validated on the main process; nothing is taken on trust from the renderer.
- **Refresh metadata** rebuilds discovered WinGet and official archive packages older than 12 hours. A WinGet outage skips WinGet metadata instead of removing packages, and a failed release check keeps the existing package.
- **Import package** opens a JSON package definition from disk. It goes through the same zod and semantic validation as shipped definitions, existing ids are rejected, and the imported package is stored with discovery metadata. Review its plan and sources before installing; importing a file never executes anything.
- If a source is unavailable (WinGet missing or a release feed rate-limited), the other results still appear and a provider badge explains what failed. Cached version data is marked as cached and older data is marked stale rather than guessed.

### The plan dialog

Before anything runs, the planner shows:

- each step (install, upgrade, configure, skip, recipe, unsupported),
- why a dependency was added,
- the selected version,
- warnings about administrator rights, Windows restart, disk space, missing WinGet, optional dependencies and unsupported architecture,
- estimated download/install size.

Choose **Add to queue** or **Install now**. A plan with errors cannot be queued.

## Development Environments

Profiles are curated bundles. Built-in examples include Python Development, JavaScript, MERN, Java, C++, Databases and Web Development.

- Install a profile to send all required packages through the plan and queue.
- Optional components are not treated as failures when missing.
- Create your own profile, edit one, duplicate it or delete custom profiles. Built-in profiles can be duplicated and adjusted.
- Profile components must reference real registry packages; invalid profiles are rejected.
- **Export** writes a portable environment manifest (JSON) containing the profile name, audience and exact pinned versions. Use it to reproduce the same setup on another machine or check it into a team repository.
- **Import** reads a DevForge environment manifest. The manifest is validated, unknown packages are skipped with warnings, duplicate components keep their first entry and an existing profile name is never overwritten. Importing creates a profile only; nothing is installed until you review a normal plan.

## Installation Queue

The queue runs **one package at a time** because installers, PATH and the tools directory are shared resources.

- Stages: checking, resolving, downloading, verifying download, installing, configuring, verifying, completed.
- Progress and stage details come from the engine. WinGet packages mark download/verify stages as skipped because WinGet performs them.
- **Pause** stops the queue before the next item; it cannot suspend an installer that is already running.
- **Cancel** aborts a download immediately. For a running installer DevForge terminates the process where possible, but WinGet or the vendor installer may continue in the background. Check Installed Software afterwards.
- **Retry** starts a new attempt and keeps the previous history.
- **Remove** and **Clear completed** only affect queue entries, not installed software.
- **Pending items can be reordered** with the up/down controls. Only items that have not started can move; running and finished entries keep their position.
- The queue shows elapsed time for the running item and an estimate for the remaining pending items based on the average of completed items in this session. The estimate is informational, never a fabricated percentage.
- Pending items are saved to `<userData>\queue-state.json`. With **Resume pending queue on startup** enabled (the default), they are restored after the registry loads; if the queue was running when DevForge closed, it resumes. Interrupted attempts are still marked in history rather than reported as successful.
- With **Keep running in the tray** enabled, closing the window hides DevForge instead of quitting. The tray menu reopens the app, shows pending items, pauses or resumes the queue, and quits.
- A package that requires a restart finishes as “restart required” and shows a notice; you can continue with other items.

You can leave the queue page while it runs. A notification appears when items complete or fail if notifications are enabled; clicking it focuses the DevForge window.

## Installed Software

Each installed package shows its version, installation directory, environment status and verification state.

- **Verify installation** runs the package's checks now and stores the output.
- **Repair environment configuration** re-applies PATH/variables for the active installation without reinstalling files. The plan shows this as a **configure** step; already-correct entries and variables are reported as “already configured”, not as an error.
- **Configure-only retry** is safe: if a previous attempt already added some PATH entries or variables, DevForge detects them, leaves them untouched and applies only the missing pieces. Zero remaining changes is a successful result.
- **Open installation directory** opens the recorded folder, if it is inside a DevForge-managed location.
- **Uninstall** removes the software using the vendor/WinGet uninstaller, then reverses only the environment changes DevForge made. You can optionally delete the installation folder; database data is never deleted.
- **Check for updates** compares installed versions with the local registry and marks newer versions. When **Check vendor release feeds** is enabled in Settings, packages that declare an official source are also compared with the vendor's release feed. An upstream-only release is shown as informational because no verified installation procedure may exist for it; it is not offered as a one-click upgrade.

If a package is installed but environment setup failed, it is shown as installed with a configuration warning, not as a failed installation. Use Repair after fixing permissions or elevation.

## Environment Variables

This page reads the real user and system environment.

- Variables are marked when DevForge manages them.
- PATH is displayed as individual entries with resolved paths, existence, duplicate and managed flags.
- Duplicate PATH entries are highlighted.
- The **Environment doctor** scans both scopes and reports duplicate PATH entries, managed PATH entries whose folders no longer exist and well-known variables (`JAVA_HOME`, `MAVEN_HOME`, `GOROOT`) that point at missing folders. Each actionable item has a **Review fix** dialog showing the exact before/after value; applying it uses the normal preview, backup and verification flow. A duplicate cleanup keeps the first occurrence and removes only the repeats.
- **Add/Edit variable** previews the change before applying. PATH itself must be edited with entry operations.
- **Add PATH entry**, **remove PATH entry** and variable edits all go through a preview with backups.
- System-scope changes require running DevForge as administrator; otherwise the operation is rejected with an explanation.
- Restoring a backup refuses to overwrite values changed by another program since DevForge wrote them; you get a warning instead.
- After applying, open a new terminal. Existing terminals keep the environment they started with. Some applications require signing out or restarting.

Protected Windows variables cannot be edited. DevForge never replaces the entire PATH.

## Version Manager

Shows packages with multiple installed versions.

- **Switch** is available only for packages that support automatic switching. It points the package's environment at the selected installed version.
- You must install the target version first. Switching does not download anything.
- Open a new terminal after switching.

For packages without automatic switching, install the desired version from Discover and use the vendor's own selection mechanism.

### Project environments

The Version Manager also pins exact installed runtimes to a folder, which lets two projects use different versions at the same time without rewriting the machine PATH.

1. Choose a project folder and inspect it. DevForge reads an existing `.devforge\environment.json` and checks that every pinned version is installed with a known folder.
2. Select one installed version per package and choose **Generate activation script**.
3. DevForge writes `.devforge\environment.json`, `.devforge\activate.ps1` and `.devforge\deactivate.ps1`. Nothing outside the project folder and nothing machine-wide is changed.
4. In PowerShell, run `. .\.devforge\activate.ps1` inside that project. The current shell gets the pinned tool folders prepended and any declared variables set; `. .\.devforge\deactivate.ps1` restores the original PATH for that shell.

The activation script warns at runtime if a pinned folder has been removed, does not duplicate PATH entries and escapes paths safely. **Remove** deletes only DevForge's files inside `.devforge` and leaves project files, installed software and unrelated files alone.

## Installation History

Every queue attempt is stored as a transaction with:

- package, version, method and outcome,
- timestamps and duration,
- per-stage status and messages,
- commands, arguments, exit codes, stdout and stderr,
- verification results and errors.

Filter by status or package, open a transaction to inspect logs, and use the details when reporting a problem. Interrupted attempts are marked as interrupted on the next start rather than reported as successful.

## Settings

- **Appearance** — dark, light or system theme; startup page.
- **Installation defaults** — tools directory, user/system scope, preferred method, automatic verification, confirmation before install.
- **Downloads** — download directory and concurrent download limit (1–3).
- **Environment variables** — user/system scope preference, PATH append/prepend strategy, backup before change.
- **Notifications** — completion, failure and update notifications.
- **Updates** — compare installed versions with canonical vendor release feeds. Upstream-only releases are informational and never presented as verified installs.
- **Network** — optional HTTP/HTTPS proxy URL and a semicolon-separated bypass list. When set, downloads, release lookups and child installer processes receive the proxy; WinGet and vendor installers therefore use it too. Leave the URL empty to use the Windows system proxy.
- **Background and startup** — keep running in the tray when the window is closed, and resume pending queue items on startup.
- **Maintenance** — export diagnostics, open the logs folder, clear the verified download cache, reset settings.
- **About this system** — app/Windows/host/architecture, Electron/Chromium/Node versions, PowerShell and WinGet versions, elevation state, tools directory, database size and registry issues.

Settings are validated and saved to the local database. Theme and startup page apply immediately. Changing the tools directory affects new installs; existing installations keep their recorded locations.

## Common workflows

### Install Python and Git

1. Discover Software → Python → choose a version → Install.
2. Review the plan (Python may require no dependencies; Git is separate).
3. Install now or add to queue.
4. Approve any UAC prompt from the vendor installer.
5. Open a new terminal and run `python --version` and `git --version`.
6. If verification failed, use Installed Software → Verify, then Repair configuration.

### Use a profile

1. Development Environments → Python Development.
2. Review the component list and optional items.
3. Install the profile.
4. Complete or skip optional components in the plan.

### Add a folder to PATH

1. Environment Variables → choose user or system scope.
2. Add PATH entry, paste the folder.
3. Review warnings if the folder does not exist yet.
4. Apply, then open a new terminal.

### Switch Node.js versions

1. Install both versions from Discover (for example Node.js 22 and 20).
2. Version Manager → Node.js → Switch to the desired version.
3. Open a new terminal and run `node --version`.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| “WinGet is not available” | Install or repair **App Installer** from the Microsoft Store, then restart DevForge. |
| Installation fails with exit code 1223 | A UAC prompt was cancelled. Run the install again and approve it. |
| Verification fails right after install | Open a new terminal first. Then use Verify. If it still fails, check the transaction log for the command output. |
| PATH entry exists but the command is not found | The terminal was open before the change. Open a new terminal; some apps need a restart. |
| Installation says environment configuration did not finish | The files are installed. Use Installed Software → Repair environment configuration, or run the same plan again: DevForge applies only the missing environment pieces. |
| “Directory already exists and contains files DevForge did not create” | DevForge will not touch that folder. Rename/remove it, choose another tools directory in Settings, or install another version. |
| “Incomplete DevForge installation from a previous attempt” | Confirm recovery in the dialog. DevForge moves the folder to `<path>.devforge-backup-<time>` and installs a fresh copy; nothing is deleted. |
| Discovery shows no results | Confirm WinGet works by running `winget --version` in a terminal. Some products need internet access to their vendor release feed. The provider badges explain missing providers, rate limits or timeouts. |
| System variable change rejected | Restart DevForge as administrator only if you intend to change machine-wide settings. User-scope changes do not need elevation. |
| “Directory already exists and contains files” | DevForge will not overwrite. Rename/remove the folder or change the tools directory in Settings. |
| Download fails checksum verification | The file was corrupted or altered. Retry from a trusted network. The bad file is deleted automatically. |
| Installer seems stuck | Some vendor installers wait for input. Check the stage detail and the transaction log; cancel if needed. |
| Database install needs a password | DevForge does not create or store database credentials. Configure the server securely after installation; if the unattended installer requires a password it will fail with its own output. |
| App shows an old registry | Curated definitions ship with the app; install a newer DevForge build for those. Packages you added through discovery refresh automatically after 12 hours, or use Refresh discovered metadata. |
| An update is listed but cannot be installed | The version was reported by the vendor feed but the package has no validated procedure for it. It is deliberately informational; wait for a DevForge/registry update instead of forcing an unverified install. |
| Downloads or version lookups fail on a corporate network | Set the proxy URL and bypass list in Settings → Network. WinGet runs as a separate client and may need its own proxy configuration as well. |
| Closing the window did not quit DevForge | **Keep running in the tray** is enabled. Use the tray menu → Quit DevForge, or disable the setting. |
| SmartScreen warning | Expected for an unsigned build. Verify the installer source and choose “More info → Run anyway” only if you trust it. |

### Logs and diagnostics

Settings → Maintenance → **Export diagnostics** creates a local bundle with system information, settings, registry issues and logs, then opens the logs folder. Review it before sharing; it is never uploaded automatically.

## Data and uninstall

- The database, logs and settings live in `%APPDATA%\DevForge`.
- Pending installation queue items are stored in `<userData>\queue-state.json` and removed when the queue becomes empty. Interrupted attempts remain in history with an interrupted status.
- Packages you prepared from discovery are stored as metadata in `%APPDATA%\DevForge\discovered-packages.json`. Deleting one from the catalogue or resetting the JSON never uninstalls software and never touches installation history.
- Downloaded installers live in the configured downloads directory.
- Project pinning writes only `.devforge\environment.json`, `activate.ps1` and `deactivate.ps1` inside the project folder you choose. These files contain paths and variable values, not credentials.
- Uninstalling DevForge does not uninstall the tools it managed, and it does not revert environment changes automatically. Remove or revert them first from the app.
- Uninstalling a managed package never deletes database data. Back up databases before removing a database server.

## Safety rules DevForge follows

- The UI never runs elevated by default; only the specific operation that needs administrator rights asks for it.
- Nothing is downloaded over HTTP, and nothing is executed before its checksum is verified.
- PATH is changed additively with backups; DevForge never writes a brand-new PATH.
- Failed operations are reported as failed. Partial installs and partially applied environment changes are described as partial, not successful.
- Re-running a configuration is safe: existing correct entries count as already satisfied.
- Cancellation of a third-party installer is best-effort and the UI says so.
- No credentials, telemetry or cloud sync.
