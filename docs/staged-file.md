---
title: Retained-directory staging
description: "Prepare and publish one file while retaining its original directory for abort cleanup."
---

# Retained-directory staging

`stageFileInDirectory()` from `@openclaw/fs-safe/advanced` prepares one file in
an existing directory and keeps that directory open until cleanup or disposal.
It requires the native binding on Linux or macOS, even in native mode `auto`.
Native off, an unavailable binding, or a binding without the required mechanism
fails before file creation. Windows is explicitly unsupported for this API.
Existing root, output, temp, lock, and durability APIs retain their documented
platform and fallback contracts.

```ts
import type { DirectoryReceipt } from "@openclaw/fs-safe/durability";
import {
  stageFileInDirectory,
  type PublishedFileReceipt,
} from "@openclaw/fs-safe/advanced";

// Call while holding the application's cooperative writer lock. The caller
// supplies its authorization, manager, snapshot, and fingerprint checks.
export async function publishReviewedUpdate(options: {
  directory: DirectoryReceipt;
  basename: string;
  bytes: Uint8Array;
  assertAuthorizedAndCurrent(): Promise<void>;
}): Promise<PublishedFileReceipt> {
  await options.assertAuthorizedAndCurrent();
  await using staged = await stageFileInDirectory({
    directory: options.directory,
    content: options.bytes,
  });
  await options.assertAuthorizedAndCurrent();
  await staged.assertCurrent();
  return await staged.publish(options.basename, { overwrite: true });
}
```

`await using` always disposes, including on exceptions. If both the body and
disposal fail, JavaScript preserves both errors in a `SuppressedError`. A
successful return means publication was observed and verified, not that a
separate application transaction committed. Application rollback and recovery
remain with the caller.

## API

```ts
function stageFileInDirectory(options: {
  directory: string | DirectoryReceipt;
  content: string | Uint8Array;
  mode?: number;
}): Promise<StagedFile>;

interface StagedFile extends AsyncDisposable {
  readonly receipt: StagedFileReceipt;
  assertCurrent(): Promise<void>;
  publish(basename: string, options: { overwrite: boolean }): Promise<PublishedFileReceipt>;
  cleanup(): Promise<StagedFileCleanupReceipt>;
}
```

Strings are UTF-8. `mode` is the requested **published** mode and defaults to
`0600`; exact final modes, including `000`, are supported. The unpublished file
stays at `0600` throughout preparation and any awaited application checks.
After rename succeeds and the published entry passes identity validation, the
owner applies the requested mode through its retained file descriptor and
synchronizes the file. No parent is created or chmodded.
Creation uses an exclusive, no-follow, close-on-exec open of a generated direct
child name. Writes use that descriptor. Inspection uses non-following metadata
operations, never a potentially blocking reopen of the leaf.

A supplied directory receipt must still match at admission. Its numeric
identity must be exactly representable; ambiguous identity fails closed.
Returned receipts are frozen descriptive snapshots, not mutable authority.
Changing a supplied receipt after admission cannot retarget the lifecycle.

`StagedFileReceipt` contains `directory` (`path`, `realPath`, and exact bigint
`identity.dev`/`identity.ino`), `temporaryBasename`, and the prepared file's
`identity` (`dev`, `ino`, `size`, `nlink`, `mtimeNs`, `ctimeNs` as bigint;
`mode`, `uid`, `gid` as numbers). This is a preparation-time snapshot of the
private stage: its mode is `0600`. Publication does not refresh this snapshot;
neither its mode nor its timestamps are a final-file fingerprint. No raw
descriptors are exposed.

`assertCurrent()` verifies the original pathname's directory identity and the
staged name against the retained file. A failed check does not disable cleanup.
After successful publication there is no staged name to check, so further
checks or publication reject. Cleanup closes the lifecycle; later checks and
publication reject before descriptor use. Rejected publication still carries its
phase, cause, and recorded publication outcome after closure. Concurrent calls
are serialized in invocation order, including cleanup and disposal. Repeated
cleanup returns the recorded outcome, or repeats the recorded error, without
touching descriptors.

