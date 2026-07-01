# Writing

The `Root` handle exposes a tight set of write verbs. Each one is atomic at the destination — no half-written intermediate state — and goes through the same boundary checks as reads.

```ts
await fs.write("state.json", body);
await fs.create("seed.json", initial);   // throws if exists
await fs.writeJson("config.json", state);
await fs.append("logs/today.log", line);
await fs.copyIn("inbox/upload.bin", "/tmp/upload.bin");
await fs.move("notes/draft.md", "notes/published.md");
await fs.remove("logs/yesterday.log");
await fs.mkdir("snapshots/2026/05");
```

## What every write does

1. Resolve the relative target against the canonical root and reject anything that escapes (`outside-workspace`).
2. If `mkdir: true`, create missing parent directories with the parent fd pinned.
3. Open the parent directory by fd. Subsequent rename/unlink uses the parent fd, not the path string, so a parent-directory symlink swap mid-call cannot divert the write.
4. Write data to a sibling temp file in the same directory.
5. Atomically rename the temp file over the destination.
6. Stat the resulting fd and verify identity.

A failure at any point either leaves the destination at its previous contents or surfaces an `FsSafeError` — never a partially-written file at the destination path.

## Denying mutations

All mutation verbs accept `denyMutations?: DenyMutationPolicy`, either as a root default or per-call option:

```ts
const fs = await root("/srv/workspace", {
  denyMutations: {
    paths: ["/srv/workspace/.env"],
    prefixes: ["/srv/workspace/.ssh"],
  },
});

await fs.write(".env", "x");       // throws FsSafeError code "denied-path"
await fs.remove(".ssh/id_rsa");    // throws FsSafeError code "denied-path"
```

`paths` blocks exact absolute paths. `prefixes` blocks absolute paths and everything below them. fs-safe preserves path strings exactly and canonicalizes through existing ancestors before comparing, so a mutation through a symlinked ancestor to a denied path is still denied. Root-level and per-call policies are additive; per-call policy can add denies, but cannot clear root defaults.

## Write verbs

### `fs.write(rel, data, options?)`

Overwrite or create. Always atomic.

```ts
await fs.write("state/last-run.json", JSON.stringify(run));
await fs.write("notes/today.txt", "hello\n", { encoding: "utf8" });
```

`data` accepts `string | Buffer`. `options` are `{ denyMutations?: DenyMutationPolicy; encoding?: BufferEncoding; mkdir?: boolean; mode?: number; overwrite?: boolean }`. `mode` sets the file's POSIX mode; if omitted, falls back to the `mode` from `RootDefaults` and then to umask. `overwrite` defaults to `true`; set it to `false` for the same no-clobber behavior as `create()`.

### `fs.create(rel, data, options?)`

Don't-clobber variant of `write()`. Throws `already-exists` if the target is there.

```ts
try {
  await fs.create("config/seed.json", initial);
} catch (err) {
  if (err instanceof FsSafeError && err.code !== "already-exists") throw err;
}
```

### `fs.writeJson(rel, value, options?)`

`JSON.stringify(value, replacer, space)` + atomic write. Adds a trailing newline by default.

```ts
await fs.writeJson("config.json", state, { space: 2 });
await fs.writeJson("compact.json", state, { trailingNewline: false });
```

Options:

```ts
type RootWriteJsonOptions = {
  encoding?: BufferEncoding;
  mkdir?: boolean;
  mode?: number;
  replacer?: (this: any, key: string, value: any) => any | (number | string)[];
  space?: number | string;
  trailingNewline?: boolean; // default true
};
```

`createJson(rel, value, options?)` is the don't-clobber variant.

### `fs.append(rel, data, options?)`

Open in append mode, write, sync the file handle, and close. Honors `mkdir` for the parent directory and syncs the parent directory when the append creates the file. Pass `prependNewlineIfNeeded: true` to insert a `\n` if the file does not already end in one.

```ts
await fs.append("logs/today.log", `[${ts}] ${line}\n`);
await fs.append("notes/scratch.md", "* new bullet", { prependNewlineIfNeeded: true });
```

