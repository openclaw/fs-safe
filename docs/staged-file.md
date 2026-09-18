---
title: Owned file staging
description: "Prepare, publish, and clean up one owned file with explicit publication and targeting receipts."
---

# Owned file staging

`stageFileInDirectory()` from `@openclaw/fs-safe/advanced` prepares one file in
an existing directory and owns its directory and file descriptors until cleanup
or disposal. Linux and macOS use native descriptor-relative operations when
available. Native off, an unavailable staging capability, and Windows use
guarded Node pathname operations and emit one `FS_SAFE_NATIVE_FALLBACK` warning.
Both routes preserve observed identities, reject no-replace collisions, and
record publication before later verification or cleanup can fail. Receipts
describe the selected targeting mechanism; the portable route cannot clean a
stage through its original directory after that directory moves.

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
`0600`; exact final modes, including `000`, are supported on POSIX. Windows modes
do not establish ACL privacy; the supplied directory's ACL remains caller trust.
On POSIX the unpublished file stays at `0600` throughout preparation and any
awaited application checks. After publication succeeds and the published entry
passes identity validation, the owner applies the requested mode through its retained file descriptor. Content
was synchronized during preparation; publication requests parent synchronization.
Modes retaining owner read/write skip the extra mode-only file sync, so a crash
may leave the tighter staged `0600` instead of the wider requested mode. Modes
removing owner read or write, and corrections of an observed wider staged mode,
retain the post-chmod file sync. No parent is created or chmodded.
Creation uses an exclusive open of a generated direct child name, with no-follow
and close-on-exec flags where available. Writes use that descriptor. Inspection
uses non-following metadata operations. On Windows, no-replace publication
transfers ownership to a verified descriptor opened through the new sibling
name before retiring the temporary name. This supports runtimes that retain a
deleted name while handles opened through it remain open. The transfer requests
write-only access without truncation, checks the same exact file identity, and
never reads the completed file's contents.

A supplied directory receipt must still match at admission. Its numeric
identity must be exactly representable; ambiguous identity fails closed.
Returned receipts are frozen descriptive snapshots, not mutable authority.
Changing a supplied receipt after admission cannot retarget the lifecycle.

`StagedFileReceipt` contains `targeting` (`"descriptor-relative"` or
`"guarded-pathname"`), `directory` (`path`, `realPath`, and exact bigint
`identity.dev`/`identity.ino`), `temporaryBasename`, and the prepared file's
`identity` (`dev`, `ino`, `size`, `nlink`, `mtimeNs`, `ctimeNs` as bigint;
`mode`, `uid`, `gid` as numbers). This is a preparation-time snapshot of the
private stage: its POSIX mode is `0600`. Publication does not refresh this snapshot;
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
Windows also rejects reserved device names, invalid filename punctuation, and
trailing-dot or trailing-space aliases.

