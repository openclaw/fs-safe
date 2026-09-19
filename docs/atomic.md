# Atomic writes

`@openclaw/fs-safe/atomic` re-exports the lower-level helpers that `root()`'s write methods are built on. Reach for them when you have a path you trust and want sibling-temp + rename without setting up a `Root`, or when you need finer control over `fsync`, mode preservation, or pre-rename hooks.

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

On POSIX, the parent is opened with no-follow and directory-only flags, checked against its exact pre-open device/inode identity, and mode-adjusted through that descriptor. A replacement symlink is rejected rather than followed. If the directory cannot be opened for descriptor access, the operation fails closed instead of retrying by pathname. Windows does not enforce POSIX directory modes and Node cannot consistently open directory descriptors there, so `dirMode` is passed only to `mkdir`; no pathname `chmod` fallback is attempted.

Async replacements to the same destination are serialized inside the current process, so two overlapping `replaceFileAtomic()` calls do not interleave their temp-write/rename phases. Use a sidecar lock when multiple processes may write the same target.

Relative paths retain their literal suffix so `.` and `..` keep Node's existing
filesystem semantics. On Windows, an ordinary drive-relative destination such
as `C:.\\state.json` is captured at entry by anchoring the drive's current
directory without normalizing that suffix. The anchored absolute spelling is
used for staging, locks, callbacks, publication, and cleanup. Any additional
colon remains visible and is rejected as a filesystem namespace alias before
I/O; malformed namespace-drive spellings remain rejected.

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
  mode?: number;                    // new-file mode (default 0o600)
  preserveExistingMode?: boolean;   // inherit existing regular-file rwx bits; default false
  tempPrefix?: string;              // default ".fs-safe-replace"
  renameMaxRetries?: number;        // EBUSY retries; default 0
  renameRetryBaseDelayMs?: number;  // exponential base; default 50
  copyFallbackOnPermissionError?: boolean; // default false
  copyFallbackRestore?: "restore-original" | "none"; // default: "none"
  maxRestoreBytes?: number;          // required with "restore-original"
  destinationHardlinks?: "reject"; // default unset (no destination nlink policy)
  renameIdentity?: "strict" | "verify-content-with-lock"; // default "strict"
  syncTempFile?: boolean;           // fsync(temp) before rename, or the final file after copy fallback; default false
  syncParentDir?: boolean;          // fsync(parent) after rename, POSIX only; default false
  throwOnCleanupError?: boolean;    // report temp cleanup failure; default false
  beforeRename?: (params: { filePath: string; tempPath: string }) => Promise<void>;
  fileSystem?: ReplaceFileAtomicFileSystem; // injectable fs for tests
};
```

`preserveExistingMode` snapshots only the ordinary rwx bits (`0o777`) from an
existing non-symlink regular destination. A final symlink fails with
`FsSafeError("symlink")`; a directory or other non-regular destination fails
with `FsSafeError("not-file")`. Set-user-ID, set-group-ID, and sticky bits are
never inherited. Mode inheritance does not copy ownership, ACLs, extended
attributes, or exact destination identity. Rename publication creates a new
inode; an in-place copy fallback can retain metadata already attached to its
pinned destination. The snapshot does not make replacement a compare-and-swap
operation, so the destination parent must still be protected from untrusted
concurrent namespace mutation.

### `beforeRename`

Runs after the temp file is fully written and before the rename. Use it to take a backup snapshot, capture the about-to-be-replaced contents, or notify an observer. The helper retains the staged descriptor and exact bigint identity across the hook; replacing, deleting, hardlinking, or changing the temp entry to a non-regular file is rejected before publication:

```ts
await replaceFileAtomic({
  filePath: "/srv/workspace/config.toml",
  content: rendered,
  beforeRename: async ({ filePath }) => {
    await fs.copyFile(filePath, `${filePath}.bak`); // snapshot existing
  },
});
```

If `beforeRename` throws, the rename is skipped and the owned temp file is removed — the destination is unchanged. Cleanup unlinks only the exact admitted single-link file; a substitute observed at the temp name is preserved and removed from cleanup authority. The same identity is rechecked before every rename retry, when entering copy fallback, and at the final name after rename. A post-rename verification failure reports the race without rolling back or deleting the published name.

JavaScript permits `beforeRename` callbacks and filesystem adapters to throw any value, including
`undefined`, `null`, `false`, signed zero, `0n`, an empty string, and `NaN`.
Atomic replacement preserves such operational failures when cleanup and close
succeed, including rename and post-rename verification failures. Rename retry
and copy-fallback classification reads the error code once without coercion;
missing or unreadable codes preserve the original failure. A rejected call has
no success receipt even if an adapter committed its rename before throwing. With
`throwOnCleanupError: true`, an additional owned-temp cleanup failure keeps the
existing cleanup wrapper whose `cause` is the original thrown value. A later
descriptor-close failure is reported in an `AggregateError`, in operation/cleanup
then close order. The default `throwOnCleanupError: false` omits only the cleanup
failure: the temp stays registered for identity-checked process-exit cleanup, the
descriptor is still closed, and a close failure remains reportable.

Identity checks and pathname rename/unlink remain separate syscalls, not atomic conditional mutations. Use an approved writable parent plus cooperative locking or OS isolation when arbitrary concurrent namespace mutation is in scope.

### FUSE, Windows exFAT/FAT32, and unstable rename identity

Strict source-to-destination identity is the default. Some FUSE mounts assign a different inode to the destination during rename even without concurrency. Set `renameIdentity: "verify-content-with-lock"` to accept that boundary only when the re-opened no-follow destination has the exact requested SHA-256 content under an exclusive hashed sidecar lock in the destination parent. The newly accepted descriptor and identity remain pinned through parent sync and final verification. The synchronous helper provides the same policy with the synchronous lock implementation.

This is the same explicit weaker contract available on `Root` writes: cooperating writers are serialized, stale locks fail closed, and mismatched content is rejected after publication without rollback. A same-authority actor that ignores the advisory lock can still substitute another file with identical bytes, so do not use this compatibility policy in directories writable by untrusted same-UID processes.

Windows exFAT/FAT32 volumes can also change file identity during rename, depending
on the source and destination names. The destination may already contain the
requested bytes when strict verification reports `path-mismatch`. A short
temporary name alone does not guarantee stable identity for a longer destination.
For an application-controlled directory on such a volume, callers can explicitly
select `renameIdentity: "verify-content-with-lock"` on `replaceFileAtomic` or
`replaceFileAtomicSync`. Keep strict mode for directories that require the
stronger identity contract; do not automatically retry every `path-mismatch`
with the weaker policy. Staging names remain random, including custom prefixes.

To verify the built package against an actual volume, run
`node scripts/atomic-rename-compat-proof.mjs EXISTING_PARENT` after `pnpm build`.
Use a trusted parent directory that no other process can rename or modify during
the entire run, including cleanup; do not point the probe at a shared writable
volume root. Cleanup checks the created directory's identity before recursive
removal, but the check and removal are not atomic. The probe does not test safety
against hostile concurrent namespace mutation.
The probe creates and cleans up its own child directory and emits JSON without
local paths. It compares default, strict, and locked policies in both async and
sync calls, checks real rename identities and file contents, injects different-
and identical-content substitutions, checks lock cleanup, and exercises custom
prefix isolation and validation. Callback staging remains strict and can still
report identity drift; the probe records that result separately. Filesystem type
must be recorded independently; the probe does not infer it from a drive letter.

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

Source and pinned destination admission compare exact bigint device/inode
observations, so distinct identities that round to the same JavaScript number
cannot authorize a copy. Unknown Windows identities get one bounded reinspection
of the same descriptor or path; incomplete or inconsistent observations fail
closed without reopening. Injected filesystem adapters must honor the
`{ bigint: true }` stat option. Source admission reuses that exact pair instead
of immediately repeating it with numeric metadata.

The default `copyFallbackRestore: "none"` preserves the existing fallback
contract: a failed copy can leave a partial destination. For state files where
preserving the old bytes is more important, choose `"restore-original"` and set
an explicit `maxRestoreBytes` memory budget. If the destination exists, fs-safe
snapshots it through a pinned descriptor, overwrites and mode-adjusts through
that same descriptor, and synchronizes the result. Any write, mode, or sync
failure triggers a byte-and-mode restore and another sync through the same
descriptor.

With `syncTempFile: false`, an exclusive-create copy fallback does not report
success until its new destination writer closes successfully. This includes
`"restore-original"` when the destination did not exist. A close rejection or throw is
propagated exactly, including falsy values. The destination may already contain
all or part of the replacement, so a close failure does not prove that the old
destination survived or that the replacement was published. The outer atomic
operation still attempts identity-bound cleanup of its owned source temp; an
unverifiable or substituted temp remains preserved. If writing, mode adjustment,
or another earlier operation also fails, that earlier value remains the reported
failure and the destination close is attempted once. Successful synchronized
fallbacks and in-place `"restore-original"` replacements retain their existing best-effort final-close
handling.

Restore failures are `FsSafeError("helper-failed")` values with typed
`details.cleanup` set to `"restored"` or `"restore-failed"`. An original larger
than `maxRestoreBytes` fails with `too-large` before mutation. A missing
destination has no original to restore and follows the exclusive-create copy
fallback.

Restore snapshots use the pinned file's size as an allocation hint, with an
initial allocation capped at 16 MiB plus the overflow byte. Reads continue
through short reads and EOF, grow only as data arrives, and enforce the same
`maxRestoreBytes` budget even if the destination grows after its size was read.

### Sync variant

`replaceFileAtomicSync` accepts the same base options, a synchronous
`beforeRename` callback, and `ReplaceFileAtomicSyncFileSystem`. Use it inside
synchronous boot paths or test setup code. It returns the same
`{ method: "rename" | "copy-fallback" }` receipt as the async variant.

## `replaceDirectoryAtomic`

Publish one staged directory at a target without overwriting a concurrently
created entry. Despite the historical name, replacing an existing target is a
guarded two-rename protocol, not an atomic directory exchange.

```ts
import { replaceDirectoryAtomic } from "@openclaw/fs-safe/atomic";

