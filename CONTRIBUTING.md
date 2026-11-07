# Contributing to DevForge

Thanks for taking the time to improve DevForge. This project favours small, well-tested changes that keep the trust boundary intact.

## Before you start

- Read [Architecture](docs/ARCHITECTURE.md) and [Security](docs/SECURITY.md) so you know where privileged code lives.
- For a new package, follow [Package Development](docs/PACKAGE_DEVELOPMENT.md) instead of hard-coding an install path.
- For a bug, open an issue with the DevForge version, Windows version, reproduction steps and, where relevant, the entry from the log folder shown in **Settings → Diagnostics**.

## Development setup

Requirements: Windows 10/11 x64 and Node.js 22 or newer (24 recommended).

```bash
npm install
npm run dev
```

Useful checks before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run audit:prod
```

`npm run verify` runs typecheck, tests and the production build in one step.

## Guidelines

- Keep all system access in the Electron main process. The renderer must only use the typed preload API.
- Validate every new IPC payload with zod and register it through the existing handler helpers.
- Never execute a shell string. Pass a command and an argument array.
- Preserve the rule that a package is reported installed only after real execution and verification. No mock progress or optimistic state.
- Add or update a Vitest test for behaviour changes. Tests live in `tests/` and use the existing fakes rather than touching the real machine where possible.
- Keep documentation in `docs/` in sync when behaviour or configuration changes.
- Match the existing TypeScript style: strict types, no `any` unless unavoidable, explicit return types on exported functions.

## Commit messages

Use a short imperative subject, for example `Fix npm shim resolution during verification`. A body explaining the reason is welcome for anything non-obvious.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence in [LICENSE](LICENSE).
