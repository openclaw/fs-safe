---
title: Migrating to 0.5
description: "Ordered checklist for moving a 0.4 consumer from the Python helper to native mode and adopting the 0.5 API contracts."
---

# Migrating from 0.4 to 0.5

Use this checklist from top to bottom. Version 0.5 replaces the Python worker,
changes the default archive mode policy, and adds explicit contracts for
publication, walking, locks, secrets, and native-only features. Nothing in this
guide requires a Rust toolchain: supported native packages are prebuilt and
optional.

## 1. Update the package and runtime

- Run on Node.js 22 or newer.
- Update `@openclaw/fs-safe` and regenerate every lock or shrinkwrap file your
  deployment consumes.
- Keep optional dependencies enabled if you want automatic native loading and
  JavaScript ZIP/TAR support. An install that omits optional packages can still
  import fs-safe, but native-only features and missing JS archive decoders fail
  with actionable errors.

## 2. Replace Python helper configuration

Change startup configuration before the first filesystem operation:

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

configureFsSafeNative({ mode: "auto" });
```

| Remove from 0.4 | Use in 0.5 |
|---|---|
| `configureFsSafePython({ mode })` | `configureFsSafeNative({ mode })` |
| `FS_SAFE_PYTHON_MODE` | `FS_SAFE_NATIVE_MODE` |
| `OPENCLAW_FS_SAFE_PYTHON_MODE` | `OPENCLAW_FS_SAFE_NATIVE_MODE` |
| `pythonPath`, `FS_SAFE_PYTHON`, pinned-Python aliases | Nothing; native packages do not use an interpreter |

The old names warn once and map `auto`, `off`, or `require` so a shipped 0.4
deployment does not silently change policy. Interpreter paths are ignored and
Python is never spawned. Treat that warning as an upgrade diagnostic, not as a
second supported helper path.

Choose the production mode deliberately:

- `auto` keeps guarded JavaScript fallbacks when a binding is unavailable.
- `off` makes fallback testing deterministic.
- `require` fails with `helper-unavailable` instead of weakening an operation
  that expected native support.

See [Native helper policy](native-helper.md) and
[Native architecture](native.md).

## 3. Audit every archive call

The 0.5 default is `entryModes: "clamp"`. Directories become `0o755`; files
become `0o644` or `0o755` when owner-execute was archived. Set
`entryModes: "preserve"` explicitly only if your 0.4 consumer intentionally
relied on archived rwx bits. Setuid, setgid, sticky bits, and archived ownership
are never restored.

```ts
await extractArchive({
  archivePath: uploadPath,
  destDir: restoreRoot,
  timeoutMs: 30_000,
  entryModes: "clamp",
  entryFilter: (entry) =>
    entry.path.startsWith("snapshot/cache/") ? "skip" : "extract",
  onFiltered: "skip-entry",
  limits: {
    maxArchiveBytes: 256 * 1024 * 1024,
    maxEntries: 50_000,
    maxExtractedBytes: 512 * 1024 * 1024,
    maxEntryBytes: 256 * 1024 * 1024,
    maxMetaEntryBytes: 1024 * 1024,
    maxEntryPathComponents: 64,
  },
});
```

Returning `"skip"` rejects the archive unless `onFiltered: "skip-entry"` is
explicit. Zstd and bzip2 TAR are native-only; ZIP, TAR, and gzip retain guarded
JavaScript implementations. Catch `ArchiveLimitError` by its code, including
`archive-entry-path-components-exceeds-limit` for deep implicit-directory
attacks. See [Archive extraction](archive.md).

## 4. Pick a publication failure policy

`publishFileExclusive()` never replaces an existing target. Choose a strategy
and decide what a post-create directory-sync failure means to your application:

```ts
await publishFileExclusive({
  sourcePath: stagedArchive,
  targetPath: finalArchive,
  strategy: "link-or-copy",
  onSyncFailure: "preserve",
});
```

`rollback` is the default: an unchanged target created by this call is removed
when directory sync throws. `preserve` keeps a complete but possibly
non-durable target and reports `cleanup: "preserved"` plus
`directorySync: { status: "failed", code? }` in the typed error. Backup
archives commonly need `preserve`; transactional protocols that expose only
durably committed names usually want `rollback`. See
[Directory durability](durability.md).

## 5. Replace recursive scans with an explicit walk policy

Use `Root.walk()` for caller-controlled relative paths. Every examined entry
consumes the budget even when filtered:

```ts
for await (const entry of workspace.walk("memory", {
  maxDepth: 12,
  maxEntries: 50_000,
  symlinkPolicy: "skip",
  entryFilter: (entry) =>
    entry.kind === "directory" && entry.relativePath.endsWith("/.git")
      ? "skip-subtree"
      : "include",
  onDirectoryError: "skip-and-report",
})) {
  if (entry.kind === "directory-error") {
    reportIncompleteSubtree(entry.relativePath, entry.error);
    continue;
  }
  indexEntry(entry);
}
```

The default directory-error policy remains `throw`. See
[Directory walking](walk.md).

## 6. Adopt the focused concurrency and secret APIs

- Use `acquireFileLockSync()` only in synchronous boot or migration code; retry
  waits block the thread. Request-serving paths should use `withFileLock()`.
- Remove `allowReentrant` from async file-lock options. Same-process contention
  now follows the ordinary retry and timeout policy. Locked and unlocked
  `jsonStore` mutations serialize by canonical file path; nested same-file
  mutations from an update callback fail with `store-reentrant-update`, so
  return the complete value from the outer callback instead.
- Use `createSecretFileAtomic()` for first-writer-wins credentials and catch
  `secret-exists`; use `writeSecretFileAtomic()` only when replacement is the
  intended protocol.
- Async `readSecretFile()` is strict; `tryReadSecretFile()` returns `undefined`
  only for missing or blank content and still rejects suspicious files.
- Check `tempWorkspace.cleanup()` results when ownership matters;
  `identity-mismatch` deliberately preserves a replacement path.

See [File locks](sidecar-lock.md), [Secret files](secret-file.md), and
[Temp workspaces](temp.md).

## 7. Gate native-only features

`createPrivateDirectory()` is Windows-only and native-only because a pathname
fallback cannot promise the same creation-time DACL. Zstd/bzip2 extraction and
`strategy: "rename-noreplace"` are also native-only. Test the unavailable path
instead of assuming installation always succeeds.

## 8. Run both behavior families in CI

For each consumer workflow that matters:

1. Run once with `FS_SAFE_NATIVE_MODE=auto` on every supported OS.
2. Run once with `FS_SAFE_NATIVE_MODE=off` to prove the JavaScript fallback.
3. Run native-required or native-only cases with `FS_SAFE_NATIVE_MODE=require`.
4. Exercise archive traversal/link/depth limits, publication sync failure, and
   partial-walk reporting with production-shaped fixtures.

For downstream staging and backup consumers:

- [ ] Replace private whole-file hashing with `sha256File(path | FileHandle)`
      from `durability`; native mode keeps digest work off the event loop and
      the JavaScript fallback remains streaming.
- [ ] If Windows trust policy depends on exact principals, consume
      `readOwnerAndDacl()` from `permissions`, reject incomplete/null/remote
      descriptors as your policy requires, skip inherit-only ACEs where
      appropriate, and apply the application's own SID allowlist.

The [Testing](testing.md) page documents the test hooks and mode setup used by
fs-safe itself.
