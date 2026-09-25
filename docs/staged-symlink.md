---
title: Retained symlink publication
description: "Admit and retain an identified staged symlink for no-replace publication and explicit recovery."
---

# Retained symlink publication

`retainSymlinkInDirectory()` from `@openclaw/fs-safe/advanced` admits an
**existing** direct-child symlink against caller-captured identity, ownership,
change time and target. It holds a no-follow descriptor to that inode and its
parent until cleanup. It does not create a symlink or infer ownership from a
same-target pathname observation. This dedicated lifecycle does not relax
`Root.move()` or regular-file staging's symlink rejection.

The caller owns staging and admission evidence. Create and inspect the stage
under the application's cooperative writer lock, and keep that lock through
admission. A historical stat is not a lifetime handle: if peers can recycle
inodes between capture and admission, identity numbers alone cannot establish
historical ownership. Once admitted, the retained descriptor prevents inode
reuse until this owner closes. Failed admission closes descriptors without
unlinking anything; all staging cleanup remains with the caller.

Linux uses `O_PATH | O_NOFOLLOW`; macOS uses `O_SYMLINK`.
Windows, native mode off, and missing or older bindings reject before namespace
mutation. No fallback interpreter, copy, following open, or public descriptor
is used. Symlinks must have one link and a UTF-8 target; their targets are never
opened or confined by this API. The application must authorize the target.

## Example

```ts
import {
  retainSymlinkInDirectory,
  type StagedSymlinkExpected,
  type PublishedSymlinkReceipt,
} from "@openclaw/fs-safe/advanced";
import type { DirectoryReceipt } from "@openclaw/fs-safe/durability";

// Application owns stage creation, capture, locking and transaction policy.
export async function publishInstallerLink(options: {
  directory: DirectoryReceipt;
  stagedBasename: string;
  expected: StagedSymlinkExpected;
  finalBasename: string;
  assertAuthorizedAndCurrent(): void;
}): Promise<PublishedSymlinkReceipt> {
  await using staged = await retainSymlinkInDirectory({
    directory: options.directory,
    basename: options.stagedBasename,
    expected: options.expected,
    assertBeforeMutation: options.assertAuthorizedAndCurrent,
  });
  return await staged.publish(options.finalBasename);
}
```

`expected` requires exact bigint `dev`, `ino`, `ctimeNs`, integer `uid`
and `gid`, and `target`. Admission snapshots these values and the parent
receipt. The frozen returned receipt contains `directory`,
`temporaryBasename`, `target`, and preparation-time `identity` metadata,
like [regular-file staging](staged-file.md). Rename may change timestamps;
the original receipt is never replaced by a post-publication identity.

## Lifetime and outcomes

- `assertCurrent()` checks the admitted parent pathname, original name, retained
  inode, single-link count, ownership, mode and target before publication.
- `publish(basename)` accepts a distinct portable direct-child name. It performs
  the synchronous authority assertion, rechecks source and parent, and dispatches
  guarded native no-replace rename. An existing file, symlink or directory is
  never overwritten, and the link is never nested inside a destination directory.
- Successful dispatch is recorded as `published` **before** fallible postchecks.
  A foreign same-target replacement fails verification without becoming owned.
  `assertPublished()` checks against the still-retained inode.
- `removePublished()` is an explicit recovery action, not automatic rollback.
  It reasserts authority and removes only an observed matching published link
  through the retained original parent. It returns `removed`, `name-absent`,
  or `preserved`. Its outcome or error is cached: it never retries an uncertain
  unlink or touches a later replacement. It does not restore an old destination.
- `cleanup()` removes only an unattempted, still-owned stage, then closes both
  handles. Published names are preserved. Indeterminate publication preserves
  both names. Authority rejection during cleanup preserves the stage and still
  closes handles. Repeated cleanup replays the cached result/error without
  touching descriptor numbers.
- `await using` invokes cleanup and raises on a `preserved` outcome. Invocation
  order serializes descriptor work; reentrant calls from the authority callback
  reject. Callbacks must be synchronous; returned thenables are refused.

Errors carry `StagedSymlinkFailureDetails` in `FsSafeError.details`: the phase,
recorded `publication`, and a cleanup receipt when applicable. Publication is
`not-published`, `published` (with the precaptured receipt), or
`indeterminate` (with the attempted name). Native errno, including a collision,
does not rule out a committed remote rename whose response was lost. Only
pre-dispatch rejection leaves publication `not-published`. After an indeterminate
result, this owner cannot publish again or remove the possibly published name.

Cleanup records `temporaryBasename`, `publication`, `resources`
(`closed` or `close-failed`), and `status` (`removed`, `name-absent`,
`preserved`, `failed`, or `not-needed`). Failure closes every retained handle
once and aggregates cleanup/close errors. A failed explicit recovery unlink is
reported to its caller and is not converted into successful recovery by cleanup.

## Limits

This is directory-relative targeting, **not CAS**. Identity checks followed by
rename or unlink are not atomic conditional mutations. An uncooperative writer
can replace a child in the final syscall gap; observed substitutes are preserved,
but callers must coordinate writers to exclude that gap. The retained parent
prevents redirection into a replacement parent; a parent move can still cause
publication in the moved original and a `published` postcheck failure.

No receipt promises crash durability or recovery after process death, arbitrary
renames, permission revocation or I/O failure. This API does not sync directories
or persist descriptors. Caller journals, state capture, conditional restoration,
durability, and transaction settlement remain separate requirements. Keep the
owner alive until the application's publication or recovery decision settles.
