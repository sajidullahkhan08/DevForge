# Unified Discovery and Version Resolution

DevForge has one search experience. A query is resolved against canonical software identities, enriched from validated sources, and returned as one ranked result list per product. There is no second "online search" workflow, no Local/Online tabs and no separate discovery panel.

## Pipeline

```
query (renderer, debounced)
  → discovery:search
      ├─ identity matching        → exact / alias / executable / package matches
      ├─ WinGet provider          → local winget search + validated show manifest
      ├─ ReleaseResolver          → authoritative version channels per identity
      └─ merge + rank + dedupe    → UnifiedDiscoveryResult[]
  → one result per product
  → discovery:prepare (only validated candidates)
      → dynamic package registration → catalogue sync → normal plan dialog
```

The renderer shows local catalogue matches immediately while external sources are still running. Requests for older queries are ignored by TanStack Query keys; the main process caches responses for 10 minutes. Only results that are backed by a validated installation procedure expose **Install**.

## Canonical identity registry

`packages/identities.json` is shipped with the application and loaded by `IdentityRegistry` at startup. An identity is independent of any package source.

| Field | Purpose |
| --- | --- |
| `id`, `name`, `officialName`, `publisher`, `homepage` | Canonical product identity |
| `aliases`, `executables` | Accepted search terms and command names (`kotlinc`, `gcc`, `clang`, `flutter`, …) |
| `packageIds`, `wingetIds` | Verified links to curated packages and WinGet manifests |
| `category`, `tags`, `relatedTools` | Classification and related suggestions |
| `versionSource` | Which authoritative release source is trusted for this product |
| `installationAdapters` | `catalogue`, `winget`, `official-archive` |
| `officialArchive` | `flutter`, `dart` or `php` when a verified vendor archive can be installed |
| `platforms`, `architectures` | Compatibility declared by DevForge |

The shipped registry covers Python, Node.js, Java, Go, Rust, Kotlin, Flutter, Dart, PHP, Composer, Ruby, LLVM/Clang, MinGW-w64, MongoDB, MySQL, PostgreSQL, CMake, Maven, Git, GitHub CLI, Docker Desktop, Windows Terminal, .NET SDK, Django, Flask, React + Vite and Spring Boot.

Matching is deliberately conservative (`shared/identity.ts`):

| Match | Score |
| --- | --- |
| Exact canonical or official name | 100 |
| Same text after removing punctuation/case | 98 |
| Name plus a qualifier such as "SDK" or "CLI" | 90 / 88 |
| Word containment | 72 / 70 / 66 |
| Small typo (edit distance 1–2) | 55 |
| Minimum identity resolution | 85 |

A query is "identified" only at 85 or above, which requires an exact name, a known alias/command, or name plus qualifier. Typo matches and containment are shown as related results, never as the identified product. External WinGet rows are merged into an identity only on an exact package/WinGet id or a strong (≥85) name match; a loose similarity cannot replace the official product.

## Ranking and de-duplication

Every query produces at most one result per identity. Curated packages, official archives and WinGet rows are merged by identity id; results without an identity are deduplicated by normalized name. Source priority when several procedures exist:

1. curated catalogue package,
2. validated official archive candidate,
3. existing official package,
4. existing WinGet package,
5. metadata-only result.

Primary results require an identity score of at least 80 and match tier influences order: exact product, executable/compiler, verified package, strong alias, related name. Source reliability affects confidence through the verified metadata-only badge, not by inventing versions.

## Authoritative version resolution

`ReleaseResolver` resolves version channels only from the provider declared by the identity's `versionSource`:

| `versionSource` | Source |
| --- | --- |
| `nodejs` | `https://nodejs.org/dist/index.json` |
| `python` | `https://www.python.org/api/v2/downloads/release/` |
| `go` | `https://go.dev/dl/?mode=json&include=all` |
| `php` | `https://windows.php.net/downloads/releases/releases.json` |
| `flutter` | Flutter Windows release index on `storage.googleapis.com` |
| `dart` | Dart SDK archive `VERSION` files and `.sha256sum` |
| `github` | GitHub Releases API for the identity's declared repository |
| `winget` | The WinGet manifest version, labelled as a manifest version |
| `none` | The curated definition only |

Rules:

- A channel (`stable`, `lts`, `preview`) is populated only when an authoritative record exists. WinGet manifests and curated definitions are never labelled "latest".
- Version comparison is semantic and handles LTS, pre-release suffixes and vendor formats.
- Results carry provenance (`source.id`, label, URL, kind), retrieval time, `stale` and `error`.
- Successful results are cached for 6 hours (empty results for 30 minutes), bounded to 120 entries and persisted with discovery metadata. Concurrent requests for the same identity share one in-flight request.
- If a refresh fails and an expired cached result exists, the old result is returned with `stale: true` and the error. Without a cache, resolution returns an empty, explicit error rather than a guessed version.
- Only the official GitHub repository declared by an identity is queried. GitHub repositories are never installed directly.

## Official archive installation

Flutter, Dart and PHP can be installed from their vendor archives because their layouts are known and verifiable:

- archives must use HTTPS and publish a SHA-256 checksum;
- preview channel archives are never installable;
- LTS is preferred when present; otherwise the newest verified release;
- each version records its download URL, checksum, optional size and `stripRootFolder`;
- the generated package installs into `{toolsDir}\Flutter|Dart|PHP\{version}`, adds the documented PATH entry, verifies the command, and removes only the recorded directory while keeping user data.

Official archive packages are rebuilt when their metadata is older than 12 hours. A failed refresh keeps the existing package.

## Persistence

`<userData>/discovered-packages.json` stores:

- version 2: dynamic package definitions, per-source refresh timestamps and the release cache;
- version 1 files are still read, so existing users lose no data.

The SQLite schema is unchanged. Writes are atomic (`.tmp` rename), and a malformed file is ignored rather than deleted.

## Limits

- WinGet is optional; without it, curated packages and authoritative release feeds still work, and the WinGet provider reports its failure.
- Anonymous GitHub API requests can be rate-limited; cached or curated version data remains visible and the failure is shown.
- Metadata-only results (for example a WinGet package with an unsafe version or no HTTPS homepage) never expose Install.
- DevForge does not verify Authenticode signatures of third-party installers or generic download URLs; WinGet handles signature checking for its own manifests.
- There is no generic web search: unknown products return no verified result rather than a scraping-derived install action.
