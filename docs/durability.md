---
title: Directory durability
description: "Pin directory identities, fsync publication metadata, and durably create nested directory paths."
---

# Directory durability

`@openclaw/fs-safe/durability` provides the directory side of crash-safe file
publication. Flushing a file does not guarantee that its containing directory
entry reached storage; callers that promise durable create, link, rename, or
unlink operations must also synchronize the affected directory.

```ts
import {
  ensureDurableDirectory,
  pinDirectory,
} from "@openclaw/fs-safe/durability";

const repository = await ensureDurableDirectory({
  directoryPath: "/srv/backups/sqlite",
  mode: 0o700,
});

const pinned = await pinDirectory(repository, { label: "backup repository" });
try {
  await publishSnapshot();
  const outcome = await pinned.sync();
  if (outcome.status === "unsupported") {
    // Decide at the product boundary whether this platform can weaken the promise.
  }
} finally {
  await pinned.close();
}
```

## Outcomes and failure semantics

`syncDirectory()` and `PinnedDirectory.sync()` return:

```ts
type DirectorySyncOutcome =
  | { status: "synced" }
  | { status: "unsupported"; code?: string };
```

POSIX synchronization failures propagate. Windows directory handles do not
portably support `FlushFileBuffers`; the known unsupported error family is
reported as `unsupported` after the pathname and pinned identity are checked
again. Directory-open access failures and other Windows I/O failures still
propagate.

`syncDirectoryBestEffort()` and `syncDirectoryBestEffortSync()` intentionally
discard both unsupported outcomes and failures. Use them only when the primary
write remains useful without a crash-durability promise.

## Pinned directories

`pinDirectory()` rejects final symlinks and non-directories. On POSIX it opens
with `O_DIRECTORY`, `O_NOFOLLOW`, and `O_NONBLOCK`, then compares the open
descriptor, pathname identity, and canonical path. `assertCurrent()` repeats
those checks. This prevents a pathname replacement from turning a later sync
into proof for a different directory.

Call `close()` in `finally`. Closing is idempotent; using a closed pin fails.

These checks intentionally reject a moved or replaced pathname. For one file's
abort cleanup through its original directory after a move, use the separate
[retained-directory staging lifecycle](staged-file.md). Its cleanup authority
does not weaken `pinDirectory().assertCurrent()` or `.sync()`, and namespace
cleanup is not proof of crash durability.

## Durable directory creation

`ensureDurableDirectory()` finds and pins the nearest existing ancestor,
creates the requested path, opens every new directory segment, and synchronizes
each new parent-to-child edge from the leaf upward. It returns the final
directory receipt plus the aggregate parent-sync outcome.

By default it uses fs-safe's guarded one-segment-at-a-time absolute-directory
creator. Advanced callers can pass `create` when directory creation needs
platform-specific ACLs or another product-owned policy. The callback owns the
safety of its mutations and must create exactly `directoryPath`; fs-safe
validates and pins every resulting segment before any synchronization is
accepted.

`expectedExistingIdentity` binds an existing target to an identity observed by
the caller before a separate permission or policy check. A missing or replaced
target fails with `FsSafeError("path-mismatch")`.

## Exclusive file publication

`publishFileExclusive()` materializes one file without clobbering an existing
target. It pins the source with `O_NOFOLLOW`, optionally verifies
`expectedSourceIdentity`, tries a hardlink first, then synchronizes the target
parent directory.

For example, a backup archive is complete before publication. If directory
sync fails, keeping that complete file is more useful than conditionally
deleting it by pathname:

```ts
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { publishFileExclusive } from "@openclaw/fs-safe/durability";

try {
  const result = await publishFileExclusive({
    sourcePath: stagedArchive,
    targetPath: finalArchive,
    strategy: "link-or-copy",
    onSyncFailure: "preserve",
    parentReceipt: backupDirectory,
  });
  recordDurableBackup(result.identity, result.directorySync);
} catch (error) {
  if (
    error instanceof FsSafeError &&
    error.details?.phase === "directory-sync" &&
    error.details.cleanup === "preserved"
  ) {
    recordCompleteButPossiblyNonDurableBackup(finalArchive, error.details);
  } else {
    throw error;
  }
}
```

