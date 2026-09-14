---
title: In-place writes
description: "Replace bytes through a borrowed file handle while preserving its inode and attempting rollback on failure."
---

# In-place writes

`overwriteFileHandle()` replaces a regular file's contents through a handle the
caller already owns. Use it when replacing the inode would break hardlinked
aliases, or when an existing writable file lives in a directory where the caller
cannot create a sibling temporary file.

```ts
import { open } from "node:fs/promises";
import { overwriteFileHandle } from "@openclaw/fs-safe/advanced";

const handle = await open(filePath, "r+");
try {
  await overwriteFileHandle(handle, Buffer.from(nextContents, "utf8"), {
    beforeWrite: () => assertCurrentOwner(),
  });
} finally {
  await handle.close();
}
```

## Contract

```ts
overwriteFileHandle(
  handle: FileHandle,
  data: Uint8Array,
  options?: { beforeWrite?: () => void },
): Promise<void>;
```

The handle must be readable and writable, refer to a regular file, and have been
opened **without append mode**. Node cannot portably inspect a handle's append
flag, and some operating systems ignore positioned-write offsets for append
handles. Opening, path admission, symlink and hardlink policy, and closing remain
the caller's responsibility. The helper never reopens or replaces the inode,
changes the handle's current position, or closes it. Every hardlinked alias sees
the in-place changes.

The payload is borrowed, including its byte offset and length. Keep it unchanged,
attached, and accessible until the returned promise settles. Do not close the
handle or run concurrent I/O against the file, including through other aliases,
during preparation, writing, or rollback. This helper does not acquire a lock.

## Preparation, ordering, and failure

The helper checks the file type and original size, then saves only the prefix
that will be overwritten: `min(data.byteLength, originalSize)` bytes. A short
prefix read fails with `FsSafeError("read-failed")` before writing. Memory for the
backup is bounded by that prefix length; a short replacement of a large file does
not read or buffer the untouched tail.

After preparation, `beforeWrite` runs synchronously once. A thrown value is
propagated unchanged without any file mutation. A Promise or thenable return is
rejected with `TypeError`; asynchronous callbacks cannot admit a write. Once
admitted, the operation finishes the write or its failure recovery without
calling `beforeWrite` again. This callback is a whole-operation admission point,
not the per-mutation `assertBeforeMutation` callback used by Root operations.
It must not change the file, handle, or payload. There is no cancellation option.

For growth, additional tail bytes are written before the existing prefix is
touched. The prefix is then overwritten, completing partial writes. For shrinkage,
truncation is last. If a write or truncation fails, the helper attempts to restore
the saved prefix, if touched, and the original length. It waits for both recovery
attempts and then rethrows the original error, even when recovery also fails.
Zero-progress writes fail with `FsSafeError("helper-failed")`.

Recovery is best effort, not atomic publication or a crash-recovery guarantee.
Other observers can see intermediate contents; failed recovery can leave partial
bytes. The helper does not chmod or synchronize the file or its directory.
Normal filesystem effects such as timestamp updates or clearing special mode
bits can still occur. Callers own any durability or broader transaction policy.

The implementation uses Node positional reads and writes in every native mode;
it does not load a native binding. Prefer [`Root.write`](writing.md) when atomic
replacement and root-based path admission are the intended contract.
