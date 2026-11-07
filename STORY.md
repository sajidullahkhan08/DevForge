# The Story Behind DevForge

> How a frustrating first week of environment setup became a tool for making that week disappear.

## The first wall

Every developer remembers their first real setup. Not the first line of code — that part is usually easy, even fun. The hard part comes before it: making the machine ready.

I still remember the shape of the problem more than any single error message. You follow a tutorial, and it tells you to install a language. You download something. It seems to work. Then the tutorial asks you to run a command, and the terminal says the command does not exist. You install it again. Now a different version exists somewhere else, and the first one stops working. You search for the error, and the answers contradict each other. One page says edit an environment variable. Another says reinstall everything. A third is an advertisement dressed up as a download page.

Hours pass. The code from the tutorial is still sitting there, untouched, waiting. The wall was never the code. It was everything around it.

## Watching the same wall appear for other people

Once you have climbed a wall a few times, you start noticing it everywhere. A friend tries to learn Python and gets stuck on why `python` works in one terminal but not another. A classmate installs Node.js, then cannot run `npm`, even though npm was installed with it. Someone follows a Java tutorial and ends up with three JDKs, a broken `JAVA_HOME`, and no idea which one their editor is using. A beginner installs a database, restarts, and finds the service is not running. Another one copies a `PATH` from a forum post and accidentally breaks an unrelated tool that used to work.

What struck me was not that these problems were hard to solve. Most of them have simple causes. What struck me was how *invisible* the causes are to someone new:

- Which version should they choose, and why?
- Is this download the official one?
- Did the installer actually finish, or did it just close?
- Why does the same command behave differently in two windows?
- Why did installing one tool break another?
- How do they get the same setup on a second machine?

Experienced developers answer these questions almost unconsciously. Beginners cannot, because the answers live in details nobody shows them: `PATH` order, `PATHEXT`, system versus user variables, per-machine versus per-user installers, architecture, conflicting versions, stale shells, services, and a dozen vendor-specific quirks.

The usual advice is "just use a package manager." Package managers help — a lot. But they do not remove the wall. They move part of it. You still need to know which package id is the real one. You still need to know what a command failed to find. You still need to understand what changed on your machine, and how to undo it. And when the package manager is missing or outdated, the beginner is back to downloading installers from search results and hoping.

## The realization: this is a trust problem

The more I looked at it, the more I became convinced that environment setup is not primarily an installation problem. It is a **trust** problem.

A beginner is asked to trust a search result, a download link, a checksum they have never seen, an installer that shows a generic progress bar, a tutorial from an unknown date, and a terminal that reports success without explaining what success means. Every step asks for trust, and almost none of it offers evidence.

That framing changed everything for me. If setup is a trust problem, then the solution is not another list of download links. The solution is a tool that can *show its work*:

- Show where a package definition came from.
- Show which version is official, and which is merely cached.
- Show a plan before changing anything.
- Verify the result after the change.
- Record what was changed, and make it reversible.
- Refuse to install when the source or the procedure cannot be verified.

In other words: treat environment setup like production software, not like a ritual.

## Why the name DevForge

A forge is where raw material is shaped into something useful, with heat, tools, and skill. That felt right. Setting up a development machine is a forging process: raw downloads become a working toolchain. The anvil, the flame and the code bracket in the icon are not decoration — they are the idea. Shape the environment deliberately, with the right tools, and leave something strong behind.

The name also carries a promise. A forge is a place of craft, not a magic button. DevForge should be honest about what it is doing, even when what it is doing is complicated.

## The principles I refused to compromise on

DevForge grew out of a small set of rules. They were not added later as marketing; they were the reason the project existed.

**No mock data. No invented progress.** If a package is shown as installed, an installer or package manager actually ran, the result was checked, and a record was written. A progress bar that moves because a timer moved it is a lie, and a tool built on trust cannot afford lies.

**Data, not hard-coded guesses.** Packages are definitions: sources, checksums, commands, environment changes, detection rules, dependencies. They are validated on load. That makes the catalogue reviewable, testable and extendable without turning the codebase into a pile of special cases.

**One product, one identity.** Searching for a tool should not return five confusing near-duplicates. A canonical identity merges the curated definition, a validated WinGet manifest and the official release feed into a single result. The user sees one product, with provenance for its versions.

**Verify before believing.** A command that returns zero is not proof. A file that exists is not proof. DevForge checks commands, known paths, the Windows uninstall registry, services and package manager listings, and it prefers fresh evidence over old records.

**Be conservative with the machine.** Preserve unrelated `PATH` entries. Normalize and de-duplicate. Back up before writing. Reverse individual changes instead of restoring a whole snapshot. Move recoverable folders aside instead of deleting them. Never run the whole app as administrator; ask Windows for elevation only for the specific operation that needs it.

**Stay local.** No account, no telemetry, no cloud dependency for basic use. The catalogue and existing installations work offline. The database, logs and diagnostics stay on the machine.

**Show the caveats.** Some vendor installers cannot be silently verified. Some tools are recipes rather than installers. Some updates exist upstream with no safe installation procedure yet. DevForge says so instead of pretending otherwise.

## How it was built

The project is an Electron application with a React and TypeScript renderer, but the interesting part is the boundary between them. The renderer is sandboxed. It cannot touch the file system, the registry, `PATH`, services or the network. It can only ask the main process to do something through a typed, schema-validated IPC API.

That boundary is deliberate. It means every privileged operation has one place to live, one place to validate input, and one place to audit. It also means the UI can be honest: it is rendering results from the engine, not inventing them.

Behind the boundary, the engine is divided by responsibility: a validated registry, a canonical identity layer, release providers with provenance, a unified discovery and ranking service, a pure dependency planner, a serialized installation queue, a checksum-verifying download layer, detection and verification engines, environment management with backups, a SQLite record of every transaction, and a set of Windows-specific adapters.

The work was iterative. Build the catalogue. Make discovery return one result per product. Add plans and dependency ordering. Add a queue that survives restart. Add verification that uses real commands. Add a doctor for the environments that were already broken. Add export and import. Add per-project pinning. Add update checks that compare against the highest known installed version, so a stale record cannot produce a permanent update badge. Fix the Windows shim problem so `npm.cmd` verifies correctly. Test all of it, including a packaged build.

Not every piece was planned from the beginning. Several of the best features came from using the tool on a real machine and noticing where it was still guessing. That is the forge again: heat, shape, inspect, repeat.

## What I hope it becomes

The first version of DevForge is a complete, local-first Windows tool. It installs and verifies real software, manages environments safely, and keeps a record of what it did. It is not the end of the idea.

The direction is clear: more validated packages, better vendor coverage, signed builds, and the same principle at every step — *show the evidence*. A beginner should be able to open DevForge, search for the tool their tutorial mentions, understand what will happen, and end up with a working command in their terminal. An experienced developer should be able to export a machine, reproduce it elsewhere, and trust that the result is real.

If the project succeeds, the first wall gets a little lower. Not because setup becomes trivial, but because it becomes visible, reversible and honest.

That is the story so far. The rest is forged from here.

---

*DevForge is released under the MIT licence. The technical details live in [Architecture](docs/ARCHITECTURE.md), [Unified Discovery and Version Resolution](docs/DISCOVERY_AND_VERSIONS.md) and [Installation Engine](docs/INSTALLATION_ENGINE.md).*
