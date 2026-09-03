# File store

`fileStore` is exported from `@openclaw/fs-safe/store`. It is a managed wrapper around `root()` for the common "store files under a directory at known modes, prune old ones, hand back absolute paths" pattern. Useful for caches, ingest staging, generated artifacts, anywhere the consumer wants object-style access plus stream and copy primitives.

```ts
import {
  fileStore,
  type FileStore,
  type FileStoreOptions,
  type FileStoreWriteOptions,
  type FileStorePruneOptions,
} from "@openclaw/fs-safe/store";
```

## When to reach for it

- You want a single directory holding files written by your code, with consistent mode bits and atomic placement.
- You want a `FileStore.write(rel, data)` / `read(rel)` / `pruneExpired(...)` interface.
- You want to feed a stream into the store with a byte cap.
- You don't need the full `Root` surface (move, list, mkdir, …); the store can hand you a real `Root` via `.root()` when you do.

## Factory: `fileStore(options)`

```ts
const cache = fileStore({
  rootDir: "/var/cache/app",
  mode: 0o600,        // file mode for writes (default 0o600)
  dirMode: 0o700,     // mode for parent directories created on demand (default 0o700)
  maxBytes: 64 * 1024 * 1024, // optional: refuse writes/reads larger than this
  private: true,      // use secret-file atomic writes for private state
});
```

Store and per-call `maxBytes` values must be non-negative safe integers or positive `Infinity`. Zero is an active zero-byte cap; `Infinity` disables the cap. An omitted or explicitly `undefined` per-call value preserves the store-level limit. The same rule applies to buffer writes, streams, copies, async reads, and synchronous reads/writes.

Use `private: true` for credentials, auth profiles, tokens, and other private
state. Private mode keeps the same `FileStore` shape but routes writes through
the secret-file atomic path, refusing symlink parent components and re-asserting
mode after rename.

Returns a `FileStore`:

```ts
type FileStore = {
  readonly rootDir: string;
  path(relativePath: string): string;
  root(): Promise<Root>;
  write(rel, data: string | Uint8Array, options?): Promise<string>;
  writeStream(rel, stream: Readable, options?): Promise<string>;
  copyIn(rel, sourcePath: string, options?): Promise<string>;
  open(rel, options?): Promise<OpenResult>;
  read(rel, options?): Promise<ReadResult>;
  readBytes(rel, options?): Promise<Buffer>;
  readText(rel, options?): Promise<string>;
  readTextIfExists(rel, options?): Promise<string | null>;
  readJson<T = unknown>(rel, options?): Promise<T>;
  readJsonIfExists<T = unknown>(rel, options?): Promise<T | null>;
  writeText(rel, data: string | Uint8Array, options?): Promise<string>;
  writeJson(rel, data: unknown, options?): Promise<string>;
  json<T = unknown>(rel, options?): JsonStore<T>;
  remove(rel): Promise<void>;
  exists(rel): Promise<boolean>;
  pruneExpired(options: FileStorePruneOptions): Promise<void>;
};
```

`path()` returns the absolute path the store would use, after asserting it stays inside `rootDir`. Useful for logging or for handing to other libraries.

Every `relativePath` is a portable store key. The same lexical policy applies
to every keyed async and sync method, including reads, `exists`, `remove`,
`path()`, and `json()` construction, with either `private: false` or `true`.
Keys must use their exact canonical spelling; the store never trims, normalizes,
or converts one caller-supplied key onto another:

- Keys are nonempty NFC Unicode strings without surrounding whitespace or NUL.
- Segments are separated by a single forward slash. Empty segments, repeated or
  trailing slashes, and complete `.` or `..` segments are rejected, including
  `./b`, `a/./b`, and `a/../b`.
- Every backslash is rejected on every platform, including a literal POSIX
  `a\b` filename. POSIX and Windows absolute, rooted, UNC, and extended paths
  are rejected.
- Windows drive-relative segments such as `C:name` or `C:` are rejected
  anywhere in a key, including `a/C:name`.
- No segment may end in an ASCII dot or space.

Violations report `invalid-path` when key validation is reached. Ordinary nested
keys, NFC Unicode such as `café/日本語.txt`, `.hidden`, `a..b`, and internal spaces
such as `internal space/a b.txt` are accepted. Colons elsewhere, such as the
timestamp in `logs/2026-08-02T10:30:00Z.log`, remain lexically valid; filesystem
success still depends on the platform and the underlying Root policies.

Validation retains each method's operation order. Async reads, `exists`, and
`remove` open the root first: if the root is missing, strict methods report
`not-found` and `readTextIfExists` / `readJsonIfExists` return `null`, even for an
invalid key. With an existing root, those same invalid keys report `invalid-path`.
Private `copyIn` checks and reads its source before validating the destination
key, and `writeJson` serializes its value before validating the key. Key rejection
therefore does not imply that no filesystem access or serialization occurred.

`root()` returns a [`Root`](root.md) handle for the same directory when you need the full surface (move, list, mkdir). It's a fresh handle per call and is safe to call frequently.

## Writes

Every write goes through `writeSiblingTempFile` — temp + rename, mode applied to file and parent dir, both `fsync`'d.

### `write(rel, data, options?)`

```ts
const path = await cache.write("entries/2026/05/05.json", JSON.stringify(entry));
```

