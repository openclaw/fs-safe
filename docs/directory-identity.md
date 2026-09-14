---
title: Directory identity
description: "Exact directory observations and synchronous identity assertions for application-owned workflows."
---

# Directory identity

Use `readDirectoryIdentity()` and `assertDirectoryIdentitySync()` from
`@openclaw/fs-safe/advanced` when an application owns a staging or recovery flow
and needs to verify that a pathname still identifies an observed directory.

```ts
import {
  readDirectoryIdentity,
  assertDirectoryIdentitySync,
} from "@openclaw/fs-safe/advanced";

const expected = await readDirectoryIdentity(directoryPath);
await prepareOutput();
assertDirectoryIdentitySync(directoryPath, expected);
```

`readDirectoryIdentity(path)` returns a frozen `DirectoryIdentity`:

```ts
type DirectoryIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  realPath: string;
}>;
```

Both operations reject a final symlink or a non-directory. Parent aliases are
resolved when observing the canonical path; these helpers do not confine a path
to a root or reject every symlink ancestor. Keep the application's path policy,
or use the [Root API](root.md) for paths that must remain beneath a root.

## Checking the selected path

`assertDirectoryIdentitySync(observedPath, expected)` reads the supplied path
and compares its exact `dev` and `ino` against the expected bigint values. It
returns `undefined` on success and throws synchronously on failure.

If `expected.realPath` is present, the current canonical path must also match
that string exactly. Pass the complete observation to keep both checks:

```ts
assertDirectoryIdentitySync(newlyOpenedRootPath, expected);
```

For a directory intentionally moved to another name, omit `realPath` while
retaining the expected identity:

```ts
assertDirectoryIdentitySync(movedPath, { dev: expected.dev, ino: expected.ino });
```

Only `dev`, `ino`, and optional `realPath` participate in the assertion. A
`MovePathPublicationReceipt` can supply the identity after a move; its `path`
does not implicitly require the previous pathname to remain current.

## Errors and ownership

| Condition | Result |
|---|---|
| Final symlink or non-directory | `FsSafeError("not-file")` |
| Different expected identity or supplied canonical path | `FsSafeError("path-mismatch")` |
| Numeric expected identity or persistently unknown Windows identity | `FsSafeError("path-mismatch")` |
| Filesystem failure such as `ENOENT` or `EACCES` | The original error, unchanged |

Windows can temporarily report a zero device or inode. The shared identity
owner permits one re-inspection, retaining every known component so a later
observation cannot erase a definite mismatch. It rejects identities that remain
unknown and does not retry operational filesystem errors.

These helpers observe directory identity. They do not open a retained handle,
hold a lock, create or remove directories, change permissions, or authorize
application work. A pathname can change after an assertion; continue to use
guarded mutation APIs and recheck application authority at the operation's
existing submission point. Keep publication, rollback, and cleanup decisions
with the caller. Use [pinned directories](durability.md#pinned-directories) when
the operation specifically needs the directory synchronization lifecycle.