await replaceDirectoryAtomic({
  stagedDir: "/srv/workspace/staging/snapshot-2026-05-05",
  targetDir: "/srv/workspace/snapshot",
});
```

Every publication requires the dedicated native identity-fenced,
descriptor-relative no-replace rename capability and readable retained
descriptors for the staged and target parents. Older bindings that expose only
the legacy four-argument no-replace rename fail with `helper-unavailable`
before target-parent creation or any other replacement effect. This applies
when the parents are the same or different. There is no JavaScript rename
fallback, and a cross-device rename still fails. Replacing an existing target
additionally requires usable native bounded owned-tree cleanup and a readable
retained descriptor for the original target.

If the target is absent, the helper publishes `stagedDir → targetDir` with a
single no-replace rename. If the target exists, it renames `targetDir` to a
randomized sibling backup and then renames `stagedDir → targetDir`. The target
name is temporarily absent between those two operations. A competing entry is
never overwritten. Publication rollback is attempted only when the staged
rename is known not to have committed and the target name is still absent; the
rollback itself is no-replace, so a competitor is preserved and the backup is
left for recovery.

Exact staged-directory identity and parent checks run before and after each
rename. On Windows, the native rename opens the source relative to the retained
parent, compares that handle's exact volume and file-index identity with the
pre-rename bigint receipt, and only then mutates it. POSIX does not provide a
rename operation that also compares an expected source inode, so on POSIX a
source-name substitution in the final check-to-rename gap can be moved briefly
and then detected by the post-rename verification. Similarly, a successful
rename can be followed by a verification error. Inspect the error's
`details.publication` value rather than treating rejection as proof that
publication did not happen.

A Windows source-identity mismatch is rejected before mutation, reported
publicly as `path-mismatch`, and treated as definitely uncommitted so an earlier
backup can be rolled back. Other `path-mismatch`-shaped native errors are not
assumed to be pre-commit failures; their publication outcome remains
indeterminate and observed competitors are preserved.

Any native rename error without explicit pre-dispatch provenance has an
indeterminate outcome, including ordinary errno such as `ENOENT`, `EEXIST`,
or `EACCES`: a remote filesystem may commit before losing its reply. The helper
does not guess whether that rename committed or perform another rename or
cleanup based on that guess; observed names are preserved for caller-directed
recovery. An error `details.backupPath`, when present, is only the attempted or
last-observed backup pathname. It does not prove that the path still exists or
still names the original directory.

After a verified commit, the original backup is removed through its retained
directory identity and bounded native traversal. Cleanup failures reject after
publication and can leave the backup. On POSIX, cleanup retains the
[bounded final-entry unlink limitation](temp.md#private-temp-workspaces).

Concurrent calls for the same resolved target are serialized inside the current
process so their backup, publication, and cleanup phases cannot interleave.
Other processes are not serialized; no-replace renames provide the competitor
boundary. On Windows, ordinary drive-relative staged and target paths are
anchored at entry before namespace-alias admission and resolution.
`backupPrefix`, when supplied, is sanitized as one path prefix and cannot contain
path separators or NUL bytes; the generated backup tail is randomized.

Use it when callers must publish a whole staged tree with these recovery
semantics. For single-file replacement, `replaceFileAtomic` is the right tool.

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
  dirMode?: number;          // parent mode (default 0o777 masked by process umask)
  trailingNewline?: boolean; // append "\n" if missing; default false
  durable?: boolean;         // default true; false skips temp/parent fsync
};
```

