---
title: Advanced
description: "Lower-level composition helpers under @openclaw/fs-safe/advanced. Less stable than focused public subpaths."
---

# `@openclaw/fs-safe/advanced`

Composition primitives that OpenClaw uses to build higher-level APIs. They are public — semver applies — but treated as a less stable surface than the focused subpaths (`root`, `json`, `store`, `temp`, `archive`, `durability`, `errors`). Reach for them only when you are building a primitive of your own and the focused subpaths do not cover it.

```ts
import {
  pathScope,
  withTimeout,
  pathExists,
  sanitizeUntrustedFileName,
  // …
} from "@openclaw/fs-safe/advanced";
```

## What lives here

The exports group into a handful of themes. Documented helpers link to their contract below or a dedicated page; everything else is reference-only and tracked here.

### Path scopes and root paths

| Export | Page | Notes |
|---|---|---|
| `pathScope`, `PathScope`, `PathScopeOptions`, `PathScopeResolveOptions` | [path-scope.md](path-scope.md) | Absolute-path boundary helper with `Result`-shaped returns. |
| `ensureDirectoryWithinRoot` | [path-scope.md](path-scope.md#ensuredir-rel-options) | Create a directory while enforcing the root boundary; same result contract as `pathScope().ensureDir()`. |
| `resolvePathWithinRoot`, `resolvePathsWithinRoot` | – | Resolve one or many relative paths against a trusted root. |
| `resolveExistingPathsWithinRoot` | – | Validate existing regular files inside the root, while allowing missing paths. |
| `resolveStrictExistingPathsWithinRoot` | – | Require every target to exist as a regular non-symlink file inside the root. |
| `resolveWritablePathWithinRoot` | – | Resolve a write target inside a root. |
| `resolveRootPath`, `resolveRootPathSync`, `ResolvedRootPath`, `ROOT_PATH_ALIAS_POLICIES`, `RootPathAliasPolicy` | – | Resolve a root directory honoring alias policy. |
| `resolvePathViaExistingAncestorSync` | – | Walk to an existing ancestor for paths whose tail does not yet exist. |
| `resolvePathPrefixSync`, `ResolvedPathPrefix` | [path-prefix.md](path-prefix.md) | Follow physical symlink targets and return a canonical existing prefix with the raw missing suffix; propagate uncertain resolution failures. |
| `probePathCaseInsensitiveSync`, `ProbePathCaseOptions` | [path-case.md](path-case.md) | Observe local ASCII-case behavior with explicit read-only mode and owned temporary-probe cleanup. |
| `probePathSuffixAliasesSync`, `ProbePathSuffixAliasesOptions` | [path-suffix-aliases.md](path-suffix-aliases.md) | Observe selected missing suffix aliases with bounded temporary directory probes; ambiguity, dynamic budget exhaustion, or incomplete cleanup returns `undefined`. |

`ensureDirectoryWithinRoot({ rootDir, requestedPath, scopeLabel, defaultDirName?, mode? })`
returns `{ ok: true, path }` or `{ ok: false, error: string, diagnostic?: FsSafeError }`.
It does not throw filesystem failures: operational failures carry a
`helper-failed` diagnostic with the original `cause` and a bounded, escaped
message naming the native code/syscall when available. Policy failures omit
`diagnostic`. Missing parents already created before a failure remain in place.
The diagnostic contract is specific to directory preparation, not the other
root-path result helpers.

### Absolute path helpers

| Export | Page | Notes |
|---|---|---|
| `assertAbsolutePathInput` | – | Validate a caller-supplied absolute path string. |
| `ensureAbsoluteDirectory`, `EnsureAbsoluteDirectoryOptions`, `EnsureAbsoluteDirectoryResult` | – | Create a trusted absolute directory path one segment at a time, rejecting symlink or non-directory segments. |
| `canonicalPathFromExistingAncestor`, `findExistingAncestor` | – | Canonicalize without requiring the leaf to exist. |
| `resolveAbsolutePathForRead`, `resolveAbsolutePathForWrite`, `ResolvedAbsolutePath`, `ResolvedWritableAbsolutePath`, `AbsolutePathSymlinkPolicy` | – | Validate an absolute path against a symlink policy before opening; strict writes reject dangling symlink components rather than treating them as missing. |

`ensureAbsoluteDirectory()` is for paths you already intend to trust as absolute
locations, such as a configured output root. It does not enforce a root boundary;
use `pathScope().ensureDir()` or `ensureDirectoryWithinRoot()` when the caller
supplies a path that must stay under a root.

The helper returns `{ ok: false, code, error }` for path-policy failures such as
relative paths, symlinks, non-directories, or directory swaps during creation.
Operational filesystem failures such as permissions or I/O errors are rethrown.

### Files and identity

| Export | Page | Notes |
|---|---|---|
| `readFileDescriptorBounded`, `readFileDescriptorBoundedSync`, `readFileHandleBounded` | – | Incremental whole-file reads for already-open descriptors/handles. They consume at most `maxBytes + 1`, do not close the input, and throw `FsSafeError("too-large")` on overflow. |
| `createDirectory`, `createDirectorySync`, `createFileSync` | [Exclusive leaf creation](creation.md) | Create one exclusive entry under an existing trusted parent, optionally with private permissions; file creation returns an owned disposable descriptor. |
| `readFileWindowFully`, `readFileWindowFullySync`, `ReadFileWindowOptions` | [positional-read.md](positional-read.md) | Fill a caller-owned buffer at an explicit file position, completing short reads and returning the EOF count without moving or closing the descriptor. |
| `writeFileWindowFully`, `WriteFileWindowOptions` | [Borrowed-handle writes](#borrowed-handle-writes) | Write all supplied bytes at an explicit position or the current cursor, completing short writes with cancellation and per-write authority checks. |
| `copyFileHandle`, `copyFileDescriptorSync`, `CopyFileHandleOptions` | [copy.md](copy.md#borrowed-filehandle-transfers) | Copy caller-owned regular files through async handles or sync descriptors from position zero with byte limits and synchronous callbacks; preserves cursors and leaves publication and cleanup to the caller. |
| `sameFileContentsSync`, `SameFileContentsOptions` | [Exact file comparison](file-contents.md) | Compare borrowed regular-file descriptors byte for byte through EOF with bounded memory and an optional per-file byte limit, preserving both cursors and lifetimes. |
| `overwriteFileHandle`, `OverwriteFileHandleOptions` | [in-place-write.md](in-place-write.md) | Overwrite a borrowed read/write handle with prefix-only preparation and best-effort rollback; preserves its inode, cursor, and caller-owned lifetime. |
| `openRootFile`, `openRootFileSync`, `canUseRootFileOpen`, `matchRootFileOpenFailure`, related types | – | Low-level root-bounded open; rejects every symlink component by default, with `symlinks: "follow-parents-within-root"` for contained parent aliases or `"follow-within-root"` for final links too. |
| `appendRegularFile`, `appendRegularFileSync`, `readRegularFile`, `readRegularFileSync`, `statRegularFile`, `statRegularFileSync`, `resolveRegularFileAppendFlags`, `AppendRegularFileOptions`, `RegularFileStatResult` | [regular-file.md](regular-file.md) | Type-checked regular-file I/O. |
| `retainFileInDirectory`, `RetainedFile`, related receipt/result types | [Retained Windows files](retained-file.md) | Existing-file native handle custody and explicit removal; local NTFS, producer authority required, no persistence guarantee. |
| `sameFileIdentity`, `FileIdentityStat` | – | Compare two stats for same-inode equality. |
| `readDirectoryIdentity`, `assertDirectoryIdentitySync`, `DirectoryIdentity` | [directory-identity.md](directory-identity.md) | Observe exact bigint directory identity and synchronously check a caller-selected path, optionally retaining its canonical path. |
| `pathExists`, `pathExistsSync` | – | Boolean existence check that does not throw on `ENOENT`. |
| `assertNoSymlinkParents`, `assertNoSymlinkParentsSync`, `AssertNoSymlinkParentsOptions` | – | Reject paths whose ancestor chain contains symlinks, inspecting raw segments before `..` normalization. A `..` may undo an inspected real directory, but cannot leave the root or undo an allowed root-child symlink. Raw paths outside the root that normalize inside are rejected. |
| `assertNoHardlinkedFinalPath`, `assertNoPathAliasEscape`, `PATH_ALIAS_POLICIES`, `PathAliasPolicy` | – | Hardlink/alias defense building blocks. |

`pathExists()` and `pathExistsSync()` intentionally retain ordinary `stat`
semantics and are not caller-path admission boundaries. Validate an untrusted
path with the boundary appropriate to the operation before using these
existence probes.

`openRootFile()` and `openRootFileSync()` compare exact bigint identities before
open, on the retained descriptor, and on the current resolved path. Their `stat`
receipts remain numeric. Custom `ioFs` adapters must honor `{ bigint: true }` for
`lstatSync` and `fstatSync`; numeric identity responses fail validation. Unknown
Windows identities receive one re-inspection without reopening, then fail
validation if still unknown.

On Windows, these existing-object readers retain their historical support for a
leading drive-relative spelling such as `C:existing.txt`: it is anchored to that
drive before confinement and namespace admission. Additional colons remain in
the anchored spelling, so alternate-stream and directory-index aliases are still
rejected before opening.

These adapters also capture the canonical root directory's exact bigint identity
before component traversal. Immediately before transferring descriptor ownership,
they check that root, freshly canonicalize the consumed pathname, admit the fresh
spelling under the captured root, compare a no-follow canonical-leaf observation
with the retained descriptor, and check the root again. Boundary or identity drift
is a validation failure and triggers one descriptor-close attempt. If cleanup also
fails, the selected admission failure result is preserved. Successful opens transfer
descriptor ownership to the caller. A custom `ioFs` supplies
these observations; the built-in adapter uses fs-safe's native realpath wrapper.
On Windows, the built-in adapter binds native root spelling before traversal,
including supplied `rootRealPath`, and returns that spelling in its root receipt.
This is an operation-local detection fence, not atomic confinement against a peer
that can keep racing pathname bindings.

The explicit `symlinks` policy takes precedence over the existing `rejectSymlinks`
boolean. Without `symlinks`, `rejectSymlinks: false` retains its existing behavior
of following contained links, and omission still rejects all symlink components.

The bounded descriptor helpers cap their initial speculative allocation at
16 MiB plus the overflow-probe byte, even when a file reports a much larger
size. Regular files up to that size can return from one read without copying
chunks; larger files and short reads continue incrementally under the same
byte limit. Continuation buffers grow only after filling with actual bytes,
up to the byte budget plus its probe; file-size hints cannot force that growth.
Unknown-size inputs start with at most 64 KiB. This avoids per-chunk copies and
a final concatenation when a file exceeds the initial allocation.
Regular files that report a size of zero, such as virtual files, continue through
positive short reads until actual EOF or byte-limit overflow.

The bounded descriptor helpers start at the descriptor's current offset and
leave ownership with the caller. They are intended for the second half of a
safe read: first open and validate the path using the boundary appropriate to
your application, then read the already-pinned descriptor without trusting a
possibly stale size check.

```ts
import fs from "node:fs";
import { readFileDescriptorBoundedSync } from "@openclaw/fs-safe/advanced";

const fd = fs.openSync(filePath, "r");
try {
  const bytes = readFileDescriptorBoundedSync(fd, 256 * 1024);
  consume(bytes);
} finally {
  fs.closeSync(fd);
}
```

For the symlink-parent guards, `allowMissing` defaults to `true` and permits the
walk to stop only at an actually absent suffix. When an existing non-directory
component is followed by another segment, both helpers throw
`FsSafeError("not-file")` before the platform can expose that state as POSIX
`ENOTDIR` or Windows `ENOENT`.

#### Borrowed-handle writes

Use `writeFileWindowFully()` when you already own a writable file handle and
need to complete a byte-window write, including positive short writes.

```ts
import { root } from "@openclaw/fs-safe";
import { writeFileWindowFully } from "@openclaw/fs-safe/advanced";

const workspace = await root("/srv/workspace");
await using opened = await workspace.openWritable("record.bin", { writeMode: "update" });
await writeFileWindowFully(opened.handle, Buffer.from([1, 2, 3]), 16);
```

```ts
type WriteFileWindowOptions = {
  signal?: AbortSignal;
  assertBeforeMutation?: () => void;
};

function writeFileWindowFully(
  handle: import("node:fs/promises").FileHandle,
  bytes: Uint8Array,
  position: number | null,
  options?: WriteFileWindowOptions,
): Promise<void>;
```

A numeric `position` writes at that offset without moving the handle's cursor.
It and the exclusive window end (`position + bytes.byteLength`) must be
non-negative safe integers; invalid ranges throw `RangeError` before mutation.
Bounds come from the intrinsic byte view, ignoring shadowed metadata properties.
Pass `null` to write at and advance the current cursor. Each syscall writes at
most 512 KiB. A write that makes no progress throws
`FsSafeError("helper-failed")`; filesystem errors propagate unchanged.
Empty input still validates the range and checks cancellation, but performs no
I/O and does not call `assertBeforeMutation`.

The caller must supply a writable regular-file handle, opened **without append
mode** for numeric positions. Some operating systems ignore positioned-write
offsets on append handles, and this helper does not inspect file type or open
flags. Opening, path admission, identity checks, and closing remain the caller's
responsibility. Keep the handle open and the borrowed bytes unchanged, attached,
and accessible until the promise settles; avoid concurrent I/O when it can change
the intended contents or shared cursor. The helper does not acquire a lock.

`assertBeforeMutation` runs synchronously immediately before every write,
including short-write retries. A thrown value propagates unchanged; a Promise or
thenable return rejects with `TypeError` before that write. The callback must not
modify the payload or handle. It does not run as a final completion check; the
caller owns any authority check before later publication or other mutations.

`signal` is checked at admission, before and after each authority callback, and
after each pending write settles. Cancellation waits for an in-flight write and
then rejects with the signal's reason without starting another syscall. If that
write fails, its filesystem error or zero-progress failure takes precedence over cancellation. Already
written bytes remain changed; there is no rollback or hidden write after the
promise settles.

The helper neither truncates an existing suffix nor changes permissions,
synchronizes, or closes the handle. Callers retain those responsibilities and
any wider transaction policy. For complete replacement with best-effort
rollback, use [`overwriteFileHandle()`](in-place-write.md); for root-bounded
atomic replacement, use [`Root.write()`](writing.md).

### Local roots and file URLs

| Export | Page | Notes |
|---|---|---|
| `resolveLocalPathFromRootsSync`, `readLocalFileFromRoots`, related options/result types | [local-roots.md](local-roots.md) | Resolve a path against a list of allowed local roots. |
| `assertNoWindowsNetworkPath`, `basenameFromMediaSource`, `hasEncodedFileUrlSeparator`, `isWindowsDriveLetterPath`, `isWindowsNetworkPath`, `safeFileURLToPath`, `trySafeFileURLToPath` | – | Defensive helpers around Windows paths and `file://` URLs. |

### Install paths and filenames

| Export | Page | Notes |
|---|---|---|
| `safeDirName`, `safePathSegmentHashed`, `safePathSegmentHashedV2`, `resolveSafeInstallDir`, `assertCanonicalPathWithinBase` | [install-path.md](install-path.md) | Build install-target directories; use V2 for untrusted identifier mappings. |
| `sanitizeUntrustedFileName` | [filename.md](filename.md) | Coerce an untrusted string into a safe filename. |
| `resolveHomeRelativePath` | – | Expand a leading `~` before resolving `.` and `..`; tildes inside relative paths stay literal. |

### Temp targets and sibling-temp writes

| Export | Page | Notes |
|---|---|---|
| `stageFileInDirectory`, `StagedFile`, `StagedFileReceipt`, `PublishedFileReceipt`, `StagedFilePublication`, `StagedFileCleanupReceipt`, `StagedFileFailureDetails` | [staged-file.md](staged-file.md) | Native-required Linux/macOS lifecycle retaining the original directory for abort cleanup. |
| `retainSymlinkInDirectory`, `StagedSymlink`, `StagedSymlinkExpected`, `StagedSymlinkReceipt`, `PublishedSymlinkReceipt`, `StagedSymlinkPublication`, `StagedSymlinkRemoval`, `StagedSymlinkCleanupReceipt`, `StagedSymlinkFailureDetails` | [staged-symlink.md](staged-symlink.md) | Native-required retained symlink identity, no-replace publication and explicit recovery; never same-target ownership adoption. |
| `tempFile`, `withTempFile`, `TempFile`, `buildRandomTempFilePath`, `sanitizeTempFileName` | [temp.md](temp.md) | One-file temp primitive; prefer `tempWorkspace` from `@openclaw/fs-safe/temp` for the stable surface. |
| `writeSiblingTempFile`, `writeViaSiblingTempPath`, `WriteSiblingTempFileOptions`, `WriteSiblingTempFileResult` | – | Callback-produced file staging: verified sibling publication or private-workspace copy through a root. |

### Permissions

| Export | Page | Notes |
|---|---|---|
| `formatPosixMode` | [permissions.md](permissions.md) | Format a POSIX mode bitmask. |
| `inspectWindowsAcl`, `summarizeWindowsAcl`, `formatWindowsAclSummary`, `parseIcaclsOutput`, `resolveWindowsUserPrincipal`, `createIcaclsResetCommand`, `formatIcaclsResetCommand`, `IcaclsResetCommandOptions`, `PermissionExec`, `WindowsAclEntry`, `WindowsAclSummary` | [permissions.md](permissions.md) | Windows ACL inspection and remediation. |

### Concurrency, timing, trash

| Export | Page | Notes |
|---|---|---|
| `createAsyncLock` | – | In-process async lock (separate from cross-process file locks). |
| `withTimeout` | [timing.md](timing.md) | Wrap a promise with a timeout that raises `Error` by default, or an error supplied by `createError`. |
| `movePathToTrash`, `MovePathToTrashOptions` | – | Best-effort move to the platform trash. Allowed roots constrain the real parent of the moved entry, including symlinks; the referent is not moved. Parent identity is rechecked before mutation. |

## Stability

Items in this surface can change shape between minor versions if a higher-level primitive needs them to. Pin to a minor version if you depend on a specific helper, or open an issue at the [GitHub repo](https://github.com/openclaw/fs-safe) and we will discuss promoting it to a focused subpath.

## Related pages

- [Root API](root.md) — built on top of these helpers.
- [Errors](errors.md) — shared filesystem error codes; generic timing helpers retain their documented error types.
- [Security model](security-model.md) — what the underlying boundary checks promise.
