# Atomic writes

`@openclaw/fs-safe/atomic` re-exports the lower-level helpers that `root()`'s write methods are built on. Reach for them when you have an absolute path you trust and want sibling-temp + rename without setting up a `Root`, or when you need finer control over `fsync`, mode preservation, or pre-rename hooks.

```ts
import {
  replaceFileAtomic,
  replaceFileAtomicSync,
  writeTextAtomic,
  replaceDirectoryAtomic,
  movePathWithCopyFallback,
} from "@openclaw/fs-safe/atomic";
```

## `replaceFileAtomic` / `replaceFileAtomicSync`

Write `content` to a sibling temp file in the destination directory, apply the parent-directory and final file modes through verified descriptors, optionally `fsync` the file descriptor, optionally `fsync` the parent directory after rename, then atomically rename over the destination. No permission change follows a caller-supplied pathname.

On POSIX, the parent is opened with no-follow and directory-only flags, checked against its pre-open identity, and mode-adjusted through that descriptor. A replacement symlink is rejected rather than followed. If the directory cannot be opened for descriptor access, the operation fails closed instead of retrying by pathname. Windows does not enforce POSIX directory modes and Node cannot consistently open directory descriptors there, so `dirMode` is passed only to `mkdir`; no pathname `chmod` fallback is attempted.

Async replacements to the same destination are serialized inside the current process, so two overlapping `replaceFileAtomic()` calls do not interleave their temp-write/rename phases. Use a sidecar lock when multiple processes may write the same target.

```ts
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";

await replaceFileAtomic({
  filePath: "/srv/workspace/state.json",
  content: JSON.stringify(state, null, 2),
  mode: 0o600,
  syncTempFile: true,
  syncParentDir: true,
});
```

### Options

```ts
type ReplaceFileAtomicOptions = {
  filePath: string;                 // destination
  content: string | Uint8Array;
  dirMode?: number;                 // parent-directory mode (POSIX; default 0o700)
  mode?: number;                    // explicit mode for the new file (e.g. 0o600)
  preserveExistingMode?: boolean;   // copy mode from existing destination, when present
  tempPrefix?: string;
  renameMaxRetries?: number;
  renameRetryBaseDelayMs?: number;
  copyFallbackOnPermissionError?: boolean;
  copyFallbackRestore?: "restore-original" | "none"; // default: "none"
  maxRestoreBytes?: number;          // required with "restore-original"
  destinationHardlinks?: "reject";
  syncTempFile?: boolean;           // fsync(temp) before rename
  syncParentDir?: boolean;          // fsync(parent) after rename (POSIX only)
  beforeRename?: (params: { filePath: string; tempPath: string }) => Promise<void>;
  fileSystem?: ReplaceFileAtomicFileSystem; // injectable fs for tests
};
```

### `beforeRename`

Runs after the temp file is fully written and before the rename. Use it to take a backup snapshot, capture the about-to-be-replaced contents, or notify an observer:

```ts
await replaceFileAtomic({
  filePath: "/srv/workspace/config.toml",
  content: rendered,
  beforeRename: async ({ filePath }) => {
    await fs.copyFile(filePath, `${filePath}.bak`); // snapshot existing
  },
});
```

If `beforeRename` throws, the rename is skipped and the temp file is removed — the destination is unchanged.

### `EPERM` and copy fallback

On systems where `rename` fails with `EPERM`/`EEXIST`, pass
`copyFallbackOnPermissionError: true` to fall back to a non-atomic copy
replacement. The fallback removes the old destination, opens the replacement
with exclusive/no-follow flags where the platform supports them, and refuses
known symlink destinations so it does not write through a replaced destination
link.

Set `destinationHardlinks: "reject"` when an existing regular-file destination
must not have aliases. The policy reads `nlink` from a pinned destination
descriptor, not pathname metadata, before rename and rechecks it in the copy
fallback.

The default `copyFallbackRestore: "none"` preserves the existing fallback
contract: a failed copy can leave a partial destination. For state files where
preserving the old bytes is more important, choose `"restore-original"` and set
an explicit `maxRestoreBytes` memory budget. If the destination exists, fs-safe
snapshots it through a pinned descriptor, overwrites through that same
descriptor, and synchronizes the result. Any write or sync failure triggers a
restore and another sync through the same descriptor.

Restore failures are `FsSafeError("helper-failed")` values with typed
`details.cleanup` set to `"restored"` or `"restore-failed"`. An original larger
than `maxRestoreBytes` fails with `too-large` before mutation. A missing
destination has no original to restore and follows the exclusive-create copy
fallback.

### Sync variant

`replaceFileAtomicSync` accepts the same options shape, with the obvious removal of the async-only hooks. Use it inside synchronous boot paths or test setup code.

## `replaceDirectoryAtomic`

Atomically swap one directory's contents with another, using a temporary backup during the swap.

```ts
import { replaceDirectoryAtomic } from "@openclaw/fs-safe/atomic";

await replaceDirectoryAtomic({
  stagedDir: "/srv/workspace/staging/snapshot-2026-05-05",
  targetDir: "/srv/workspace/snapshot",
});
```

