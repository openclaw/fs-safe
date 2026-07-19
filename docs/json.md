# JSON files

`@openclaw/fs-safe/json` is the standalone JSON surface: strict and lenient read variants plus atomic JSON writes.

```ts
import {
  tryReadJson,
  readJson,
  readJsonIfExists,
  readJsonSync,
  tryReadJsonSync,
  readRootJsonSync,
  readRootJsonObjectSync,
  readRootStructuredFileSync,
  writeJson,
  writeJsonSync,
  JsonFileReadError,
} from "@openclaw/fs-safe/json";
```

## Three reads, three failure shapes

Same input, three distinct contracts — pick the one whose error story matches your call site:

```ts
await readJson<T>("./manifest.json");      // throws JsonFileReadError on missing or invalid
await readJsonIfExists<T>("./cache.json"); // returns null on missing; throws on invalid
await tryReadJson<T>("./optional.json");   // returns null on missing or invalid
```

| Helper | Missing file | Invalid JSON |
|---|---|---|
| `readJson` | throws | throws |
| `readJsonIfExists` | `null` | throws |
| `tryReadJson` | `null` | `null` |

Use `readJson` when missing-or-malformed is a programmer error you want to surface immediately. Use `readJsonIfExists` when "file not there" is normal but malformed bytes should still page someone. Use `tryReadJson` when neither outcome should crash the caller.

`JsonFileReadError` carries `cause` so you can inspect whether the underlying failure was an `ENOENT`, a `SyntaxError`, or something else.

## Reading

### `readJson<T>(filePath, options?)`

Async strict reader. Throws `JsonFileReadError` on missing or invalid input. The cast is unchecked — validate the shape with your own schema (zod, valibot, …) if it came from an untrusted source.

```ts
const manifest = await readJson<Manifest>("./manifest.json");
const smallManifest = await readJson<Manifest>("./manifest.json", {
  maxBytes: 256 * 1024,
});
```

All standalone readers accept `{ maxBytes?: number }`. When set, the read is
incremental and consumes no more than `maxBytes + 1` bytes before rejecting, so
file growth after the initial stat cannot cause an unbounded allocation.

### `readJsonIfExists<T>(filePath, options?)`

Async semi-lenient reader. Returns `null` if the file is missing; throws `JsonFileReadError` if the file exists but cannot be parsed.

```ts
const cache = (await readJsonIfExists<Cache>("./cache.json")) ?? freshCache();
```

### `tryReadJson<T>(filePath, options?)`

Async lenient reader. Returns `null` for any failure (missing, unreadable, invalid). The "no fuss" sibling.

```ts
const optional = (await tryReadJson<Settings>("./settings.json")) ?? defaults;
```

### `readJsonSync<T>(filePath, options?)`

Synchronous strict reader. Throws `JsonFileReadError` on missing or invalid input, matching the async `readJson` contract.

### `tryReadJsonSync<T>(pathname, options?)`

Synchronous, generic, lenient. Returns `T | null`. Useful in boot paths where you want a typed result without async.

## Root-bounded structured reads

Use the root-bounded readers when you already have a trusted root directory and
a caller-controlled relative path, but you only need one synchronous structured
read instead of a full `root()` handle.

```ts
const result = readRootJsonObjectSync({
  rootDir: "/safe/workspace",
  relativePath: "plugin/openclaw.plugin.json",
  boundaryLabel: "plugin manifest",
  maxBytes: 256 * 1024,
});

if (!result.ok) {
  // reason is "open", "parse", or "invalid"
  throw new Error(result.reason);
}

console.log(result.value);
```

`readRootJsonSync()` parses any JSON value. `readRootJsonObjectSync()` only
accepts objects. `readRootStructuredFileSync()` accepts a custom parser and
validator so callers can layer JSON5, TOML, YAML, or domain-specific validation
without making `fs-safe` depend on those formats.

## Writing

### `writeJson(filePath, value, options?)`

Async atomic JSON write. `JSON.stringify(value, null, 2)` + sibling-temp + rename. Defaults to file mode `0o600`.

```ts
await writeJson("./state.json", state, { trailingNewline: true });
```

Options:

```ts
type WriteJsonOptions = {
  mode?: number;             // file mode (default 0o600)
  dirMode?: number;          // mode for parent dirs created on demand
  trailingNewline?: boolean; // append "\n" if missing (default false)
  durable?: boolean;         // default true; false skips temp/parent fsync
};
```

`durable: false` preserves atomic temp-file replacement but skips the temp-file
and parent-directory `fsync` calls. Use it only for reconstructible JSON state
where lower latency matters more than crash-durability.

### `writeJsonSync(pathname, data)`

Synchronous variant. Convenience wrapper that uses the sync atomic-write path with sensible defaults.

```ts
writeJsonSync("./prefs.json", { theme: "dark" });
```

For atomic text writes, use [`writeTextAtomic`](atomic.md) from `@openclaw/fs-safe/atomic`. For in-process serialization, use `createAsyncLock` from the advanced surface, or prefer [`jsonStore`](json-store.md) when you want a JSON-specific read-modify-write helper.

## Common patterns

### Read-modify-write

```ts
const state = (await readJsonIfExists<State>("./state.json")) ?? initialState();
state.lastRun = Date.now();
await writeJson("./state.json", state, { mode: 0o600, dirMode: 0o700 });
```

### Atomic with secure mode

For credentials or other sensitive JSON, write at mode `0o600`:

```ts
await writeJson("./auth.json", token, { mode: 0o600, dirMode: 0o700 });
```

For higher-assurance secrets, prefer the dedicated [secret-file helpers](secret-file.md) — they create the parent directory at `0o700` if missing.

### Strict load on boot

```ts
let manifest: Manifest;
try {
  manifest = await readJson<Manifest>("./manifest.json");
} catch (err) {
  if (err instanceof JsonFileReadError) {
    console.error("manifest unreadable:", err.cause);
    process.exit(1);
  }
  throw err;
}
```

### Concurrent readers, single writer

```ts
const state = await readJsonIfExists<State>("./state.json");
// missing returns null; malformed JSON still throws
```

## Error reference

| Throw / return | When |
|---|---|
| `null` (lenient reads) | File missing or contents are not valid JSON. |
| `JsonFileReadError` | `readJson` or `readJsonIfExists` saw unreadable or invalid input. Inspect `cause`. |
| Native `NodeJS.ErrnoException` | Lower-level fs errors not wrapped. |

## See also

- [JSON store](json-store.md) — a single-file state wrapper with explicit per-call fallback (`readOr` / `updateOr`) and optional sidecar locking.
- [Atomic writes](atomic.md) — lower-level sibling-temp replacement helpers.
- [Secret files](secret-file.md) — JSON-or-text writes with mode 0600 in mode 0700 dirs.
- [Private file-store mode](private-file-store.md) — root-bounded JSON+text state stores.
- [File lock](sidecar-lock.md) — cross-process coordination.
