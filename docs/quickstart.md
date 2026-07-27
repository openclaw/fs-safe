# Quickstart

Five minutes. By the end you will have a working `root()` and know how to read, write, atomically replace, and unpack an archive — without your code being able to escape the workspace.

If you have used Go's `os.Root` / `OpenInRoot` or Rust's [`cap-std`](https://github.com/bytecodealliance/cap-std), this is the same shape: a capability-style handle that carries the boundary across every operation. The first thing to internalize is that you stop reasoning about *paths* and start reasoning about *the handle*.

## 1. Build a root

```ts
import { root } from "@openclaw/fs-safe";

const fs = await root("/srv/jobs/incoming", {
  hardlinks: "reject",  // refuse files that are hardlinks of out-of-tree inodes
  symlinks: "reject",   // refuse to traverse a symlink during open
  mkdir: true,          // create missing parent dirs on write
});
```

`root()` resolves the directory through the real filesystem (so symlinked roots become canonical) and verifies it exists. The defaults you pass apply to every call below; per-call options override them.

If the root directory itself does not exist yet, `root()` throws `FsSafeError` with code `not-found`. Either create the directory before calling `root()`, or call `await fs.ensureRoot()` after a successful `root()` to create empty subpaths.

## 2. Read and write text

```ts
await fs.write("notes/today.txt", "hello\n");
const text = await fs.readText("notes/today.txt");
```

Writes use a sibling temp file plus `rename`, so a partial write never appears at the destination. Reads open with `O_NOFOLLOW` where available and verify the opened fd matches the path identity before returning the buffer.

`create()` is the don't-clobber variant of `write()` and throws `already-exists` when the target is already there:

```ts
await fs.create("notes/README.md", "seed\n"); // throws if it already exists
```

## 3. JSON, with parsing

```ts
type Config = { tokens: string[]; updatedAt: string };

await fs.writeJson("state/config.json", { tokens: [], updatedAt: new Date().toISOString() }, {
  space: 2,
});

const config = await fs.readJson<Config>("state/config.json");
```

`writeJson` stringifies and writes atomically. `readJson` reads through the same boundary and parses; validate the shape at your application boundary if it came from a less-trusted source.

## 4. Move and remove

```ts
await fs.move("notes/today.txt", "notes/archive/today.txt", { overwrite: true });
await fs.remove("notes/archive/today.txt");
```

`move()` defaults to no clobber. Pass `{ overwrite: true }` when replacing the target is intentional. `remove()` works on files and empty directories. For non-empty directories, list and remove children first or use [`replaceDirectoryAtomic`](atomic.md#replacedirectoryatomic).

## 5. Inspect

```ts
const here = await fs.exists("state/config.json"); // boolean
const stat = await fs.stat("state/config.json");   // { kind, size, mtimeMs, ... }
const names = await fs.list("state");              // string[]
const entries = await fs.list("state", { withFileTypes: true }); // DirEntry[]
```

`exists`, `stat`, and `list` are boundary-checked but **do not pin a later operation** to the same filesystem object. For operation-local identity checks, use `read()`, `open()`, `write()`, `create()`, `copyIn()`, `move()`, or `remove()`. Linux native beneath opens are kernel-atomic; other mechanisms remain best-effort as documented in the [security model](security-model.md#containment-guarantees-by-platform).

## 6. Catch escapes

```ts
import { FsSafeError } from "@openclaw/fs-safe";

try {
  await fs.write("../escape.txt", "x");
} catch (err) {
  if (err instanceof FsSafeError && err.code === "outside-workspace") {
    // log, count, drop the request
  } else {
    throw err;
  }
}
```

Error codes are a closed union — branch on `err.code` instead of matching message text. The full list lives in the [Errors](errors.md) reference.

## 7. Replace a config file atomically

```ts
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";

await replaceFileAtomic({
  filePath: "/srv/jobs/incoming/state/config.json",
  content: JSON.stringify(state, null, 2),
  mode: 0o600,
  syncTempFile: true,
  syncParentDir: true,
});
```

Use `replaceFileAtomic` directly when you have an absolute path you trust and want sibling-temp + rename without going through `root()`. See [Atomic writes](atomic.md).

## 8. Unpack a ZIP

```ts
import { extractArchive, resolveArchiveKind } from "@openclaw/fs-safe/archive";

const kind = resolveArchiveKind("upload.zip");
if (!kind) throw new Error("unsupported archive");

await extractArchive({
  archivePath: "/srv/jobs/incoming/uploads/upload.zip",
  destDir: "/srv/jobs/incoming/extracted",
  kind,
  timeoutMs: 15_000,
  limits: {
    maxArchiveBytes: 256 * 1024 * 1024,
    maxEntries: 50_000,
    maxExtractedBytes: 512 * 1024 * 1024,
    maxEntryBytes: 256 * 1024 * 1024,
    maxMetaEntryBytes: 1024 * 1024,
    maxEntryPathComponents: 64,
  },
  entryModes: "clamp",
});
```

Extraction stages into a private dir and merges through the same boundary used by direct writes, so a symlinked entry can't trick the merge into following an out-of-tree path. See [Archive extraction](archive.md).

## 9. Get a private scratch directory

```ts
import { withTempWorkspace } from "@openclaw/fs-safe/temp";

await withTempWorkspace({ rootDir: "/srv/jobs/tmp", prefix: "build-" }, async (workspace) => {
  await workspace.copyIn("input.bin", "/tmp/source.bin");
  // ...do work in workspace.dir; auto-cleaned on exit
});
```

The directory is mode `0700`, sits under a per-user secure temp root, and is removed when the callback returns or throws. See [Temp workspaces](temp.md).

## Where to next

- [Security model](security-model.md) — exactly what the boundary defends against, what it does not.
- [Root API](root.md) — every method on the `Root` handle, including streaming and reader callbacks.
- [Errors](errors.md) — the full code union and what each one means.