`durable: false` keeps the sibling-temp replace/rename behavior but skips the
temp-file and parent-directory `fsync` calls. Use it only for reconstructible
metadata where lower latency matters more than crash-durability.

## `movePathWithCopyFallback`

Rename a path. If the rename fails with `EXDEV` (cross-device), or `EPERM` on
Windows, fall back to
copying into a staged sibling path, renaming that staged path into place, and
then removing only the source entries that were copied. The fallback avoids
buffering regular files into memory and does not tighten the destination parent
directory mode. Staged file modes are applied through their still-open handles.
If descriptor-bound mode application fails, the staged path is removed and the
move fails before publication. A transient staged-path cleanup failure retains
an identity-bound process-exit cleanup retry.
The staging entry's initially admitted identity is checked before publication
and cleanup; a later substituted entry is preserved. Regular files are admitted
through their new descriptor. Node provides no creation descriptor for directories
or symlinks, so their first identity comes from an immediate pathname observation.
Replacement before that observation remains a best-effort detection gap: use a
parent protected from concurrent untrusted mutation or OS isolation. A copy write
that makes no progress rejects instead of looping indefinitely.
On POSIX, staged directory modes are applied through no-follow directory
descriptors; on Windows, Node cannot portably open those descriptors and no
pathname `chmod` fallback is attempted, so directory modes remain subject to
Windows' `mkdir(mode)` behavior. Symlink sources are copied as links rather than
followed, including when the referent is absent; only a source proven to be a
directory is dereferenced for the destination-descendant guard.