### Strategies

| Strategy | Behavior | Native requirement |
|---|---|---|
| `link-required` | Create a same-filesystem hardlink or propagate the failure. | No; guarded JS `link` fallback remains. |
| `link-or-copy` | Try hardlink, then clone, Linux `copy_file_range`, then the JS byte loop for classified unsupported errors. | No; acceleration is optional. |
| `rename-noreplace` | Atomically move the source without replacing an existing target. Success consumes `sourcePath`. | Yes. |

`"link-required"` propagates an unsupported hardlink failure.
`"link-or-copy"` falls back only for `EPERM`, `EXDEV`, `ENOTSUP`,
`EOPNOTSUPP`, or `ENOSYS`; `isHardlinkFallbackError()` exposes that exact
classifier. The fallback copies from the pinned source into a `wx` target,
fsyncs it, and fences source and target identity and content before reporting
success. `parentReceipt`, when supplied, must name the target's direct parent.

With a native binding, the copy fallback first attempts a copy-on-write clone
(`fclonefileat` on macOS, `FICLONE` on Linux), then Linux
`copy_file_range`, and finally the existing JavaScript byte loop. Every route
creates the target exclusively, normalizes its mode to `0o600`, and goes
through the same post-copy identity and SHA-256 fencing. Hashing uses an async
native task when available, so large verification reads do not occupy the
JavaScript event loop.

On a clone-capable filesystem, publication of a large file becomes mostly a
metadata operation: data blocks are shared copy-on-write until either file is
modified. Clone support is filesystem- and mount-dependent, so callers must
not infer durability or physical independence from timing; an unsupported
clone or `copy_file_range` transparently continues down the fallback chain.

## Recoverable atomic-replace fallback

`replaceFileAtomic()` normally publishes a synchronized sibling temp with an
atomic rename. Some Windows filesystems and file owners reject that rename with
`EPERM` or `EEXIST`; `copyFallbackOnPermissionError: true` permits a non-atomic
copy fallback.

Callers that cannot tolerate a torn in-place fallback can add:

```ts
await replaceFileAtomic({
  filePath: statePath,
  content: nextState,
  syncTempFile: true,
  syncParentDir: true,
  copyFallbackOnPermissionError: true,
  copyFallbackRestore: "restore-original",
  maxRestoreBytes: 4 * 1024 * 1024,
  destinationHardlinks: "reject",
});
```

The existing regular-file destination is pinned before its link count is
accepted. Its original bytes are read within `maxRestoreBytes`, then the new
bytes are written and synchronized through the same descriptor. If a write or
sync tears, fs-safe rewrites the snapshot and fsyncs it before throwing. Inspect
`details.cleanup`: `"restored"` means the original bytes were put back and
synchronized; `"restore-failed"` means the replacement and recovery both
failed, so the destination must be treated as indeterminate. This is recovery
from a live-process I/O failure, not a transaction or a substitute for an
application backup protocol.

## Streaming SHA-256

`sha256File()` hashes either a pathname string or an already-open Node
`FileHandle`. A backup verifier can pin the file itself, compare its size, and
keep ownership of the handle:

```ts
import { open } from "node:fs/promises";
import { sha256File } from "@openclaw/fs-safe/durability";

const snapshot = await open(stagedArchive, "r");
try {
  const before = await snapshot.stat();
  const hash = await sha256File(snapshot);
  if (hash.bytes !== before.size || hash.digest !== manifest.sha256) {
    throw new Error("staged backup does not match its manifest");
  }
} finally {
  await snapshot.close();
}
```

The result is `{ bytes, digest }`, where `digest` is lowercase hexadecimal.
The handle overload never closes the caller's descriptor and uses positioned
reads, so it does not alter the descriptor's current offset. The path overload
rejects symbolic links and non-regular files, verifies the opened descriptor
still names the requested path, and closes its own handle. POSIX opens are
nonblocking, so a raced FIFO or device is rejected after descriptor inspection
rather than waiting for a writer.

