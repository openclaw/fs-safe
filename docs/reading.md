# Reading

The `Root` handle exposes five read shapes. Pick the narrowest one that gives you what you need — narrower shapes do less work and surface fewer footguns.

```ts
const result = await fs.read("notes/today.txt");        // { buffer, realPath, stat }
const text   = await fs.readText("notes/today.txt");    // string
const bytes  = await fs.readBytes("image.png");         // Buffer
const json   = await fs.readJson<Config>("config.json"); // T
const opened = await fs.open("large.log");               // FileHandle for streaming
```

## What every read does

Regardless of shape, every read goes through the same boundary checks:

1. Resolve the relative path against the canonical real root.
2. Reject anything that escapes the root (`outside-workspace`).
3. Reject `..` segments and absolute inputs (unless via `readAbsolute` with an in-root absolute path).
4. Reject known unsafe device and process-fd paths before opening (`device-path`).
5. Open with `O_NOFOLLOW` where available. A symlink in the path triggers `symlink` unless the call's `symlinks` policy is `follow-within-root`.
6. Stat the open fd and compare to the resolved path's identity (`sameFileIdentity`). A swap mid-call triggers `path-mismatch`.
7. If `hardlinks: "reject"`, refuse files with `nlink > 1` (`hardlink`).
8. If `maxBytes` is set, refuse reads larger than the cap (`too-large`).

## Read shapes

### `fs.read(rel, options?)`

The full result. Use it when you need both the bytes and the verified `realPath` or `stat`:

```ts
const { buffer, realPath, stat } = await fs.read("notes/today.txt");
console.log(`${stat.size} bytes at ${realPath}`);
```

### `fs.readText(rel, options?)`

`buffer.toString(encoding)`. Defaults to `defaults.encoding ?? "utf8"`. Pass `encoding` per call to override:

```ts
const utf16 = await fs.readText("doc.txt", { encoding: "utf16le" });
```

### `fs.readBytes(rel, options?)`

The buffer alone. Useful when you don't care about the realPath or stat:

```ts
const png = await fs.readBytes("image.png");
```

### `fs.readJson<T>(rel, options?)`

`readText` + `JSON.parse`. The generic is a *cast*, not a validator — validate the parsed value at your application boundary if it came from a less-trusted source.

```ts
type Config = { tokens: string[] };
const config = await fs.readJson<Config>("config.json");
```

For tighter control over malformed-or-missing JSON, use the standalone helpers in [`@openclaw/fs-safe/json`](json.md): `tryReadJson` (returns `null` on missing/invalid) vs `readJson` (throws).

### `fs.open(rel, options?)`

Returns a `FileHandle` plus the verified `realPath` and `stat`. Use this for streaming or partial reads, and **always close the handle**:

```ts
const opened = await fs.open("large.log");
try {
  const stream = opened.handle.createReadStream();
  for await (const chunk of stream) {
    process.stdout.write(chunk);
  }
} finally {
  await opened.handle.close();
}
```

## Read options

```ts
type RootReadOptions = {
  hardlinks?: "reject" | "allow";   // override defaults.hardlinks
  maxBytes?: number;                // refuse reads larger than this many bytes
  nonBlockingRead?: boolean;        // schedule the read off the main loop
  symlinks?: "reject" | "follow-within-root"; // override defaults.symlinks
};
```

`maxBytes` is enforced eagerly: the library reads up to `maxBytes + 1` and throws `too-large` if there is more, so a hostile target cannot silently exhaust memory.

`nonBlockingRead` is a scheduling hint. It does not affect safety — it lets you keep the event loop responsive when reading large files.

## `readAbsolute()` and `reader()`

Some APIs hand you an absolute path that the caller has already produced. Going back to a relative form just to call `read()` is awkward, so the library exposes:

```ts
fs.readAbsolute(absPath, options?)   // ReadResult, abs path must be inside the root
fs.reader(options?)              // (path) => Promise<Buffer>
```

`readAbsolute` accepts absolute paths. Anything outside the root throws `outside-workspace`.

`reader()` returns a closure that takes either a relative or an absolute path and returns a Buffer. Useful for plugging `fs-safe` into framework loader hooks:

```ts
const load = fs.reader({ maxBytes: 4 * 1024 * 1024 });
await someLibrary.parseTemplate({ load });
```

## Inspection vs reading

`fs.exists`, `fs.stat`, and `fs.list` are advisory. They are safe to call to drive UI or decisions, but they do **not** pin the file:

```ts
if (await fs.exists("notes/today.txt")) {
  // the file existed when stat() ran — it may not now
  const text = await fs.readText("notes/today.txt"); // this is the call that pins
}
```

A symlink swap between `exists` and `readText` is caught by the read; the boundary is per-call.

## Streaming patterns

### Read into a writable stream

```ts
import { pipeline } from "node:stream/promises";

const opened = await fs.open("large.log");
try {
  await pipeline(opened.handle.createReadStream(), process.stdout);
} finally {
  await opened.handle.close();
}
```

### Read in chunks

```ts
const opened = await fs.open("large.bin");
try {
  const buf = Buffer.alloc(64 * 1024);
  let off = 0;
  while (true) {
    const { bytesRead } = await opened.handle.read(buf, 0, buf.length, off);
    if (bytesRead === 0) break;
    consume(buf.subarray(0, bytesRead));
    off += bytesRead;
  }
} finally {
  await opened.handle.close();
}
```

## Common errors

- **`outside-workspace`** — relative path escaped the root, or `readAbsolute` got an absolute path outside.
- **`not-found`** — the file is gone.
- **`not-file`** — you read a directory or a non-regular file (FIFO, socket, …).
- **`device-path`** — the path targets a known unsafe device or process fd path.
- **`symlink`** — a path component is a symlink and the policy is `reject`.
- **`path-mismatch`** — opened fd identity did not match the resolved path. Almost always a TOCTOU swap by something else.
- **`hardlink`** — `hardlinks: "reject"` saw `nlink > 1`.
- **`too-large`** — read exceeded `maxBytes`.

See [Errors](errors.md) for the full list.

## See also

- [Writing](writing.md) — companion verbs for produce-side I/O.
- [JSON files](json.md) — standalone strict/lenient JSON helpers.
- [Secure file reads](secure-file.md) — pinned absolute file reads with permission checks.
