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

The exports group into a handful of themes. Each documented helper has its own page; everything else is reference-only and tracked here.

### Path scopes and root paths

| Export | Page | Notes |
|---|---|---|
| `pathScope`, `PathScope`, `PathScopeOptions`, `PathScopeResolveOptions` | [path-scope.md](path-scope.md) | Absolute-path boundary helper with `Result`-shaped returns. |
| `ensureDirectoryWithinRoot` | – | Create a directory while enforcing the root boundary. |
| `resolvePathWithinRoot`, `resolvePathsWithinRoot` | – | Resolve one or many relative paths against a trusted root. |
| `resolveExistingPathsWithinRoot`, `resolveStrictExistingPathsWithinRoot` | – | Same, but require the targets to exist. |
| `resolveWritablePathWithinRoot` | – | Resolve a write target inside a root. |
| `resolveRootPath`, `resolveRootPathSync`, `ResolvedRootPath`, `ROOT_PATH_ALIAS_POLICIES`, `RootPathAliasPolicy` | – | Resolve a root directory honoring alias policy. |
| `resolvePathViaExistingAncestorSync` | – | Walk to an existing ancestor for paths whose tail does not yet exist. |

### Absolute path helpers

| Export | Page | Notes |
|---|---|---|
| `assertAbsolutePathInput` | – | Validate a caller-supplied absolute path string. |
| `ensureAbsoluteDirectory`, `EnsureAbsoluteDirectoryOptions`, `EnsureAbsoluteDirectoryResult` | – | Create a trusted absolute directory path one segment at a time, rejecting symlink or non-directory segments. |
| `canonicalPathFromExistingAncestor`, `findExistingAncestor` | – | Canonicalize without requiring the leaf to exist. |
| `resolveAbsolutePathForRead`, `resolveAbsolutePathForWrite`, `ResolvedAbsolutePath`, `ResolvedWritableAbsolutePath`, `AbsolutePathSymlinkPolicy` | – | Validate an absolute path against a symlink policy before opening. |

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
| `openRootFile`, `openRootFileSync`, `canUseRootFileOpen`, `matchRootFileOpenFailure`, related types | – | Low-level root-bounded open; rejects every symlink component by default, with `rejectSymlinks: false` for explicit in-root following. |
| `appendRegularFile`, `appendRegularFileSync`, `readRegularFile`, `readRegularFileSync`, `statRegularFile`, `statRegularFileSync`, `resolveRegularFileAppendFlags`, `AppendRegularFileOptions`, `RegularFileStatResult` | [regular-file.md](regular-file.md) | Type-checked regular-file I/O. |
| `sameFileIdentity`, `FileIdentityStat` | – | Compare two stats for same-inode equality. |
| `pathExists`, `pathExistsSync` | – | Boolean existence check that does not throw on `ENOENT`. |
| `assertNoSymlinkParents`, `assertNoSymlinkParentsSync`, `AssertNoSymlinkParentsOptions` | – | Reject paths whose ancestor chain contains symlinks. |
| `assertNoHardlinkedFinalPath`, `assertNoPathAliasEscape`, `PATH_ALIAS_POLICIES`, `PathAliasPolicy` | – | Hardlink/alias defense building blocks. |

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

### Local roots and file URLs

| Export | Page | Notes |
|---|---|---|
| `resolveLocalPathFromRootsSync`, `readLocalFileFromRoots`, related options/result types | [local-roots.md](local-roots.md) | Resolve a path against a list of allowed local roots. |
| `assertNoWindowsNetworkPath`, `basenameFromMediaSource`, `hasEncodedFileUrlSeparator`, `isWindowsDriveLetterPath`, `isWindowsNetworkPath`, `safeFileURLToPath`, `trySafeFileURLToPath` | – | Defensive helpers around Windows paths and `file://` URLs. |

### Install paths and filenames

| Export | Page | Notes |
|---|---|---|
| `safeDirName`, `safePathSegmentHashed`, `resolveSafeInstallDir`, `assertCanonicalPathWithinBase` | [install-path.md](install-path.md) | Build install-target directories from caller-supplied identifiers. |
| `sanitizeUntrustedFileName` | [filename.md](filename.md) | Coerce an untrusted string into a safe filename. |
| `resolveHomeRelativePath` | – | Expand `~`-prefixed paths. |

### Temp targets and sibling-temp writes

| Export | Page | Notes |
|---|---|---|
| `tempFile`, `withTempFile`, `TempFile`, `buildRandomTempFilePath`, `sanitizeTempFileName` | [temp.md](temp.md) | One-file temp primitive; prefer `tempWorkspace` from `@openclaw/fs-safe/temp` for the stable surface. |
| `writeSiblingTempFile`, `writeViaSiblingTempPath`, `WriteSiblingTempFileOptions`, `WriteSiblingTempFileResult` | – | Sibling-temp write building block used by `replaceFileAtomic`. |

### Permissions

| Export | Page | Notes |
|---|---|---|
| `formatPosixMode` | [permissions.md](permissions.md) | Format a POSIX mode bitmask. |
| `inspectWindowsAcl`, `summarizeWindowsAcl`, `formatWindowsAclSummary`, `parseIcaclsOutput`, `resolveWindowsUserPrincipal`, `createIcaclsResetCommand`, `formatIcaclsResetCommand`, `IcaclsResetCommandOptions`, `PermissionExec`, `WindowsAclEntry`, `WindowsAclSummary` | [permissions.md](permissions.md) | Windows ACL inspection and remediation. |

### Concurrency, timing, trash

| Export | Page | Notes |
|---|---|---|
| `createAsyncLock` | – | In-process async lock (separate from cross-process file locks). |
| `withTimeout` | [timing.md](timing.md) | Wrap a promise with a timeout that raises `FsSafeError("timeout")`. |
| `movePathToTrash`, `MovePathToTrashOptions` | – | Best-effort move to the platform trash. |

## Stability

Items in this surface can change shape between minor versions if a higher-level primitive needs them to. Pin to a minor version if you depend on a specific helper, or open an issue at the [GitHub repo](https://github.com/openclaw/fs-safe) and we will discuss promoting it to a focused subpath.

## Related pages

- [Root API](root.md) — built on top of these helpers.
- [Errors](errors.md) — every helper here surfaces failures as `FsSafeError`.
- [Security model](security-model.md) — what the underlying boundary checks promise.
