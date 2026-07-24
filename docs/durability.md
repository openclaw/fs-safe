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

## Scope

These primitives establish path identity and filesystem synchronization. They
do not decide application commit protocols, marker formats, permission policy,
or whether an unsupported platform is acceptable. Keep those decisions at the
owning product boundary.
