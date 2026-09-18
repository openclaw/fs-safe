# Writing

The `Root` handle exposes a tight set of mutation verbs. Replacement writes
(`write`, `writeJson`, and `copyIn`) publish with a sibling-temp commit so no
half-written replacement appears at the destination. Create-only writes
(`create`, `createJson`, and `write` with `overwrite: false`) use sibling-temp
staging with an atomic no-replace rename only on backends that provide one —
the native binding, which `require` mode guarantees and `auto` mode uses when
the binding loads. The pure-JavaScript fallback has no atomic no-clobber
rename and does not stage: it claims the final name exclusively with `O_EXCL`
and writes content in place, so a concurrent observer can see the new file
before its content is complete. Use `require` mode when that visibility window
matters.
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
2. If `mkdir: true`, create missing parent directories relative to a pinned parent fd in the native path, or with per-component identity guards in the JavaScript fallback. When `denyMutations` or an explicit `mutationSymlinks` policy is present, each missing POSIX-native component is authorized before creation and its opened descriptor is authorized again before descent.
3. Pin or guard the parent directory for the selected mechanism. Native operations use a parent fd and reapply configured mutation policy to the actual canonical destination selected by that descriptor; the pinned JavaScript fallback verifies directory identity before and after mutation and performs the same policy revalidation before its pathname dispatch. The JavaScript check cannot make the intervening pathname syscall atomic, so a same-privilege peer that can replace the parent may cause an out-of-root side effect before detection. Use native `require` mode for that threat model; see the [security model](security-model.md#symlinks-write-side).
4. Write data to a sibling temp file in the same directory.
5. Atomically rename the temp file over the destination.
6. Stat the resulting fd and verify identity.

Private sibling temporary names are independent of the destination basename,
so staging does not add a suffix to an otherwise valid long filename.

Write paths reject `path-alias` when symlinks and parent components select a
different target before and after lexical normalization, such as `link/../file`
where `link` points into a deeper directory. This avoids silently modifying the
wrong file. Resolve an intended alias explicitly with `Root.resolve()` before
passing its canonical path to a mutation.

A failure before the final rename leaves the destination at its previous
contents. A successful rename publishes the complete replacement. This
old-or-new guarantee does not apply to `append()` or `openWritable()`, which
write in place, or to lower-level atomic helpers when their explicitly
non-atomic permission-error copy fallback is enabled.

Post-publication verification can still reject after a complete replacement has
been committed. Rejection does not promise that a successful rename was rolled
back; the published file or a raced replacement may remain at the destination.

Failed-write cleanup compares exact parent and file identities, including large
Windows file indexes. Replaced paths and paths whose ownership cannot be verified
are preserved.

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

`paths` blocks exact absolute paths. `prefixes` blocks absolute paths and everything below them. For POSIX pinned `write`, `create`, and `copyIn`, an existing exact-path directory does not implicitly deny a mutation to its descendants, but creating a missing directory at that exact path is itself denied. fs-safe preserves path strings exactly and canonicalizes through existing ancestors before comparing, so a mutation through a symlinked ancestor to a denied path is still denied. Root-level and per-call policies are additive; per-call policy can add denies, but cannot clear root defaults. Those POSIX pinned operations snapshot the merged policy before their first path observation, then authorize the actual descriptor-selected parent before staging or publication. A caller mutation of the original arrays, or a contained parent redirect after preflight, cannot clear that admission check.

## Write verbs

### `fs.write(rel, data, options?)`

Overwrite or create. Always atomic.

```ts
await fs.write("state/last-run.json", JSON.stringify(run));
await fs.write("notes/today.txt", "hello\n", { encoding: "utf8" });
```

`data` accepts `string | Buffer`. `mode` sets the file's POSIX mode. If neither the call nor `RootDefaults` supplies it, a replacement preserves the existing file mode and a new file uses `0o600`. `mkdir` and `overwrite` both default to `true`; set `overwrite: false` for the same no-clobber behavior as `create()`.

#### Write options

| Option | Type | Default / behavior |
|---|---|---|
| `denyMutations` | `DenyMutationPolicy` | Merged with root-level denies. |
| `durable` | `boolean` | `true`; use `false` to skip file and parent fsync. |
| `encoding` | `BufferEncoding` | `"utf8"` for strings. |
| `mkdir` | `boolean` | `true`; creates missing parents. |
| `mode` | `number` | Inherited on replacement, otherwise `0o600`. |
| `overwrite` | `boolean` | `true`; `false` is create-only. |
| `renameIdentity` | `RenameIdentityPolicy` | `"strict"`. |

`write`, `create`, `writeJson`, `createJson`, `append`, and `copyIn` accept `durable`.
Precedence is per-call option, then `Root.defaults.durable`, then `true`;
an explicitly `undefined` call option preserves the root default.
`durable: false` keeps the sibling-temp replace/rename behavior of replacement
writes but skips file and parent-directory fsync calls. Create-only and append
publication behavior, permissions, identity checks, and error codes are unchanged.
Use it only for reconstructible data: a crash may lose the write or leave the
previous file. `move` and streaming `openWritable` do not use this option.
Native and pure-JavaScript Windows writers honor the option. Replacement writes
sync staged content before rename and the final mode through the retained file
handle. Directory sync remains best-effort.

POSIX modes without read permission, including `0o000` and `0o200`, succeed:
final verification uses a descriptor retained by the writer rather than reopening
the published file. The requested mode is not relaxed for verification.
Publication verification compares exact bigint descriptor and pathname identities,
including large file indexes that cannot be represented by a JavaScript number.
With durability enabled (the default), native publication syncs content before rename and syncs the parent directory.
Modes that retain owner read/write skip the extra mode-only file sync: after a
crash, the file may retain staged mode `0o600` instead of the wider requested mode.
Modes that remove owner read or write, and corrections of observed wider staging
permissions, keep the post-chmod file sync.
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
Create-only preflight preserves boundary, alias, hardlink, and type checks without
opening an existing target to inherit its mode; a fresh file uses the requested
mode or the normal new-file default. When the native binding is in use
(`require` mode, or `auto` mode with a successfully loaded binding), content is
staged privately and published with an atomic no-replace rename, so the name
never appears before its bytes. In the pure-JavaScript fallback the name is
claimed exclusively first and content is written afterward, so observers can
briefly see an empty file; failure cleanup removes a claimed file only when its
identity is unchanged.

```ts
try {
  await fs.create("config/seed.json", initial);
} catch (err) {
  if (err instanceof FsSafeError && err.code !== "already-exists") throw err;
}
```

### Streamed creation

Pass an `AsyncIterable<Uint8Array>` to `create()` when bytes come from a database,
network response, or another incremental producer. Buffers are accepted chunks.
The writer consumes each chunk completely before requesting the next one; it
does not collect the full input in memory or expose a writable descriptor.

```ts
async function* snapshotChunks(): AsyncGenerator<Uint8Array> {
  yield Buffer.from("first stored chunk\n");
  yield Buffer.from("second stored chunk\n");
}

await fs.create("restored/config.txt", snapshotChunks(), {
  mode: 0o600,
  maxBytes: 8 * 1024 * 1024,
  durable: false,
  signal: AbortSignal.timeout(30_000),
});
```

`RootCreateStreamOptions` keeps `mkdir`, `mode`, `durable`,
`assertBeforeMutation`, `denyMutations`, and `mutationSymlinks` from buffered
creation and adds `maxBytes` and `signal`. Byte chunks have no encoding option;
streamed creation uses strict publication identity and does not support
`renameIdentity: "verify-content-with-lock"`. Existing Root defaults apply,
including explicit `maxBytes`; with no byte cap at either level, input size is
unlimited. Zero permits an empty input only. Invalid limits reject before I/O.

Unlike buffered creation's JavaScript fallback, streamed creation stages all
chunks before publishing the final name. Native mode uses no-replace rename;
the JavaScript fallback hardlinks the completed stage and removes its temporary
name in the same JavaScript turn. That fallback requires a filesystem supporting
hardlinks; other processes may briefly observe both names. An existing or
concurrently created destination is preserved. Existing-target preflight does
not consume the input. The final mode and durability policy use the same guarded
writer as other Root operations.

Cancellation checks run before and after producer pulls, before content writes,
and before publication. `assertBeforeMutation` also rechecks current application
authority after producer waits and before each partial write. The operation
waits for any pending producer pull or filesystem write, then awaits the
producer's `return()` and cleans only the owned unpublished stage. Pass the same
signal into a producer that may stall: an arbitrary async iterator cannot be
forcibly interrupted, so cancellation waits for its pending work and cleanup to
settle. Do not mutate a yielded chunk until the next pull. Producer errors retain
their original value when cleanup succeeds.

An aborted or failed operation can leave created parent directories. If a
stage's identity or parent cannot be verified during cleanup, the existing
guarded cleanup preserves it. After publication, later verification or cleanup
failures preserve the destination; rejection does not prove that no file was
created. Cancellation arriving after publication does not undo the completed
file. Application recovery remains caller-owned.

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

Open in append mode, write, sync the file handle, and close. Honors `mkdir` for the parent directory and syncs the parent directory when the append creates the file. `durable: false` skips both syncs. Pass `prependNewlineIfNeeded: true` to insert a `\n` if the file does not already end in one.

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

Options are `{ denyMutations?, durable?, maxBytes?, mkdir?, mode?, sourceHardlinks? }`.
`durable` follows the root default and is `true` when omitted at both levels;
set it to `false` to skip file and parent-directory syncs for reconstructible data.
Use `sourceHardlinks: "reject"` to refuse if the source itself is a hardlinked
alias. There is no encoding option: copying preserves source bytes.

### `fs.move(from, to, options?)`

Rename one path inside the root to another. Defaults to no clobber:

```ts
await fs.move("incoming/foo.txt", "archive/foo.txt");
await fs.move("incoming/foo.txt", "archive/foo.txt", { overwrite: true });
```

Both `from` and `to` are bounded; `..` in either is rejected.

Mutation policy is captured at call start; changes to caller-owned denial arrays
apply to later moves. For live cancellation or revocation, throw from
`assertBeforeMutation` immediately before dispatch.

The default no-clobber mode requires the native helper. It admits both parent
directory descriptors and performs a descriptor-relative no-replace rename, so
a competitor that creates the target first is preserved and the source remains
in place. If the helper or safe parent admission is unavailable, the call fails
with `helper-unavailable`; it never falls back to a check followed by a
replacing rename. After dispatch it rechecks both parent identities, so a
post-operation rejection can mean the no-replace rename completed. Directory
moves continue to require `overwrite: true`.

Both selected canonical endpoints are admitted inside the retained Root after
native parent admission. With `mutationSymlinks: "reject"`, both full operation
paths are rechecked after the live mutation-authority callback and before
dispatch. The Root and retained parents are fenced again after any such callback.
These checks retain the documented final check-to-syscall race.

For `{ overwrite: true }`, the JavaScript path checks both parent directories
before and after the rename. A failed post-operation check rejects even though
the rename may already have completed; rejection does not imply rollback.

### `fs.remove(rel)`

Unlink a file or `rmdir` an empty directory. Non-empty directories throw `not-empty`. For atomic directory replacement, use [`replaceDirectoryAtomic`](atomic.md#replacedirectoryatomic).

Before a nonrecursive JavaScript fallback removal, fs-safe retains exact
Root-to-parent directory identities, with canonical endpoint checks at Root and
the immediate parent. It rejects a parent redirected through a symlink or
junction before `unlink` or `rmdir`, even with `force: true`, and rechecks the
retained ancestry after the operation settles. The entry may already have been
removed when that final verification rejects.

```ts
await fs.remove("logs/yesterday.log");
await fs.remove("snapshots/empty-dir"); // ok
await fs.remove("snapshots/full-dir");  // throws not-empty
```

For a tree, opt into bounded recursive removal:

```ts
await fs.remove("scratch/finished-job", {
  recursive: true,
  force: true,
  maxEntries: 20_000,
  maxDepth: 32,
  mutationSymlinks: "reject",
  signal: AbortSignal.timeout(30_000),
  assertBeforeMutation: () => assertJobLeaseCurrent(),
});
```

| Option | Default / behavior |
| --- | --- |
| `recursive` | `false`; opt in to removing non-empty directories. |
| `force` | `false`; `true` tolerates missing targets and vanished child entries. Other errors still reject. |
| `order` | `"filesystem"`; `"sorted"` collects and sorts child names lexicographically before descending. Requires `recursive: true`. |
| `maxEntries` | `100_000` in recursive mode; counts the requested target and every encountered child, including directories and symlinks. |
| `maxDepth` | `64` in recursive mode; the requested target has depth 0 and each child adds one. An empty directory at the limit can be removed. |
| `signal` | Stops traversal and new mutations when aborted. Already dispatched work settles and directory handles close before rejection. |

Budgets must be non-negative safe integers or explicit `Infinity`, and require
`recursive: true`. Omitted budgets retain their finite defaults. An entry or
depth limit throws `too-large` before processing the over-budget entry.

The default filesystem order streams each directory once, using memory and open
handles proportional to depth rather than directory width. Sorted order also
enumerates each directory once, but collects its names before descending and
deletes directories after their children. It uses JavaScript's default string
sort, not locale collation. Collected names consume the shared entry budget,
including sibling names still pending while an earlier directory is traversed.
With a finite budget, collection overflow rejects before processing that
directory's children; one extra name distinguishes an exact limit from overflow.
An `Infinity` entry budget uses a bulk name read while retaining the opened
directory handle and identity checks. Sorted mode retains collected names, so
unlimited budgets also permit unlimited name storage.

Sorted traversal preserves lexicographic processing, not the incidental syscall
timing of a caller that repeatedly rescans parent directories. Each child is
inspected when visited. Newly added entries can make the final `rmdir` fail with
`not-empty`; the operation does not retry indefinitely.

Recursive removal never follows a discovered symlink or junction. With an
omitted `mutationSymlinks` policy it unlinks that entry, preserving the existing
nonrecursive behavior. Both explicit mutation policies reject discovered links.
`follow-parents-within-root` permits aliases only in the requested target's
parents, and still rejects a final link. Root and per-call `denyMutations` policies
remain additive; a denied descendant prevents removal of the enclosing requested
tree before any entry is removed.

The operation retains exact identities for the traversal directories and each
observed target. Swapped or missing ancestors reject even with `force: true`;
an abort reason or authority refusal carrying `ENOENT` is not treated as absence.
Authority is rechecked immediately before each direct `unlink` or `rmdir`
dispatch. Directory handles close before their directories are removed, including
on Windows. If both traversal and close fail, `SuppressedError` retains both
failures. Directory-stream filesystem errors use the same removal codes as
`unlink` and `rmdir`, with the original error in `cause`; caller abort and
authority refusals retain their original values.

When `force: true` encounters a missing directory during an `opendir` or read,
it closes any open stream and reaches the ordinary final target check. The
surviving ancestors and original target identity are checked again; a replacement
is never accepted as a missing directory. An actually vanished child does not
prevent processing later siblings.

Filesystem failures normalized by the recursive removal owner and its direct
symlink rejections carry additional `FsSafeError.details` context:

```ts
type RemoveFailureDetails = {
  operation: "remove";
  phase: "enumerate" | "inspect" | "remove";
  relativePath: string;
};
```

`relativePath` is relative to the requested removal target, using host path
separators: `""` identifies that target and `"nested/link"` identifies a child
on POSIX. It does not replace caller spelling with the canonical Root path.
`enumerate` covers directory stream operations, `inspect` covers initial child
observations, and `remove` covers final identity checks and unlink/rmdir failures.
The existing error codes, messages, and causes remain unchanged. Errors that
already have their own identity, including caller authority and cancellation
reasons, are propagated without adding or changing their details. Context is
diagnostic; it is not permission to retry or mutate an entry.

Removal is incremental, not atomic. A later budget, cancellation, identity, or
filesystem failure does not restore already removed entries. As with existing
`remove`, this is a guarded JavaScript operation in every native mode: pathname
checks are best-effort against a hostile concurrent process and do not create
an atomic check-and-delete syscall. Use OS isolation for that threat model.

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
destination — there is no atomic-rename step. For exclusive publication of a
complete stream, use [`create()`](#streamed-creation). For streamed replacement,
the [`atomic`](atomic.md) helpers provide a staged writer.

On POSIX, existing-target opens use `O_NONBLOCK` as an admission safeguard so
a no-reader FIFO cannot stall regular-file validation. This does not change
ordinary regular-file write semantics. `replace` and `update` remain write-only
opens, including for mode `0o200` files; replacement truncation happens only
after type, identity, and boundary checks pass. Rejected existing paths are
never cleanup-owned or unlinked.

Identity admission uses bigint descriptor and pathname receipts even though the
public `stat` field remains a numeric Node `Stats` object. Windows retries an
unknown device or file index once while retaining known components, then rejects
persistent ambiguity. If admission of a newly created file fails, cleanup only
unlinks a pathname that still has the exact created identity; rounded aliases,
symlinks, and unknown identities are preserved.

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

For guarded whole-directory publication, use
[`replaceDirectoryAtomic`](atomic.md#replacedirectoryatomic). Replacing an
existing target is a two-rename protocol with a temporary target-absence
interval and conditional no-replace rollback, not a transactional
commit-or-rollback.

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

Windows `Root.write()` and `Root.writeJson()` honor this policy both as a Root default and as a per-call option. The Windows buffered writer acquires the same Root compatibility lock before creating parents, placeholders, or content. It keeps staging writable until publication, then applies the final mode through the retained destination descriptor. When content verification accepts a changed rename identity, that destination remains pinned through file sync, parent sync, and final strict identity checks.

The Windows buffered compatibility path resolves permitted in-root aliases before choosing its lock and binds publication to that effective destination. With the existing lock protocol, effective path components beneath the Root must contain only lower-case ASCII letters, digits, `.`, `_`, or `-`, with no trailing `.`. Unsupported spellings, including missing upper-case or non-ASCII names, fail with `path-alias` before mutation; no filesystem case-sensitivity or Unicode-folding behavior is guessed. This restriction does not apply to strict writes. Opaque Windows pathname identities still use strict verification against the retained original descriptor: they never, by themselves, authorize content-based acceptance of a replacement.

The library's own lock-destination check permits the writer to reuse parent
admission within that operation. The lock key and destination checks remain
unchanged, and evidence is revoked when the locked operation finishes. Supplying
an `assertBeforeMutation` callback retains full parent admission because caller
code can change the filesystem before dispatch.

Lock recovery is fail-closed. If a process crashes and leaves the root-level `.fs-safe-write-<sha256>.lock`, a later write reports the stale lock instead of deleting it based on a host-local PID. Recover only under external authority that excludes every competing writer; see [File lock](sidecar-lock.md#stale-recovery-guarded-remove-if-unchanged).

## See also

- [Atomic writes](atomic.md) — the lower-level `replaceFileAtomic` and friends.
- [JSON files](json.md) — standalone JSON helpers without going through `root()`.
- [Reading](reading.md) — companion read API.
- [Errors](errors.md) — every code, when it fires.