```ts
import { movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";

await movePathWithCopyFallback({
  from: "/srv/cache/blob.bin",
  sourceHardlinks: "reject",
  to: "/srv/persistent/blob.bin",
});
```

Use it when source and destination might live on different filesystems (containers, tmpfs, separate volumes).
On Windows, ordinary drive-relative `from` and `to` paths are anchored at entry;
publication receipts report the resulting absolute destination.
The hardlink policy is captured when the move starts. Changing or reusing the
options object later does not change the policy of an in-flight move.
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
`ESTALE`. Copied file and symlink manifests retain exact bigint identities and
nanosecond timestamps, so rounded file IDs cannot authorize copying or removal
of a different entry. Hardlink groups also use exact identities. Directory
manifests retain an exact bigint device/inode receipt from
copy admission. Each directory is rechecked after traversal, and the source root
is checked again before publication. Cleanup checks the same receipt before
removing children, then invokes mutation authority and rechecks the receipt and
directory type immediately before removal. Unknown Windows identity
components get at most one retry that retains known components; persistent
ambiguity fails closed before further removal. A directory that disappeared or
was replaced during child cleanup is reported as stale; an observed replacement
is preserved. Unrelated children
added to the original directory are preserved while unchanged copied children
are still removed. These pathname checks remain best-effort: they cannot make
the final identity check and removal atomic against another process.
When allowed source names are hardlinks to the same inode, each owned
unlink is verified through a remaining manifested alias and its exact resulting
identity becomes the next cleanup receipt. This accounts for the operation's
own link-count and ctime changes without suppressing unexpected external
mutations.
On Windows, opening a regular source may advance its ctime while all other
fingerprint fields match. That exception applies only to opening; post-copy
verification and cleanup retain their full fingerprint checks.
Copied aliases share each verified open-time update. Changes observed between
copies still reject instead of being mistaken for an owned open transition.

### Mutation authority and publication receipts

Pass `assertBeforeMutation` when a move depends on a revocable lease or another
caller-owned authorization. The helper captures the callback when called and
runs it synchronously after asynchronous preparation and identity checks,
immediately before each rename, source-file or source-symlink unlink, and
source-directory removal. `assertBeforeRename` remains available for callers
that only guard publication. When both are set, the rename check runs first,
then the mutation check, without yielding before dispatch.

