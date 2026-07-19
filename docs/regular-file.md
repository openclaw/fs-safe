# Regular file helpers

The advanced `regular-file` helpers provide direct read/append/stat helpers for absolute file paths, with an explicit "regular file or nothing" contract. Useful when you have a trusted absolute path and want a thin layer on top of `fs` that:

- refuses non-regular files (directories, FIFOs, sockets, symlinks)
- enforces a `maxBytes` read cap
- separates "missing" from "io-error" in the result type

```ts
import {
  readRegularFile,
  readRegularFileSync,
  appendRegularFile,
  appendRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFile,
  statRegularFileSync,
  type AppendRegularFileOptions,
  type RegularFileStatResult,
} from "@openclaw/fs-safe/advanced";
```

## Stat

### `statRegularFile(filePath)`

Async. Returns:

```ts
type RegularFileStatResult =
  | { missing: true }
  | { missing: false; stat: Stats };
```

A non-regular file (directory, FIFO, symlink, …) throws. Missing paths return
`{ missing: true }`; existing regular files return `{ missing: false, stat }`.

```ts
import { statRegularFile } from "@openclaw/fs-safe/advanced";

const r = await statRegularFile("/var/log/app.log");
if (r.missing) return;
console.log(`size=${r.stat.size}`);
```

### `statRegularFileSync(filePath)`

Synchronous variant. Same shape.

## Read

### `readRegularFile(params)`

Async. Reads the entire file into a Buffer if it is a regular file, with `maxBytes` enforcement.

```ts
import { readRegularFile } from "@openclaw/fs-safe/advanced";

const result = await readRegularFile({
  filePath: "/var/log/app.log",
  maxBytes: 4 * 1024 * 1024,
});
processLog(result.buffer);
```

The result is `{ buffer, stat }`. Missing files preserve the normal `ENOENT`
shape; non-regular targets throw.

Throws `FsSafeError` with code `too-large` if the file exceeds `maxBytes`. Other I/O errors propagate as `NodeJS.ErrnoException`.

### `readRegularFileSync(params)`

Synchronous variant. Same shape; the only required field is `filePath`. `maxBytes` is optional.

## Append

### `appendRegularFile(options)`

Async. Opens the file in append mode, writes data, closes. Refuses non-regular targets:

```ts
import { appendRegularFile } from "@openclaw/fs-safe/advanced";

await appendRegularFile({
  filePath: "/var/log/app.log",
  content: `[${new Date().toISOString()}] ${line}\n`,
  encoding: "utf8",
});
```

### Options

```ts
type AppendRegularFileOptions = {
  filePath: string;
  content: string | Uint8Array;
  encoding?: BufferEncoding; // default utf8 when content is string
  maxFileBytes?: number;     // skip if the resulting file would exceed this
  mode?: number;             // default 0o600
  rejectSymlinkParents?: boolean;
};
```

The helper refuses symlink and hardlinked final targets. With
`rejectSymlinkParents: true`, it also rejects symlinked ancestor directories.

### `appendRegularFileSync(options)`

Synchronous. Same options.

### `resolveRegularFileAppendFlags()`

Helper that returns the append helpers' `O_WRONLY | O_APPEND | O_CREAT` flags,
plus `O_NOFOLLOW` where the platform provides it:

```ts
import { resolveRegularFileAppendFlags } from "@openclaw/fs-safe/advanced";

const flags = resolveRegularFileAppendFlags();
```

## Difference from `Root` methods

| `regular-file` | `Root` |
|---|---|
| Absolute paths only. | Relative to the root. |
| Verifies path and descriptor identity around reads. | Enforces the same checks within a trusted root. |
| Caller must be confident the path is trusted. | Boundary check is automatic. |
| Stat reports missing explicitly; reads throw on missing/non-file. | Throws `FsSafeError` with `code`. |

If your call site already trusts the path (it came from your own config, not a caller), `regular-file` is a thinner, faster surface. If the path is caller-influenced, prefer `root()` or wrap in [`pathScope()`](path-scope.md).

## Common patterns

### Read a config file if it's there, else seed

```ts
const info = await statRegularFile("/etc/app/config.json");
if (info.missing) {
  await writeJson("/etc/app/config.json", defaultConfig);
} else {
  const r = await readRegularFile({
    filePath: "/etc/app/config.json",
    maxBytes: 64 * 1024,
  });
  applyConfig(JSON.parse(r.buffer.toString("utf8")));
}
```

### Cheap "exists and is a file" check

```ts
const r = await statRegularFile(p);
if (r.missing) return false;
return true;
```

### Bounded log tail

```ts
const r = await readRegularFile({ filePath: logPath, maxBytes: 1 * 1024 * 1024 });
return r.buffer.toString("utf8").split("\n").slice(-100);
```

## See also

- [Reading](reading.md) — `Root` reads with boundary checks.
- [Atomic writes](atomic.md) — for atomic write semantics, prefer `replaceFileAtomic`.
- [`fs.appendFile`](https://nodejs.org/api/fs.html#fsappendfilepath-data-options-callback) — Node's stock append, without regular-file gating.
