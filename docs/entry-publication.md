---
title: One-way entry publication
description: Retained directory, regular-file and symlink publication with atomic destination absence, under caller-owned namespace stability.
---

# One-way retained entry publication

`retainEntryForPublication` from `@openclaw/fs-safe/advanced` admits an existing
directory, single-link regular file or single-link symlink for a **one-way, native no-replace rename**.
It retains both parent directories and the source object. It never reverses a
move, unlinks a name, removes a tree, or copies across filesystems.

This is an advanced cooperative primitive, **not a sandbox or source-identity
compare-and-swap**. The caller must exclude source namespace writers from its
original observation through publication, and keep the admitted physical parent
and ancestor topology stable through all later pathname consumers. Descriptors
prevent identity reuse and bind the native rename to retained parents; they do
not pin the source name or confine the operation to the parents' current paths.
Observed substitutions refuse; substitutions after the last check remain outside
this contract. A callback, lockfile, random directory or mode `0700` does not
exclude arbitrary same-user nonparticipants.

## Inputs and admission

```ts
import {
  retainEntryForPublication,
  type RetainEntryForPublicationOptions,
  type EntryPublicationResult,
} from "@openclaw/fs-safe/advanced";

function publishManagedEntry(options: RetainEntryForPublicationOptions): EntryPublicationResult {
  const publication = retainEntryForPublication(options);
  return publication.publish();
}
```

`options` contains:

- `source.parent` and `destination.parent`: `{ path, identity: { dev, ino } }`.
  Paths must already be absolute canonical physical spellings, with no symlink,
  case or lexical aliases. Preserve caller-captured original identities; never
  substitute a new observation merely to make a stale admission succeed.
- `source.basename` and `destination.basename`: nonempty direct-child names.
  Dot entries, separators, colons, NUL and control characters are refused.
- `source.expected`: `{ dev, ino, kind: "directory" | "file" | "symlink" }`. Identities must
  be exact unsigned bigint observations with a known nonzero inode. File contents
  are not hashed, frozen or made read-only. Regular files and symlinks must have one link;
  directories are not recursively inspected. Source and destination must not
  overlap. Special entries are not supported.
- `assertBeforeMutation`: required synchronous authority callback. Throw to refuse.
  Promises and generators refuse. The callback runs once in `publish()`, followed
  by fresh source and parent checks. It cannot dispose or reenter the resource.
  It supplies authorization, not namespace isolation.

Admission can throw `FsSafeError`. `cause` retains the original admission error;
`details.result` reports `not-published`, descriptor settlement and ordered issues.
Admission never changes either namespace. Caller cleanup responsibilities do not
transfer to this resource.

Symlink publication moves the link inode, never its payload. Link target bytes are
not decoded, resolved or rewritten; relative, dangling and non-UTF-8 targets are
preserved. Relative targets resolve from the final parent after publication, so
the caller must prepare the correct final layout. External payloads remain owned
by their existing owner, and the caller must hold any target/ancestor stability
needed by subsequent consumers. Source symlink basenames must match the physical
directory entry spelling; parent aliases remain refused. No recursive symlink
policy is imposed on the contents of a published directory.

## Results and lifetime

`publish()` is synchronous, one-shot, and closes all three retained descriptors
before returning an immutable `EntryPublicationResult`. Inspect **all** fields:

| Field | Meaning |
| --- | --- |
| `transition: "committed"` | Native rename returned success. Recorded before verification or close. |
| `transition: "not-published"` | Refused before dispatch, or a determinate native rejection. Both entries are preserved by this operation. |
| `transition: "indeterminate"` | Native reply was lost/malformed or the error did not prove rejection. Retain both locations; do not infer a result from later path observations. |
| `verification` | `verified`, `failed`, or `not-performed`. A failed postcheck never changes committed to not-published. |
| `resources` | `closed` or `close-failed`. Every owned close is attempted once, even if an earlier close failed; ambiguous closes are never retried. |
| `issues` | Ordered `{ phase, cause }` failures. The first is primary, including falsy thrown values; later close failures do not mask it. |

A committed result with issues is not an error-free publication. The immutable
`receipt` records original source/destination observations and capability facts:
`destinationAbsence: "atomic"`,
`sourceIdentity: "observed-under-caller-exclusive-namespace"`, and
`parentBinding: "retained-object"`, plus admitted filesystem names.

`dispose()` only closes. It does not delete unpublished staging or published
names. Subsequent `publish()`/`dispose()` return the same terminal result without
another effect. `Symbol.dispose` closes too, throwing with `details.result` if
closure reported a failure. Retain an unused resource only while its namespace
contract is held, then explicitly dispose it; there is no GC cleanup guarantee.

Results are in-memory syscall dispositions, **not a durable transaction journal**.
For crash recovery record intent before dispatch in the caller's own durable
owner, then persist the result. A crash before receipt persistence is unresolved.
Several publications are not one atomic transaction: if a later child collides,
keep prior exposed children, newer destination writes and remaining staging. This
API deliberately provides no automatic compensation or retry.

## Platform and filesystem contract

Native support is mandatory even in `auto` mode. There is no Node pathname
rename or copy fallback. This API supports local APFS/HFS on macOS and
ext-family/XFS/Btrfs/tmpfs on Linux, subject to the kernel/filesystem's native
no-replace operation (`renameatx_np(RENAME_EXCL)` or `renameat2(RENAME_NOREPLACE)`).
Network, FUSE, overlay and unknown filesystem types refuse before dispatch;
Windows and other platforms are unsupported here. Do not infer Windows parity
from other fs-safe handle APIs. Cross-device moves refuse without copying.
Unsupported syscall/flag errors do not trigger another rename implementation.

A preexisting **or raced** empty directory, file or symlink at the destination is
never overwritten by a successful no-replace call. Admission also rejects a
destination alias of the source, including Darwin case-only rename exceptions.
For distinct destination entries this is the syscall guarantee;
source selection still occurs by basename. Moving admitted A away and installing
B after the native source check can cause POSIX to move B. Postchecks may detect
that only after commitment. Applications needing protection from that schedule
must use a stronger namespace owner, not treat this API as source CAS.
