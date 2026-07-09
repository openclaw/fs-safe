# Changelog

## 0.4.2 - Unreleased

### Security and Correctness

- Disable `remove-if-unchanged` stale sidecar deletion because a pathname identity check followed by unlink can delete a replacement lock; retain the deprecated recovery inputs for compatibility while all stale locks fail closed.

## 0.4.1 - 2026-07-01

### Security and Correctness

- Update the optional TAR extractor to reject NUL-terminated PAX values, invalid negative entry sizes, and explosive decompression payloads.

### Compatibility

- Add explicit `renameIdentity: "verify-content-with-lock"` writes for rclone-style FUSE mounts whose inode identity changes across rename, while keeping strict identity verification as the default and failing closed on stale cooperative locks. (#32, #33; thanks @jlautman)

## 0.4.0 - 2026-06-17

### Features

- Report unreadable walk roots and subdirectories through `failedDirs` from `walkDirectory()` and `walkDirectorySync()`, preserving readable results while letting destructive reconciliation distinguish incomplete scans from empty directories. (#29; thanks @amknight)

### Compatibility

- Require Node.js 22 or newer for the npm package and docs, matching the maintained CI matrix.

### Security and Correctness

- Fall back to the existing copy/remove move path when Windows denies directory renames with `EPERM`, preserving skill updates while watched files are locked. (#27; thanks @liuxingwei0601)
- Sync `root.append` file handles before close and sync the parent directory when append creates a file, preserving append-mode concurrency while improving durability. (#21; thanks @KumarAnandSingh)
- Reject known unsafe device and process-fd read paths before opening files, including `/dev/zero`, `/dev/random`, `/dev/fd/*`, `/proc/*/fd/*`, and Windows reserved device names.

## 0.3.0 - 2026-05-21

### Features

- Add opt-in `denyMutations` policies with exact `paths` and subtree `prefixes` so callers can protect application-sensitive files from root write, copy, move, remove, mkdir, and writable-open operations. (#20; thanks @amknight)

### Security and Correctness

- Retry async JSON reads (`readJson`, `readJsonIfExists`, `tryReadJson`) up to five attempts with 50ms exponential backoff when the file is rotated mid-read by an atomic rename, and tag the underlying race as `FsSafeError("path-mismatch")` so callers can distinguish transient swaps from corruption. (#19; thanks @yetval)

## 0.2.7 - 2026-05-20

### Security and Correctness

- Restore best-effort Node write fallbacks when the Python helper is disabled or unavailable, preserving the `mode: "off"` contract while documenting the weaker POSIX same-UID race resistance compared with fd-relative helper commits.
- Harden DeepSec-reported archive staging and input pinning, secret and queue hardlink rejection, absolute output file validation, sidecar lock read failures, ClawSweeper dispatch trust checks, and scoped path defaults.

## 0.2.6 - 2026-05-17

### Security and Correctness

- Harden DeepSec-reported temp path handling, private secret writes, pinned helper commits, fallback mkdir writes, and dot-prefixed root relative paths against symlink, race, and relative-path edge cases.

## 0.2.5 - 2026-05-16

### Security and Correctness

- Reject Windows drive-letter paths on POSIX secure-file reads, missing path fallbacks under symlinked parents, swapped archive destination roots, broad domain ACL principals, and hardlinked sync store reads.
- Preserve top-level JSON `null` values in JSON stores and reject non-document JSON values such as top-level `undefined` before replacing files.
- Fix timeout error factories, root-relative path resolution at filesystem roots, dot-prefixed child names in root path helpers, durable queue directory modes, and pinned helper stale-worker events.

### Build

- Clean `dist` before package builds and make prepack fail deterministically when dependencies are missing instead of resolving new toolchain versions at publish time.

### Tests

- Added Clawpatch regression coverage for secure reads, path fallback validation, sync stores, archive destination races, Windows ACL classification, JSON writes/stores, durable queue modes, root create no-clobber behavior, and pinned helper worker replacement.

## 0.2.4 - 2026-05-14

### Features

- Add opt-in `remove-if-unchanged` stale lock recovery so callers can centralize compare-and-remove mechanics while keeping application-owned stale-owner policy.

## 0.2.3 - 2026-05-14

### Fixes

- Classify broad Windows ACL identities such as Anonymous Logon, Guests, Interactive, Local, and Network as world-equivalent so writable paths are not downgraded to group-writable findings.

## 0.2.2 - 2026-05-11

### Fixes

- Fall back to Node path guards for root stat and list operations on Windows, where the pinned Python helper is intentionally unsupported.

## 0.2.1 - 2026-05-08

### Fixes

- Align POSIX and Windows handling for literal `..`-prefixed write targets, preserve whitespace in direct home-relative path inputs, and run the check suite on Windows CI. (#14; thanks @sjf)
- Keep source prepack builds isolated from parent monorepo ambient type packages such as Bun typings. (#13; thanks @Kaspre)
- Let secret-file reads follow symlink paths through the pinned real target unless callers opt into `rejectSymlink: true`.

## 0.2.0 - 2026-05-07

### Features

- Add `writeExternalFileWithinRoot()` for libraries that require an output path while preserving caller-provided destination names. (#7; thanks @jesse-merhi)
- Add root JSON helpers and durable JSON queue helpers for file-backed work queues with pending, delivered, failed, and acknowledgement flows.
- Add `ensureAbsoluteDirectory()` for creating trusted absolute directory paths one segment at a time while rejecting symlink and non-directory components. (#12; thanks @jesse-merhi)
- Add a `durable: false` option to async atomic text and JSON writes so callers can preserve replace semantics while skipping temp-file and parent-directory fsync. (#9; thanks @sallyom)
- Add process-wide sidecar lock defaults while keeping JSON store locking opt-in per resource.

### Security and Correctness

- Harden Root fallback mutators, archive merges, private store reads/writes, durable queue ids, JSON fallback writes, sibling temp writes, temp filename sanitization, and trash moves against symlink-swap and path traversal edge cases.
- Centralize safe path segment validation, directory identity guards, guarded mkdir, and guarded mutation wrappers so filesystem helpers reuse the same race-resistant checks.
- Route archive ZIP staging, temp workspace sync reads, secret-file commits, and atomic move/replace fallbacks through shared pinned-read or guarded-write primitives without applying private-directory modes to public paths.
- Close guarded fallback write handles without following path names if post-write directory verification fails, avoiding descriptor leaks and unsafe cleanup in symlink-swap races.
- Harden temp filename prefixes, local-root reads, private store imports, durable queue reads, and regular-file byte caps against Deepsec-reported path traversal, symlink, and oversized-read races.
- Harden sidecar lock cleanup and stale-lock handling so stale third-party locks fail closed instead of being deleted by path.

### Compatibility

- Make cross-device move fallbacks reject source changes during staged copies and clean up only the source entries copied into the staged destination, preserving concurrent source additions or replacements instead of recursively deleting them.
- Preserve directory modes during cross-device directory moves.
- Preserve empty-directory pruning and broken-symlink trash moves across guarded fallback paths.
- Preserve sync file-store read policy errors for directory and hardlink validation failures.
- Preserve existing temp workspace leaf filename behavior for names such as `.env` and filenames containing spaces.
- Preserve public parent-directory modes when writing JSON, moving files across devices, and extracting archives.
- Make `prepack` portable on Windows and add the missing pnpm workspace `packages` field so package preparation succeeds consistently.

### Tests

- Added regression coverage for the filesystem race and traversal findings fixed in this release.
- Added Deepsec regression coverage for unsafe temp tokens, dangling symlinks, default read caps, private `copyIn()` races, symlinked queue entries, oversized queue entries, and fresh sidecar lock preservation.
- Added regression coverage for external-output traversal rejection, guarded cleanup, sidecar lock stale handling, move fallback cleanup, durable queue validation, sync read policy failures, and absolute-directory validation.
- Added a static filesystem-boundary primitive check that blocks reintroducing known raw copy/read/guard patterns.

### Docs and Tooling

- Added docs for external output writers, durable JSON queue helpers, sidecar lock defaults, boundary guardrails, and absolute-directory creation.
- Enable ClawSweeper dispatch for pull-request review automation.

## 0.1.2 - 2026-05-06

### Fixes

- Reject `fileStore()` and `fileStoreSync()` writes through symlinked parent directories so store commits cannot escape the configured root.

### Tests

- Increased filesystem edge coverage around secure temp fallback handling, sibling-temp cleanup, local-root resolution, file locks, and file identity checks.
- Prevented POSIX test runs from leaving Windows-style secure-temp fallback paths in the repository root.

### Docs

- Added missing docs pages for `@openclaw/fs-safe/config`, `@openclaw/fs-safe/store`, `@openclaw/fs-safe/advanced`, and `@openclaw/fs-safe/test-hooks`.
- Corrected path-helper docs for the synchronous `isPathInsideWithRealpath` and `safeRealpathSync` behavior.
- Included the Markdown docs in the npm package so README links resolve after install.

## 0.1.1 - 2026-05-06

### Fixes

- Preserve the caller's destination path spelling during staged archive merges so symlink-rebind checks catch alias races on macOS.
- Reject archive writes that gain a hardlink alias during post-write verification and clean up the destination file.

## 0.1.0 - 2026-05-06

### Features

- Added `root()` capability-style filesystem handles for root-bounded reads, writes, appends, moves, copies, directory listing, stat, mkdir, remove, JSON, streams, and existence checks.
- Added traversal, symlink, hardlink, alias, and post-open/post-write identity checks for untrusted relative paths.
- Added process-global Python helper configuration for stronger POSIX fd-relative mutation paths, with `auto`, `off`, and `require` modes.
- Added atomic file and directory replacement helpers with mode control, fsync options, retry handling, and copy-fallback behavior.
- Added JSON helpers, `fileStore()`, `jsonStore()`, private store mode, and file-backed temporary workspaces.
- Added secure absolute file reads, secret-file helpers, permissions inspection, Windows ACL helpers, and local-root readers.
- Added archive extraction and preflight helpers for ZIP/TAR with optional `jszip` and `tar` dependencies, size/count/path/link limits, and staged destination writes.
- Added file locks, async locks, bounded directory walking, install-path sanitizers, filename sanitization, regular-file helpers, trash moves, and advanced composition helpers.
- Added OpenClaw bypass-parity coverage, API coverage, a benchmark workflow, docs site generation, security docs, and coverage CI.