For high-volume logging, consider [`openWritable`](#openwritable) and a long-lived append handle. Direct append-mode writes preserve kernel append semantics, but they are not atomic against external rotators that rename or unlink the target.

### `fs.copyIn(rel, sourceAbsPath, options?)`

Bring a file from outside the root into the root, atomically. The source path must be absolute. The library streams the source through the boundary, writes to a sibling temp, and renames over the destination.

```ts
await fs.copyIn("inbox/upload.bin", "/tmp/incoming.bin", {
  maxBytes: 64 * 1024 * 1024,
});
```

Options: `{ encoding?, mkdir?, maxBytes?, sourceHardlinks? }`. Use `sourceHardlinks: "reject"` to refuse if the source itself is a hardlinked alias.

### `fs.move(from, to, options?)`

Rename one path inside the root to another. Defaults to no clobber:

```ts
await fs.move("incoming/foo.txt", "archive/foo.txt");
await fs.move("incoming/foo.txt", "archive/foo.txt", { overwrite: true });
```

Both `from` and `to` are bounded; `..` in either is rejected.

### `fs.remove(rel)`

Unlink a file or `rmdir` an empty directory. Non-empty directories throw `not-empty`. For atomic directory replacement, use [`replaceDirectoryAtomic`](atomic.md#replacedirectoryatomic).

```ts
await fs.remove("logs/yesterday.log");
await fs.remove("snapshots/empty-dir"); // ok
await fs.remove("snapshots/full-dir");  // throws not-empty
```

### `fs.mkdir(rel)`

`mkdir -p`. Creates missing parents.

```ts
await fs.mkdir("snapshots/2026/05");
```

### `fs.ensureRoot()`

Treats `""` / `"."` as the root itself. Useful when a generic helper computes a relative directory and might end up at the root.

```ts
const targetRel = path.relative(fs.rootReal, candidateAbs); // could be "" if candidateAbs === root
await fs.ensureRoot(); // accepts "" without throwing
```

## `openWritable()` for streaming

When `write` doesn't fit (very large outputs, slow producers), open a writable handle:

```ts
const opened = await fs.openWritable("logs/current.log", { writeMode: "append" });
try {
  for await (const chunk of source) {
    await opened.handle.appendFile(chunk);
  }
} finally {
  await opened.handle.close();
}
```

Options: `{ mkdir?, mode?, writeMode? }`, where `writeMode` is `"replace"` (default), `"append"`, or `"update"`. `replace` truncates existing files; `update` keeps existing contents. Streaming writes go directly to the destination — there is no atomic-rename step. If you need both streaming and atomicity, write to a sibling temp yourself and rename when done; the [`atomic`](atomic.md) helpers can do this for you.

## Write defaults vs per-call options

Set `mkdir: true` once on `root()`; pass text encodings per call when needed:

```ts
const fs = await root("/srv/workspace", {
  mkdir: true,
});

await fs.write("notes/today.txt", "ascii", { encoding: "utf8" });
await fs.write("data/blob.bin", buffer);     // mkdir true, no encoding because data is Buffer
await fs.write("data/blob.bin", buffer, { mkdir: false }); // override
```

## Errors you'll catch

| Code | When |
|---|---|
| `outside-workspace` | Target resolves outside the root. |
| `already-exists` | `create()` / `createJson()` / `move({ overwrite: false })` hit an existing target. |
| `not-found` | Parent does not exist and `mkdir` is false. |
| `not-empty` | `remove()` on a non-empty directory. |
| `not-removable` | `remove()` could not unlink/rmdir (typically permissions or device busy). |
| `path-mismatch` | Post-write fd identity check did not match. Almost always a parallel writer, or a FUSE mount with unstable inode numbers — see `renameIdentity` below. |
| `too-large` | `copyIn()` source exceeded `maxBytes`. |
| `symlink` | A path component is a symlink and policy is `reject`. |
| `hardlink` | `sourceHardlinks: "reject"` saw `nlink > 1`. |

Full list in [Errors](errors.md).

## Common patterns

### Replace if changed

```ts
const next = JSON.stringify(state);
const prev = await fs.readText("state.json").catch(() => "");
if (prev !== next) await fs.write("state.json", next);
```

### Stage many writes, then commit

```ts
const stagingDir = "snapshots/incoming";
await fs.mkdir(stagingDir);
for (const file of files) await fs.write(`${stagingDir}/${file.name}`, file.body);
await fs.move(stagingDir, "snapshots/2026-05-05", { overwrite: true });
```

For a true commit-or-rollback over a *directory*, use [`replaceDirectoryAtomic`](atomic.md#replacedirectoryatomic).

### Rotate logs

```ts
const today = `logs/${formatDate(new Date())}.log`;
try {
  await fs.create(today, "");
} catch (err) {
  if (!(err instanceof FsSafeError) || err.code !== "already-exists") throw err;
}
await fs.append(today, line);
```

## FUSE mounts and unstable inode numbers

Some FUSE mounts — rclone is a confirmed example — assign the destination a different inode number from the source temp file as a result of rename, even within a single process with zero concurrency. Repeated stats of an unchanged destination remain stable, but the source-to-destination `(dev, ino)` comparison always fails with `path-mismatch`.

Set `renameIdentity: "verify-content-with-lock"` on the root (or per call) to use a SHA-256 content comparison under a cooperative sidecar lock instead:

```ts
const fs = await root("/mnt/rclone-workspace", {
  renameIdentity: "verify-content-with-lock",
});

await fs.write("state.json", body); // succeeds on rclone FUSE
```

**How it works.** The full write runs under an exclusive sidecar lock at `{targetPath}.lock`. The guarded Node fallback accepts the source-temp-to-destination inode mismatch only when the SHA-256 of the re-read bytes matches the SHA-256 of the bytes written. Subsequent path identity checks remain strict, so this mode requires an unchanged destination path to report stable identity. It deliberately bypasses the stricter fd-relative Python helper because that helper requires rename to preserve inode identity. The lock is released before the call returns.

**Security note.** `verify-content-with-lock` proves that the bytes observed after rename match the requested write and prevents *cooperating* writers from interleaving. It does **not** prove that the destination still names the temp-file object, retain the Python helper's fd-relative parent pinning, or stop a same-UID process that ignores the advisory lock. Do not use this option on directories writable by untrusted same-UID processes. Strict identity verification remains the default.

Lock recovery is fail-closed. If a process crashes and leaves `{targetPath}.lock`, a later write reports the stale lock instead of deleting it based on a host-local PID. Remove a stale sidecar only after proving that its holder can no longer write, using the application-owned recovery guidance in [File lock](sidecar-lock.md#stale-recovery-remove-if-unchanged).

## See also

- [Atomic writes](atomic.md) — the lower-level `replaceFileAtomic` and friends.
- [JSON files](json.md) — standalone JSON helpers without going through `root()`.
- [Reading](reading.md) — companion read API.
- [Errors](errors.md) — every code, when it fires.