```ts
type MovePathPublicationReceipt = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
}>;

type MovePathWithCopyFallbackOptions = {
  from: string;
  sourceHardlinks?: "allow" | "reject";
  to: string;
  assertBeforeRename?: () => void;
  assertBeforeMutation?: () => void;
  onDestinationPublished?: (receipt: MovePathPublicationReceipt) => void;
};
```

Throw to refuse the next mutation. The original error is propagated, including
errors with `EXDEV` or `EPERM` codes; an authorization failure never starts a
copy fallback. A genuine rename failure may still require a second authority
check before publishing the staged copy.

All three callbacks must return `undefined` synchronously. Returning a Promise,
thenable, or any other value fails with a `TypeError`; rejected asynchronous
results are consumed. Perform asynchronous policy checks before calling the
helper and use the authority callback to recheck the current owner at each
mutation boundary. All callbacks are captured before the first await.
Copied source leaves are checked again immediately after authority returns and
before unlink is submitted. Supplying any of the three callbacks also
retains the original source-parent route and renews copied-directory ancestry
before cleanup. Substituted entries are preserved; pathname checks and unlink
remain a best-effort sequence, not atomic.

`onDestinationPublished` runs exactly once after a successful rename resolves,
before awaited post-rename directory checks or source cleanup. It receives a
frozen receipt with the resolved absolute destination path and the exact bigint
device/inode identity observed on the rename source before dispatch: the
original source for a direct rename, or the staged copy for fallback. Failed
rename attempts never emit receipts. The return contract remains `Promise<void>`.

The receipt records an observed identity, not authorization, durable storage,
or an atomic guarantee against concurrent pathname replacement. Before recovery,
recheck caller authority and compare the retained identity with a fresh bigint
stat of the destination. In particular, unknown Windows device/inode values
must not be treated as proof of ownership. Do not derive ownership from a new
post-failure snapshot alone.

A refused rename leaves the source and destination unchanged; any private
staged copy follows normal cleanup. If publication has already happened, a
callback error or later verification failure preserves the published destination
and stops further source cleanup. Revocation during cleanup leaves all
as-yet-unremoved source entries intact; entries already removed remain removed.
The caller retains the receipt even if the move later rejects and owns recovery
from this partial-move state. An observer that throws must retain its receipt
before throwing if recovery needs it.

These callbacks do not cancel already-dispatched operations or make an external
lease store atomic with the filesystem. `assertBeforeMutation` guards renames
and removal of copied source entries; private staging creation, writes, and
failed-staging cleanup remain owned by the helper. Omitting the new callbacks
preserves the existing move and source-identity behavior.

## Difference from `root()`

| `Root` methods | `atomic` helpers |
|---|---|
| Take relative paths, bound to a `rootDir`. | Take trusted absolute or relative paths, no boundary. |
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

The async interface already requires `open()`, whose `FileHandle` supplies `chmod()`, so injecting `node:fs` or another conforming adapter needs no new async member. The async temp owner consumes its retained handle before awaiting `close()` during publication handoff and terminal settlement: if a custom adapter releases the resource and then rejects, that rejection is reported without calling `close()` on the same retained handle again. If publication verification opened a replacement handle before the previous retained handle failed to close, the replacement receives one best-effort close attempt. On POSIX, `open()` must support no-follow directory descriptors as Node does. A custom synchronous filesystem that passes `mode`, `dirMode`, or `preserveExistingMode` must supply `fchmodSync`; omission fails before any file or directory is created and never falls back to a pathname `chmod`. Existing synchronous adapters that request none of those options may omit it; their parent is still opened and identity-checked through a no-follow directory descriptor. Injecting plain `node:fs` supports explicit file and directory modes. Older adapter literals may continue to include `chmod` or `chmodSync` for source compatibility, but those operations are ignored. Copy fallback applies the file mode through its pinned destination descriptor as well, preserving exact modes despite the process umask.

## See also

- [`root()`](root.md) — when you want method-style writes with the boundary baked in.
- [JSON files](json.md) — JSON/text helpers built on sibling-temp replacement.
- [Temp workspaces](temp.md) — for staging-then-swap directory builds.
- [Errors](errors.md) — code union for failures.