When the optional binding is active, hashing runs as an async native task and
does not occupy the JavaScript event loop with digest updates. With native mode
`off`, or in `auto` when no binding loads, the fallback performs asynchronous
positioned reads in 64 KiB chunks but updates Node's `Hash` on the JavaScript
thread. Both paths stream constant-size buffers rather than loading the file
into memory. Native mode `require` keeps its usual fail-closed loader semantics.

If publication fails after this call created the target, it throws an
`FsSafeError` with a `details` receipt:

```ts
type PublishFileExclusiveFailureDetails = {
  phase:
    | "hardlink-create" | "hardlink-verify"
    | "copy-create" | "copy-verify"
    | "rename-create" | "rename-verify"
    | "directory-sync";
  targetCreated: boolean;
  targetIdentity?: { dev: number | bigint; ino: number | bigint };
  cleanup: "removed" | "preserved" | "unknown";
  directorySync?: { status: "failed"; code?: string };
};
```

`"removed"` means the path still matched the identity created by this call and
was unlinked (or was already absent). `"preserved"` means it was deliberately
retained—for example after a successful no-replace rename—or the pathname had
been replaced and therefore was not safe to remove. `"unknown"` means cleanup
could not verify or remove the created identity. Callers that run a second
application-level guard, such as SQLite snapshot validation, should branch on
this receipt instead of inferring ownership from path existence. The original
failure remains available as `cause`. Failures before target creation retain
their existing error shape and do not claim a cleanup result.

### Directory-sync failure policy

`onSyncFailure` applies only after target creation and content/identity fencing
have succeeded but synchronizing the containing directory throws:

```ts
type PublishFileExclusiveSyncFailurePolicy = "rollback" | "preserve";
```

A returned `{ status: "unsupported", code? }` is an explicit successful
publication outcome, not a thrown sync failure, so this option does not rewrite
or clean up that target.

- `rollback` is the default. fs-safe removes the target only if its current
  identity still matches the file created by this call. A replacement is never
  removed. The error reports `cleanup: "removed"`, `"preserved"`, or
  `"unknown"` and `directorySync: { status: "failed", code? }`.
- `preserve` never attempts that unlink. The error reports
  `targetCreated: true`, `cleanup: "preserved"`, the created identity, and the
  failed directory-sync outcome. The file is complete and fenced, but its
  directory entry is not proven crash-durable.

Choose `rollback` when the pathname must mean “durably committed” and a failed
commit should disappear from the live process view. Choose `preserve` when the
payload itself remains valuable—backup archives are the common case—and the
caller can record, retry, or independently validate durability. Neither choice
can make a failed directory sync succeed: rollback deletion is also not proven
durable, and a preserved name may disappear after a crash. Always use the
typed receipt rather than inferring ownership from `exists()`.

`rename-noreplace` always preserves its target after a successful rename,
because removing it would discard the source's only remaining name; its typed
failure receipt makes that explicit regardless of `onSyncFailure`.

`"rename-noreplace"` requires the native helper and atomically moves the
source to the target without replacement. A collision is reported as
`EEXIST`, both files remain unchanged, and a successful call returns
`method: "rename-noreplace"` after synchronizing the source and target parent
directories. Unlike the link/copy strategies, success consumes `sourcePath`.

## Scope

These primitives establish path identity and filesystem synchronization. One
`publishFileExclusive()` call is one no-clobber file materialization, not a
retention policy, multi-file transaction, or application commit protocol. They
do not decide application commit protocols, marker formats, permission policy,
or whether an unsupported platform is acceptable. Keep those decisions at the
owning product boundary.

## See also

- [Migrating to 0.5](migrating-to-0.5.md) — choosing a publication policy during upgrade.
- [Native architecture](native.md) — clone/copy/hash mechanisms and fallback guarantees.
- [Errors](errors.md) — typed operational failure handling.