Buffer or string. Returns the final absolute path. Throws `too-large` if `data.byteLength` exceeds `maxBytes`.

### `writeText(rel, data, options?)` / `writeJson(rel, data, options?)`

Convenience wrappers over `write`. `writeJson` pretty-prints with a trailing newline by default and accepts `{ trailingNewline: false }` when the exact bytes matter.

### `json<T>(rel, options?)`

Returns a typed single-file JSON state helper for a file under this store. It
inherits the store's root, mode, max-size, and private-write policy, then adds
`readOr`, `readRequired`, `update`, `updateOr`, and optional sidecar locking:

```ts
const state = cache.json<State>("state/settings.json", { lock: true });
await state.updateOr(defaultState, (current) => ({ ...current, enabled: true }));
```

Use this when one JSON file owns one piece of state. `jsonStore({ filePath })`
is the absolute-path convenience wrapper for the same primitive.

### `writeStream(rel, stream, options?)`

```ts
import { Readable } from "node:stream";
const path = await cache.writeStream("downloads/blob.bin", Readable.from(remoteFetch));
```

Streams into a sibling temp with a running byte budget. Aborts the source stream with `too-large` if `maxBytes` is exceeded mid-stream — partial writes are cleaned up.

### `copyIn(rel, sourcePath, options?)`

```ts
const path = await cache.copyIn("ingest/upload.bin", "/tmp/upload.bin");
```

One-shot ingest from an absolute source path. Source is checked for symlink/non-regular before copy. Same mode rules as `write`.

### `FileStoreWriteOptions`

Per-call overrides for the store-level defaults:

```ts
type FileStoreWriteOptions = {
  dirMode?: number;
  mode?: number;
  maxBytes?: number;
  tempPrefix?: string;  // override the default "." + basename
};
```

## Reads

`open`, `read`, `readBytes`, `readText`, and `readJson` delegate to a fresh `Root` with `hardlinks: "reject"` and the store's `maxBytes`. Same return shapes as `Root`.
Async and sync reads both report `not-file` when the key names a directory;
stable hardlinks and symlinks retain `hardlink` and `symlink`. The `IfExists`
methods return their nullish result only for `not-found`. Operational filesystem
read failures use `read-failed` with the Node error retained in `cause`.

## `remove(rel)` / `exists(rel)`

Forward to the underlying `Root`. `remove` unlinks files and `rmdir`s empty directories; non-empty dirs throw `not-empty`.

## `pruneExpired(options)`

Walk the store and delete files older than `options.ttlMs`:

```ts
await cache.pruneExpired({
  ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  recursive: true,
  pruneEmptyDirs: true,
});
```

Options:

```ts
type FileStorePruneOptions = {
  ttlMs: number;
  recursive?: boolean;       // default false (top-level only)
  maxDepth?: number;         // bound recursion explicitly
  pruneEmptyDirs?: boolean;  // also remove dirs that became empty (only with recursive/maxDepth)
};
```

Symlinks are skipped. The walk is best-effort — failures on individual entries don't abort the whole prune. Compares against `mtimeMs`.

## Difference from `Root`

| `FileStore` | `Root` |
|---|---|
| Object-style with mode+dirMode baked in. | Method-style boundary; mode is per-call or per-default. |
| `writeStream` with built-in byte budget. | Manual via `openWritable()`. |
| `writeText` / `writeJson` return the final absolute path. | `Root.write` / `writeJson` return void. |
| `copyIn` returns the final absolute path. | `Root.copyIn` returns void. |
| `pruneExpired` walks by `mtime`. | No prune helper. |
| Reads delegate via `Root` internally. | The boundary itself. |

If you need richer ops (move, list, append, mkdir), call `store.root()` to get a `Root` and use that.

`FileStore` owns portable key identity; `Root` owns filesystem confinement.
Existing-object Root lookups intentionally retain broader confined path
compatibility, including in-root absolute paths and parent-segment spellings,
and literal backslashes on POSIX. FileStore rejects those spellings even when
Root could resolve them safely inside the directory. This key policy does not
change Root's containment checks or the absolute-path `jsonStore({ filePath })`
contract.

## Common patterns

### Cache with TTL prune

```ts
const cache = fileStore({ rootDir: "/var/cache/app", maxBytes: 16 * 1024 * 1024 });

await cache.writeStream(`${id}.bin`, fetchStream(id));

// Background prune every hour
setInterval(() => cache.pruneExpired({ ttlMs: 24 * 60 * 60 * 1000 }), 60 * 60 * 1000);
```

### Ingest pipeline

```ts
const ingest = fileStore({ rootDir: "/srv/ingest", mode: 0o644 });

for (const upload of uploads) {
  const dest = await ingest.copyIn(`raw/${upload.id}`, upload.tempPath, {
    maxBytes: 200 * 1024 * 1024,
  });
  await enqueueProcess(dest);
}
```

### Drop down to `Root` for moves

```ts
const root = await store.root();
await root.move(`pending/${id}`, `done/${id}`);
```

## See also

- [`root()`](root.md) — the boundary `FileStore` is built on; reach for it when you need move/list/append.
- [JSON store](json-store.md) — the JSON-state-file equivalent of this surface.
- [Atomic writes](atomic.md) — `writeSiblingTempFile` is what every write goes through.
- [Temp workspaces](temp.md) — private scratch directories backed by `FileStore`.
