# Changelog

All notable changes to DevForge are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-08

First public release.

### Added

- Validated catalogue of 20 curated packages across languages, runtimes, frameworks, databases, compilers, build tools and developer tools.
- Unified identity-aware discovery across the curated catalogue, validated WinGet manifests and authoritative vendor release feeds, with one ranked result per product.
- Authoritative version resolution with provenance for stable, LTS and preview releases.
- Dependency-aware installation plans with cycle detection and pre-flight checks for architecture, disk space, elevation and WinGet availability.
- Serialized installation queue with persisted state, cancellation, retry, reordering, elapsed and ETA reporting.
- Four installation methods: WinGet, checksum-verified archives, official installers and project recipes.
- Real detection and verification across commands, files, services, the uninstall registry and WinGet.
- Idempotent PATH and environment-variable management with backups, targeted reversal and an environment doctor.
- Side-by-side version management and per-project activation scripts.
- Profile and environment export/import for reproducible setups.
- Dashboard, installation history, command palette, tray controls and desktop notifications.
- Optional proxy support applied to downloads, release lookups and child installers.
- Local SQLite storage with no account, telemetry or bundled SDK archives.

### Fixed

- Update badges no longer persist after a package has actually been updated. Detection evidence now wins over stale recorded versions, and update checks compare the highest known installed version.
- Verification of npm and other Windows command shims (`npm.cmd`, `yarn.cmd`) now resolves executables through `PATH` and `PATHEXT` instead of relying on `spawn` extension lookup alone.
