# Package Development

DevForge is driven by a declarative registry. A package is a JSON file, not a script. It describes where the software comes from, how it is installed, which files and commands prove it works, and which environment changes it needs.

Registry locations:

```
packages/
  registry/
    languages/        python.json, nodejs.json, java-jdk.json, go.json, rust.json
    frameworks/       django.json, flask.json, react-vite.json, spring-boot.json
    databases/        mysql.json, postgresql.json, mongodb.json
    compilers/        mingw-w64.json
    build-tools/      maven.json, cmake.json
    developer-tools/  git.json, github-cli.json, docker-desktop.json, windows-terminal.json
    runtimes/         dotnet-sdk.json
  profiles/           python-development.json, mern-development.json, ...
  identities.json     canonical software identities shared by discovery and packages
```

In development the registry is read from `<project>/packages`. In a packaged build it is read from `resources/packages`, which `electron-builder` copies as `extraResources`. Only JSON files (registry, profiles and `identities.json`) are copied; no installers or archives are bundled. Curated definitions are not downloaded at runtime, so changing one for an installed copy means updating the shipped files and rebuilding/reinstalling. This keeps the curated catalogue local and reviewable.

Separately, a user can add a **discovered** package at runtime (see [Discovered packages and canonical identities](#discovered-packages-and-canonical-identities)). Those definitions are generated from a validated WinGet manifest or an official archive release, stored in `<userData>/discovered-packages.json`, and merged into the catalogue at startup. They never modify the curated JSON files.

A package JSON file can also be imported directly from **Discover Software → Import package**. Import uses the same schema and semantic validation as the registry, rejects an id that already exists, limits the file to 512 KB and stores the result as discovery metadata. Importing does not execute anything; the package still goes through the normal plan and queue.

## Validation pipeline

1. Every `*.json` file is read recursively and must parse.
2. The object is validated by `packageDefinitionSchema` with zod.
3. `validatePackageSemantics` applies cross-field rules.
4. Invalid files are skipped and reported in Settings → About/registry issues; one bad file does not prevent the rest of the catalogue from loading.
5. Accepted definitions are synchronized into SQLite for querying and history display.
6. Discovery-added definitions go through the same zod and semantic validation when they are loaded from `discovered-packages.json` and again when they are prepared. WinGet candidates must declare `origin: "winget"`, `installationMethod: "winget"` and a WinGet package id; official archive candidates must declare `origin: "official"`, a verified HTTPS URL and SHA-256 checksum. Curated definitions win id collisions.

When a file is rejected, the log and diagnostics export show the file path and the failing field.

## Minimal package

Every installable package needs at least one version, exactly one default version, and a way to install it.

```json
{
  "schemaVersion": 1,
  "id": "example-tool",
  "name": "Example Tool",
  "category": "developer-tool",
  "description": "One-line description shown on cards.",
  "publisher": "Example Corp",
  "homepage": "https://example.com/",
  "license": "MIT",
  "icon": "terminal",
  "installationMethod": "winget",
  "packageManagerId": "Example.Tool",
  "scope": "user",
  "versions": [
    {
      "version": "1.2.3",
      "channel": "stable",
      "isDefault": true,
      "packageManagerId": "Example.Tool",
      "estimatedSizeBytes": 50000000
    }
  ],
  "dependencies": [],
  "environment": [],
  "verification": [],
  "detection": { "args": [], "knownPaths": [] }
}
```

## Field reference

### Identity and presentation

| Field | Required | Notes |
| --- | --- | --- |
| `schemaVersion` | yes | Must be `1` |
| `id` | yes | Lowercase letters, digits and hyphens; unique across the registry |
| `name` | yes | Display name |
| `category` | yes | `language`, `framework`, `database`, `compiler`, `build-tool`, `developer-tool`, `runtime` |
| `description` | yes | Short card text |
| `longDescription` | no | Detail page text |
| `publisher`, `homepage`, `license` | yes | `homepage` must be HTTPS |
| `documentationUrl` | no | HTTPS |
| `icon` | yes | A key understood by the icon helper (Simple Icons slug or `terminal`) |
| `advanced` | no | Marks expert/risky packages |
| `caveats`, `tags` | no | String arrays shown in the UI |

### Installation

| Field | Applies to | Notes |
| --- | --- | --- |
| `installationMethod` | all | `winget`, `official-installer`, `archive`, `project-recipe` |
| `packageManagerId` | WinGet | Package-level id; can be overridden per version |
| `scope` | all | `user` (default) or `system`; informational for WinGet scope selection |
| `supportedArchitectures` | all | Defaults to `["x64"]` |
| `supportedWindowsVersions` | all | Defaults to `["10", "11"]` |
| `requiresAdmin`, `requiresRestart` | all | Used by the planner and plan dialog |
| `installDirectoryTemplate` | archive, installer | Supports the template tokens listed under Environment; must resolve to an absolute Windows path |
| `expectedExecutables` | archive | Relative paths that must exist after extraction; at least one is required for archives |
| `supportsVersionSwitching` | all | Enables the Version Manager for multiple installed versions |
| `uninstall` | all | `{ method: "winget" \| "command" \| "directory", command?, args?, keepData }` |
| `projectRecipe` | recipe | `{ summary, commands: [{ label, command }], notes }`; must be present for `project-recipe` |

### Versions

Each entry in `versions` supports:

- `version` — digits with up to four components, optional `-prerelease` or `+build`. Examples: `3.13.17`, `17.11-5`, `1.0.0-beta.2`.
- `channel` — `stable` or `lts`.
- `isDefault` — **exactly one** version must be true.
- `packageManagerId` — optional override for this version (for example `Python.Python.3.12`).
- `download` — required for `archive` versions, and used by `official-installer`.
- `installArgs` — string array passed verbatim to the official installer.
- `estimatedSizeBytes` — progress and disk estimates.

Download object:

```json
{
  "url": "https://example.com/tool-1.2.3-win64.zip",
  "archiveType": "zip",
  "checksum": "<sha256 or sha512 hex>",
  "checksumAlgorithm": "sha256",
  "sizeBytes": 12345678,
  "stripRootFolder": true
}
```

Rules:

- `url` must be HTTPS.
- The checksum must be a 64–128 character hex digest. DevForge refuses unverified downloads.
- `stripRootFolder` removes a single top-level directory when the archive wraps its contents in one.
- `archiveType` is currently restricted to `zip`.
- `signature` is optional and only honoured for `official-installer` downloads. It pins Authenticode verification after the checksum:

```json
"signature": {
  "publisher": "Rust Foundation",
  "thumbprint": "0123456789ABCDEF0123456789ABCDEF01234567"
}
```

`publisher` must appear in the signature subject. `thumbprint`, when present, must be 40–64 hexadecimal characters and match exactly. A missing, invalid or mismatched signature is a `VERIFICATION_FAILED` error, so only add this once you have inspected the real installer signature. Archives and WinGet packages do not use this field.

Get a checksum on Windows:

```powershell
Get-FileHash .\tool-1.2.3-win64.zip -Algorithm SHA256
```

Only publish a checksum you obtained from the vendor or verified yourself. Never make one up.

### Dependencies

```json
"dependencies": [
  { "packageId": "python", "kind": "required", "minVersion": "3.12.0", "reason": "Django needs Python" }
]
```

- `kind` defaults to `required`. Optional dependencies produce warnings when missing.
- `minVersion` makes the planner select the highest available version that satisfies the minimum when no exact version was requested.
- A package may not depend on itself; circular dependencies are rejected by the planner with the full cycle.

### Environment

```json
"environment": [
  { "kind": "path", "name": "PATH", "valueTemplate": "{installDir}\\bin", "scope": "user" },
  { "kind": "variable", "name": "EXAMPLE_HOME", "valueTemplate": "{installDir}", "scope": "user" }
]
```

- `kind: "path"` entries are added **additively** to PATH. DevForge never writes a whole new PATH from a template.
- `kind: "variable"` creates or updates a single variable.
- `PATH` cannot be used as a normal variable spec; there are no whole-PATH replacements.
- Core Windows variables (`SystemRoot`, `windir`, `TEMP`, `USERPROFILE`, `ProgramFiles`, etc.) are protected from modification.
- Available templates: `{toolsDir}`, `{installDir}`, `{version}`, `{name}`, `{userProfile}`, `{localAppData}`, `{programFiles}`, `{programFilesX86}` and `{windows}`. Unknown placeholders are rejected when the path is resolved.
- Environment changes are backed up as individual operations so uninstall and Repair Configuration can reverse only what DevForge added.
- Application is idempotent: if every PATH entry is already present and every variable already has the requested value, the result is `already-satisfied` instead of a rewrite. Declare only the directories and variables the tool truly needs so this comparison stays reliable.

### Verification and detection

Verification checks run after installation (when enabled in Settings) and on demand:

```json
"verification": [
  {
    "id": "tool-version",
    "label": "Example Tool",
    "kind": "command",
    "command": "example",
    "args": ["--version"],
    "expectPattern": "Example \\d+",
    "versionPattern": "(\\d+\\.\\d+\\.\\d+)",
    "optional": false
  }
]
```

Supported `kind` values:

- `command` — runs an executable with an argument array.
- `file` — checks a templated path.
- `service` — checks a Windows service name pattern.
- `winget` — checks WinGet's view of the package.

Detection tells DevForge whether the software is already present:

```json
"detection": {
  "command": "example",
  "args": ["--version"],
  "versionPattern": "(\\d+\\.\\d+\\.\\d+)",
  "displayNamePattern": "Example Tool",
  "knownPaths": ["{localAppData}\\Example\\Tool"],
  "serviceNamePattern": null
}
```

Detection is best-effort and never installs anything. Known paths are expanded with the template resolver. A detected installation can mark a plan step as `skip`.

### Profiles

A profile is a curated bundle of packages:

```json
{
  "schemaVersion": 1,
  "id": "example-development",
  "name": "Example Development",
  "description": "Everything needed for Example projects",
  "audience": "Backend developers",
  "icon": "terminal",
  "notes": ["Run `example init` in a new project."],
  "components": [
    { "packageId": "example-tool", "optional": false, "preferredVersion": "1.2.3" }
  ]
}
```

Component `packageId` values must exist in the registry; the registry test suite enforces this. `preferredVersion`, when present, must also exist.

## Recipe packages

A package that is not installed globally uses:

```json
{
  "installationMethod": "project-recipe",
  "versions": [],
  "projectRecipe": {
    "summary": "Create a new Django project.",
    "commands": [
      { "label": "Install Django", "command": "python -m pip install django" }
    ],
    "notes": ["Activate your virtual environment first."]
  }
}
```

Recipe packages have no versions and cannot be queued. The UI shows the commands with copy buttons. DevForge never runs them automatically.

## Discovered packages and canonical identities

Discovery does not invent package definitions in the renderer and is not a second hand-authored registry. Every result is tied to a **canonical identity** from `packages/identities.json` when one exists, and only validated candidates become installable.

### Canonical identities

An identity describes the product independently of any package or package manager:

| Field | Purpose |
| --- | --- |
| `id`, `name`, `officialName`, `publisher`, `homepage`, `category`, `description`, `icon` | Stable product metadata used for display and exact matching |
| `aliases` | Official names, executable names, compiler/driver names and common spellings (for example `kotlinc`, `python.exe`, `gcc`) |
| `executables` | Command-line entry points used for strong identity matching and detection |
| `packageIds` | Curated package ids that realize this identity |
| `wingetIds` | Known WinGet manager ids for the product |
| `githubRepo` | Official repository, used only when the identity declares `github` as its version source |
| `versionSource` | Authoritative version strategy: `nodejs`, `python`, `go`, `php`, `flutter`, `dart`, `github`, `winget` or `none` |
| `installationAdapters` | Which validated adapters may install it: `catalogue`, `winget`, `official-archive` |
| `officialArchive` | Archive layout (`flutter`, `php`, `dart`) when DevForge can build a verified archive package |
| `relatedTools`, `tags`, `platforms`, `architectures` | Ranking, discovery and compatibility metadata |

Identities are validated with zod and semantic rules (for example, `officialArchive` requires the `official-archive` adapter). Invalid entries are reported with their field path and skipped. Adding an identity is the first step when adding software that discovery should recognize; adding a curated package is still the way to control exact versions, checksums, environment and verification.

### WinGet candidates

`WinGetProvider` builds a normal `PackageDefinition` from a validated `winget show` result:

- `origin: "winget"` and `installationMethod: "winget"`,
- one default version equal to the manifest version, with no `installArgs`,
- empty `environment` and `expectedExecutables` because the vendor installer owns them,
- a `winget` verification check for package registration,
- scope user, x64, Windows 10/11, with caveats that WinGet/vendor manages PATH,
- `uninstall` by WinGet with `keepData: true`.

The generated id is `winget-<slug>` and is truncated with a stable hash for long WinGet ids. A candidate is only created when the manifest parsed, the version is representable, the homepage is HTTPS, and the generated id does not collide with another package. Otherwise the search result stays `metadata-only` and cannot be prepared.

### Official archive candidates

For identities with `officialArchive`, `buildOfficialArchivePackage` turns the latest **resolved** release into a normal archive package:

- `origin: "official"` and `installationMethod: "archive"`,
- one version per verified release record, with the LTS release preferred as default,
- the vendor's HTTPS archive URL and published SHA-256,
- the identity's architecture, install directory, PATH entry and command verification,
- `uninstall` by directory with `keepData: true`.

A record without an HTTPS archive URL or a valid checksum is omitted; if no verified record remains, no package is built and the result stays metadata-only. Preview releases are not offered as the default.

### Persisted state

```json
{
  "version": 2,
  "packages": [ { "schemaVersion": 1, "id": "flutter", "origin": "official", "..." : "..." } ],
  "refreshedAt": { "flutter": "2026-01-01T00:00:00.000Z" },
  "releases": { "flutter": { "latestStable": "3.35.0", "retrievedAt": "2026-01-01T00:00:00.000Z", "..." : "..." } }
}
```

- Writes are atomic (temporary file plus rename). A malformed file is logged and treated as empty; it is never deleted automatically.
- Version 1 files are upgraded transparently; existing packages and refresh timestamps are preserved.
- `DiscoveryService.refreshManagedPackages()` checks packages older than 12 hours in the background, or on demand from the discovery page. It rebuilds WinGet metadata from the current manifest and official-archive versions from the declared release source, preserving the package id, category and icon.
- Installations of discovered packages use the same queue, plan, engine and history as curated packages. WinGet packages omit `--version` so WinGet installs from the current manifest; official archives download and verify the exact resolved version shown in the plan.
- To turn a frequently used discovered tool into a curated definition, author a normal JSON package with explicit versions, checksums, environment and verification, add it under `packages/registry`, and reference it from the identity's `packageIds`.

## Security rules for definitions

A package definition must never:

- contain a plaintext password, token or private key,
- point at HTTP or unknown mirrors when the vendor offers HTTPS,
- execute a shell string or interpolate user input,
- write an environment value that replaces all of PATH,
- delete user data during uninstall,
- invent WinGet ids, URLs, checksums or silent flags.

The engine only understands the fields above. There is no `script` or `command` field for arbitrary installation, so a malicious JSON file cannot execute code by itself. Treat the registry directory as trusted application content and review changes to it like code.

## Adding a package: checklist

If WinGet already publishes a well-formed manifest and the tool needs no custom environment or checksum handling, users can prepare it through **Discover Software** at runtime. Author a curated definition when you need control over versions, archive checksums, environment templates, verification or profiles.

1. Verify the vendor's official WinGet id or download URL and license.
2. Add a version with the real version number and, for downloads, the published checksum.
3. Declare at least one verification command that proves the tool works.
4. Add detection so existing installations are recognized.
5. Add environment entries only for directories that truly need to be on PATH or variables the tool requires.
6. Set exactly one default version.
7. Add or update the canonical identity in `packages/identities.json`: aliases, executables, `packageIds`, `wingetIds`, `versionSource` and adapters. Without an identity, discovery cannot recognize the product, even though the package still appears in the catalogue.
8. Run `npm test` — registry and identity suites validate schema, semantics, HTTPS URLs, checksums, dependency resolvability, core ids and profile references.
9. Run `npm run dev`, inspect the package detail page, preview a plan, and perform a real install on a clean folder.
10. Update [`README.md`](../README.md) catalogue counts if the number of packages changes.

## Updating an existing package

- Keep the old version when it is still supported; add the new version and move `isDefault`.
- WinGet packages may use the same package id across versions (for example `Python.Python.3.13`); per-version ids handle major lines.
- Archive packages require new download metadata and checksums for every version.
- Deprecate a version by removing it from `versions`; existing installation records remain in history.
- Changing an id breaks profile references and user installations. Prefer adding a new id and leaving a migration note.

## Debugging a definition

- Settings → About this system → registry issues lists validation failures with file and field.
- Discovery validation failures are shown as metadata-only results with a reason instead of an Install button.
- Discovery-added definitions can be inspected in `%APPDATA%\DevForge\discovered-packages.json`. Do not add secrets there; it is plain metadata.
- Installation History shows per-stage logs, commands, exit codes and captured output.
- Export diagnostics from Settings → Maintenance for a bundle containing system, registry and log information.
- In development, restarting the app reloads the registry from disk. Packaged builds require a new build.