With `overwrite: false`, native publication uses kernel no-replace rename. The
portable route atomically links the completed private stage to the absent final
name, verifies the two-link transition, then removes its temporary name. A
collision leaves both names unchanged and raises `FsSafeError("already-exists")`.
The stage may then be cleaned or published under another name. With
`overwrite: true`, publication is plain atomic replacement. Neither route
copies. Native operations resolve both names through the retained original
parent; portable operations use the captured pathname with parent and file
checks before and after mutation. If hardlinks are unavailable, a bounded system
command performs an atomic no-replace rename and reports `method: "rename"`.
Linux uses isolated system Python 3; macOS uses JXA and Windows uses
PowerShell/.NET. See [runtime requirements](install.md#platform-command-fallbacks).
This preserves the complete file and its inode. An unavailable command leaves
the stage retryable; an ambiguous command result preserves it for recovery.
On the hardlink route, other processes can briefly observe both names, and an
unlink failure can leave both names present.

`PublishedFileReceipt` has `status: "published"`, `staged`, `basename`,
`overwrite`, and `method` (`"rename"` or `"link-unlink"`). Its `staged` field
retains the private preparation snapshot, not
final metadata. Errors from publication carry typed `StagedFileFailureDetails`
in `FsSafeError.details`, including `phase` and `publication`. Publication is
`not-published`, `published` (with its receipt), or `indeterminate` (with the
attempted basename and overwrite policy) if a rename or link error cannot establish
whether it committed. The underlying error remains in `cause`.

With descriptor-relative targeting, a parent move after the final pre-check
cannot divert the rename to a replacement parent. It can publish inside the moved original and then fail
post-validation. Successful rename is recorded before those checks; cleanup
never deletes or rolls back a published final name. Indeterminate publication
also preserves names for caller-directed recovery. Guarded pathname targeting
cannot prevent a parent replacement in the final check-to-mutation gap from
redirecting the operation; a post-check can report the changed parent after a
mutation already occurred.

On the portable no-replace route, successful link creation records `published`
immediately. A later temporary-name unlink failure retains that evidence.
Cleanup can retry removal of the verified owned temporary name, including its
expected second link to the published file. It never removes the final name.

The same rule applies if applying the published mode, synchronizing, or a later
check fails: the error reports `published`, and cleanup preserves the final
name. The file may still have mode `0600` or may already have the requested
mode, depending on which operation failed. A `published` failure receipt records
namespace publication success, not successful permission finalization.

## Cleanup guarantee and limits

With `targeting: "descriptor-relative"`, if the temporary basename still names
the object created by this lifecycle and filesystem removal remains permitted,
moving or replacing the actual parent
(or an ancestor) does not strand the unpublished temp. Cleanup resolves through
the retained original directory, even after `assertCurrent()` rejects drift.
Same-name sentinels in the replacement parent are not touched.

With `targeting: "guarded-pathname"`, cleanup first verifies that the original
parent pathname still matches. A moved or replaced parent produces `preserved`;
the original artifact and replacement-parent sentinels remain untouched. This
route does not search for renamed parents or follow an unverified substitute.

`StagedFileCleanupReceipt` records `targeting`, `temporaryBasename`, `publication`,
`resources` (`closed` or `close-failed`), and `status`:

| Status | Meaning |
|---|---|
| `removed` | The owned recorded temporary name was unlinked through the reported targeting mechanism. |
| `name-absent` | That name was absent in the verified directory; this does not prove the inode has no other names. |
| `preserved` | An observed substitute or an indeterminate publication was left alone. |
| `failed` | Inspection or removal failed. |
| `not-needed` | Publication removed the temporary name, or preparation failed before creating a file. |

Explicit cleanup returns preservation outcomes. Removal or close failures throw
an `FsSafeError` with the receipt in `details.cleanup` and underlying errors in
`cause`. Disposal also throws for preservation, so ignoring its return value
cannot hide incomplete cleanup. Setup failures preserve the original error;
when cleanup also fails, an aggregate cause retains both failures. Descriptors
are closed on every cleanup outcome, with no retry through recycled numbers.

Native staging provides **directory-relative targeting**, not expected-destination-inode/CAS
publication. Checking an identity before rename does not make rename CAS.
Likewise, the identity check followed by `unlinkat` is not an atomic conditional
unlink: an adversary can replace the leaf in that final syscall gap. Observed
substitutions are preserved, but this API does not guarantee recovery after
arbitrary child renames, permission revocation, I/O failure, or process death.
Keep application authorization, manager checks, snapshots, fingerprints,
cooperative locks, and conditional rollback.

Namespace cleanup is not crash durability. Staging retains the writer's file
synchronization behavior, and publication requests directory synchronization
(with the existing `EPERM` exception). An unsupported Windows directory sync
emits a warning and leaves the published file usable; other I/O failures retain
their publication evidence and propagate. Cleanup does not promise a durable unlink.
No successful receipt promises survival across a crash. See [Directory
durability](durability.md) when an application needs a separate durability proof.
`pinDirectory().assertCurrent()` and `.sync()` still require a current pathname;
they do not gain this cleanup authority.

## Related pages

- [Advanced composition](advanced.md)
- [Native architecture](native.md)
- [Security model](security-model.md)
