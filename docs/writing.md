# Writing

The `Root` handle exposes a tight set of mutation verbs. Replacement writes
(`write`, `create`, `writeJson`, `createJson`, and `copyIn`) publish with a
sibling-temp commit so no half-written replacement appears at the destination.
`append` and `openWritable` intentionally modify an opened file in place;
`move`, `remove`, and `mkdir` mutate directory entries rather than file bytes.
Each verb applies the boundary checks appropriate to its operation.

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

## What replacement writes do

1. Resolve the relative target against the canonical root and reject anything that escapes (`outside-workspace`).
2. If `mkdir: true`, create missing parent directories relative to a pinned parent fd in the native path, or with per-component identity guards in the JavaScript fallback.
3. Pin or guard the parent directory for the selected mechanism. Native operations use a parent fd; guarded JavaScript verifies directory identity before and after mutation. The JavaScript check cannot make the intervening pathname syscall atomic, so a same-privilege peer that can replace the parent may cause an out-of-root side effect before detection. Use native `require` mode for that threat model; see the [security model](security-model.md#symlinks-write-side).
4. Write data to a sibling temp file in the same directory.
5. Atomically rename the temp file over the destination.
6. Stat the resulting fd and verify identity.

A failure before the final rename leaves the destination at its previous
contents. A successful rename publishes the complete replacement. This
old-or-new guarantee does not apply to `append()` or `openWritable()`, which
write in place, or to lower-level atomic helpers when their explicitly
non-atomic permission-error copy fallback is enabled.

Post-publication verification can still reject after a complete replacement has
been committed. Rejection does not promise that a successful rename was rolled
back; the published file or a raced replacement may remain at the destination.

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

`data` accepts `string | Buffer`. `options` are `{ denyMutations?: DenyMutationPolicy; encoding?: BufferEncoding; mkdir?: boolean; mode?: number; overwrite?: boolean; renameIdentity?: RenameIdentityPolicy }`. `mode` sets the file's POSIX mode. If neither the call nor `RootDefaults` supplies it, a replacement preserves the existing file mode and a new file uses `0o600`. `mkdir` and `overwrite` both default to `true`; set `overwrite: false` for the same no-clobber behavior as `create()`.

POSIX modes without read permission, including `0o000` and `0o200`, succeed:
final verification uses a descriptor retained by the writer rather than reopening
the published file. The requested mode is not relaxed for verification.
Publication verification compares exact bigint descriptor and pathname identities,
including large file indexes that cannot be represented by a JavaScript number.
Later reads still obey OS permissions, and access checks on a pre-existing
destination are unchanged. The explicit FUSE compatibility policy still requires
a readable destination to prove matching content when rename changes its identity.

When Windows cannot report a pathname's identity, the publication verifier reopens
the name and compares that descriptor's exact identity with the original retained
file, without reading bytes. It also rechecks links and root/parent containment.
This write-specific proof does not relax ordinary reads: unknown pathname metadata
alone is never proof that the name still refers to the expected file.

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
type RootWriteJsonOptions = RootWriteOptions & {
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

Options are `{ denyMutations?, maxBytes?, mkdir?, mode?, sourceHardlinks? }`.
Use `sourceHardlinks: "reject"` to refuse if the source itself is a hardlinked
alias. There is no encoding option: copying preserves source bytes.

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

Options are `{ denyMutations?, mkdir?, mode?, writeMode? }`, where `writeMode`
is `"replace"` (default), `"append"`, or `"update"`. `replace` truncates existing
files; `update` keeps existing contents. Streaming writes go directly to the
destination — there is no atomic-rename step. If you need both streaming and
atomicity, write to a sibling temp yourself and rename when done; the
[`atomic`](atomic.md) helpers can do this for you.

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

**How it works.** The full write runs under an exclusive per-target lock named `.fs-safe-write-<sha256>.lock` in the root. Keeping the lock in the already-canonical root avoids creating an unguarded lock path through a missing or raced target parent. The guarded Node fallback accepts the source-temp-to-destination inode mismatch only when the SHA-256 of the re-read bytes matches the SHA-256 of the bytes written. Subsequent path identity checks remain strict, so this mode requires an unchanged destination path to report stable identity. It deliberately stays on the guarded JavaScript path because content verification replaces the normal inode-preserving rename contract. The lock is released before the call returns.

**Security note.** `verify-content-with-lock` proves that the bytes observed after rename match the requested write and prevents *cooperating* writers from interleaving. It does **not** prove that the destination still names the temp-file object, retain fd-relative parent pinning, or stop a same-UID process that ignores the advisory lock. Do not use this option on directories writable by untrusted same-UID processes. Strict identity verification remains the default.

Lock recovery is fail-closed. If a process crashes and leaves the root-level `.fs-safe-write-<sha256>.lock`, a later write reports the stale lock instead of deleting it based on a host-local PID. Recover only under external authority that excludes every competing writer; see [File lock](sidecar-lock.md#stale-recovery-guarded-remove-if-unchanged).

## See also

- [Atomic writes](atomic.md) — the lower-level `replaceFileAtomic` and friends.
- [JSON files](json.md) — standalone JSON helpers without going through `root()`.
- [Reading](reading.md) — companion read API.
- [Errors](errors.md) — every code, when it fires.
