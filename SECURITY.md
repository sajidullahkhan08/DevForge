# Security Policy

## Supported versions

DevForge is distributed as a desktop application. Security fixes are shipped in the latest published release; please make sure you are running the newest version from the [Releases page](https://github.com/sajidullahkhan08/DevForge/releases).

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository:

<https://github.com/sajidullahkhan08/DevForge/security/advisories/new>

Include the version of DevForge, the Windows version, clear reproduction steps and the impact you believe the issue has. If the report concerns a package definition, include the package id and the source URL involved.

You can expect an acknowledgement within a few days. Once a fix is available, the advisory and the patched release will be published together.

## What DevForge does to protect users

- The renderer is sandboxed with `contextIsolation` enabled and `nodeIntegration` disabled; it can only reach privileged code through the typed preload bridge.
- Every IPC payload is schema-validated and the sender window is verified.
- Commands are never assembled from arbitrary user or web input. They come from validated registry definitions or fixed internal code paths.
- Downloads require HTTPS, are streamed to a controlled temporary directory and are rejected when a published checksum does not match.
- Archive extraction confines entries to the staging folder and rejects path traversal, symlinks, encrypted entries and duplicate targets.
- DevForge never runs itself as administrator. Elevation is requested by Windows for the individual operation that needs it, and a refusal is handled as a normal failure.
- Environment changes preserve unrelated entries, are backed up before writing and can be reversed individually.

The complete threat model and trust boundaries are documented in [docs/SECURITY.md](docs/SECURITY.md).