The helper renames `targetDir` to a generated backup path, renames `stagedDir → targetDir`, then removes the backup. If the second rename fails, it tries to restore the original target before rethrowing.

Use it when callers must see a whole staged tree at the target path. For single-file replacement, `replaceFileAtomic` is the right tool.

## `writeTextAtomic`

Atomic UTF-8 text write with the same secure defaults as `writeJson`: sibling
temp file, descriptor-bound mode setting and fsync, rename, and parent fsync.
It delegates to `replaceFileAtomic()` with a smaller call shape. Use it when
you do not need replacement hooks such as `beforeRename`, `preserveExistingMode`,
or custom copy-fallback policy.

```ts
import { writeTextAtomic } from "@openclaw/fs-safe/atomic";

await writeTextAtomic("/srv/workspace/rendered.md", rendered, {
  mode: 0o600,
  dirMode: 0o700,
  trailingNewline: true,
});
```

Options:

```ts
type WriteTextAtomicOptions = {
  mode?: number;             // file mode (default 0o600)
  dirMode?: number;          // mode for parent dirs created on demand
  trailingNewline?: boolean; // append "\n" if missing
  durable?: boolean;         // default true; false skips temp/parent fsync
};
```

`durable: false` keeps the sibling-temp replace/rename behavior but skips the
temp-file and parent-directory `fsync` calls. Use it only for reconstructible
metadata where lower latency matters more than crash-durability.

## `movePathWithCopyFallback`

Rename a path. If the rename fails with `EXDEV` (cross-device), fall back to
copying into a staged sibling path, renaming that staged path into place, and
then removing only the source entries that were copied. The fallback avoids
buffering regular files into memory and does not tighten the destination parent
directory mode.

```ts
import { movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";

await movePathWithCopyFallback({
  from: "/srv/cache/blob.bin",
  sourceHardlinks: "reject",
  to: "/srv/persistent/blob.bin",
});
```

Use it when source and destination might live on different filesystems (containers, tmpfs, separate volumes).
`sourceHardlinks: "reject"` performs a recursive preflight capped at 50,000
entries before any mutation. Because link count and rename cannot be one atomic
portable operation, this mode always commits a fresh inode/tree through the
staged-copy route, even on one filesystem. Each regular file is checked again
after open and after copying, so a post-scan hardlink cannot become the
published target. A hardlink fails with `FsSafeError("hardlink")`; exceeding
the preflight cap fails with `FsSafeError("too-large")`.
If another writer changes source entries during the fallback, the staged copy
throws `ESTALE` before commit when possible. If the destination has already
been committed, cleanup still preserves the changed source entries and throws
`ESTALE`.

## Difference from `root()`

| `Root` methods | `atomic` helpers |
|---|---|
| Take relative paths, bound to a `rootDir`. | Take absolute paths, no boundary. |
| Throw `FsSafeError` with `code`. | Throw `FsSafeError` *or* the underlying `NodeJS.ErrnoException`, depending on failure point. |
| Atomicity, mode, hooks, fsync are sane defaults. | Caller controls all of the above. |
| `mkdir`, identity check, hardlink reject built in. | No root boundary; `movePathWithCopyFallback` has explicit `sourceHardlinks` policy, while other helpers expose their own narrower checks. |

Use `Root` when the path is caller-controlled. Use `atomic` when the path is fully under your control and you want explicit knobs.

## Test injection

Both `replaceFileAtomic` and `replaceFileAtomicSync` accept a `fileSystem` option that overrides the small set of `fs` calls they make. Pass a stub in unit tests to assert order, simulate `EPERM`, or capture the temp filename:

```ts
const ops: string[] = [];
await replaceFileAtomic({
  filePath: "/tmp/x",
  content: "hi",
  fileSystem: {
    promises: {
      ...realFs,
      writeFile: async (...args) => { ops.push("write"); return realFs.writeFile(...args); },
      rename: async (...args) => { ops.push("rename"); return realFs.rename(...args); },
    },
  },
});
```

The synchronous injectable interface has one optional descriptor-mode operation:

```ts
type ReplaceFileAtomicSyncFileSystem = {
  // other required operations omitted
  fchmodSync?: typeof import("node:fs").fchmodSync;
};
```

The async interface already requires `open()`, whose `FileHandle` supplies `chmod()`, so injecting `node:fs` or another conforming adapter needs no new async member. On POSIX, that `open()` must support no-follow directory descriptors as Node does. A custom synchronous filesystem that passes `mode`, `dirMode`, or `preserveExistingMode` must supply `fchmodSync`; omission fails before any file or directory is created and never falls back to a pathname `chmod`. Existing synchronous adapters that request none of those options may omit it. Injecting plain `node:fs` supports explicit file and directory modes. Copy fallback applies the file mode through its pinned destination descriptor as well, preserving exact modes despite the process umask.

## See also

- [`root()`](root.md) — when you want method-style writes with the boundary baked in.
- [JSON files](json.md) — JSON/text helpers built on sibling-temp replacement.
- [Temp workspaces](temp.md) — for staging-then-swap directory builds.
- [Errors](errors.md) — code union for failures.