## Publication and failure evidence

`publish()` requires an explicit boolean `overwrite` and one direct-child
basename. Empty, dot, dotdot, separators, absolute paths, NUL, control characters,
drive-relative spellings, and the stage's own name are rejected.

With `overwrite: false`, publication is genuine kernel no-replace rename; a
collision leaves both names unchanged and raises `FsSafeError("already-exists")`.
The stage may then be cleaned or published under another name. With
`overwrite: true`, publication is plain atomic replacement. Neither route
copies. Both source and destination resolve through the retained original
parent, with checks immediately before rename and after publication.

`PublishedFileReceipt` has `status: "published"`, `staged`, `basename`, and
`overwrite`. Its `staged` field retains the private preparation snapshot, not
final metadata. Errors from publication carry typed `StagedFileFailureDetails`
in `FsSafeError.details`, including `phase` and `publication`. Publication is
`not-published`, `published` (with its receipt), or `indeterminate` (with the
attempted basename and overwrite policy) if a rename error cannot establish
whether it committed. The underlying error remains in `cause`.

A parent move after the final pre-check cannot divert the rename to a
replacement parent. It can publish inside the moved original and then fail
post-validation. Successful rename is recorded before those checks; cleanup
never deletes or rolls back a published final name. Indeterminate publication
also preserves names for caller-directed recovery.

The same rule applies if applying the published mode, synchronizing, or a later
check fails: the error reports `published`, and cleanup preserves the final
name. The file may still have mode `0600` or may already have the requested
mode, depending on which operation failed. A `published` failure receipt records
rename success, not successful permission finalization.

## Cleanup guarantee and limits

If the temporary basename still names the object created by this lifecycle and
filesystem removal remains permitted, moving or replacing the actual parent
(or an ancestor) does not strand the unpublished temp. Cleanup resolves through
the retained original directory, even after `assertCurrent()` rejects drift.
Same-name sentinels in the replacement parent are not touched.

`StagedFileCleanupReceipt` records `temporaryBasename`, `publication`,
`resources` (`closed` or `close-failed`), and `status`:

| Status | Meaning |
|---|---|
| `removed` | The owned recorded name was unlinked through the retained directory. |
| `name-absent` | That name was absent in the original directory; this does not prove the inode has no other names. |
| `preserved` | An observed substitute or an indeterminate publication was left alone. |
| `failed` | Inspection or removal failed. |
| `not-needed` | Publication was recorded, or preparation failed before creating a file. |

Explicit cleanup returns preservation outcomes. Removal or close failures throw
an `FsSafeError` with the receipt in `details.cleanup` and underlying errors in
`cause`. Disposal also throws for preservation, so ignoring its return value
cannot hide incomplete cleanup. Setup failures preserve the original error;
when cleanup also fails, an aggregate cause retains both failures. Descriptors
are closed on every cleanup outcome, with no retry through recycled numbers.

This is **directory-relative targeting**, not expected-destination-inode/CAS
publication. Checking an identity before rename does not make rename CAS.
Likewise, the identity check followed by `unlinkat` is not an atomic conditional
unlink: an adversary can replace the leaf in that final syscall gap. Observed
substitutions are preserved, but this API does not guarantee recovery after
arbitrary child renames, permission revocation, I/O failure, or process death.
Keep application authorization, manager checks, snapshots, fingerprints,
cooperative locks, and conditional rollback.

Namespace cleanup is not crash durability. Staging retains the native writer's
file synchronization behavior, and publication synchronizes its directory
(with the existing `EPERM` exception); cleanup does not promise a durable unlink.
No successful receipt promises survival across a crash. See [Directory
durability](durability.md) when an application needs a separate durability proof.
`pinDirectory().assertCurrent()` and `.sync()` still require a current pathname;
they do not gain this cleanup authority.

## Related pages

- [Advanced composition](advanced.md)
- [Native architecture](native.md)
- [Security model](security-model.md)
