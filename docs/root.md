# root()

`root()` is the primary entry point. It takes a trusted directory and returns a capability-style `Root` handle whose methods accept relative paths and refuse to escape the directory.

```ts
import { root } from "@openclaw/fs-safe";

const fs = await root("/srv/workspace", {
  hardlinks: "reject",
  symlinks: "reject",
  mkdir: true,
});
```

## Signature

```ts
function root(rootDir: string, defaults?: RootDefaults): Promise<Root>;

type RootDefaults = {
  hardlinks?: "reject" | "allow";  // refuse files with nlink > 1 on read; defaults to "reject"
  denyMutations?: DenyMutationPolicy; // absolute paths/prefixes mutation methods may not change
  maxBytes?: number;               // refuse reads larger than this many bytes; defaults to 16 MiB
  mkdir?: boolean;                 // create missing parent dirs on write/openWritable/append
  mode?: number;                   // file mode applied to new writes; per-call override available
  nonBlockingRead?: boolean;       // schedule reads on a worker; useful for large files
  symlinks?: "reject" | "follow-within-root"; // policy when a path component is a symlink
};

type DenyMutationPolicy = {
  paths?: readonly string[];
  prefixes?: readonly string[];
};
```

`root()` resolves the directory through the real filesystem. A symlinked input becomes the canonical path; a non-existent root throws `FsSafeError` with code `not-found`, and malformed or non-directory roots throw `invalid-path`.

`defaults` apply to every method on the returned handle. Per-call options on individual methods override the defaults for that call only, except `denyMutations`: root and per-call deny entries are merged so a call cannot clear a root-level deny.

## The `Root` interface

Every method on the returned handle accepts paths relative to the root and rejects anything that would escape it.

### Reads

```ts
fs.read(rel, options?)         // { buffer, containment, realPath, stat }
fs.readBytes(rel, options?)    // Buffer
fs.readText(rel, options?)     // string
fs.readJson<T>(rel, options?)  // parsed T
fs.open(rel, options?)         // { handle, containment, realPath, stat, [Symbol.asyncDispose] }
fs.readAbsolute(absPath, options?) // ReadResult; absPath must already be inside the root
fs.reader(options?)            // (path) => Promise<Buffer>; useful for loader APIs
fs.walk(rel, options)          // root-bounded AsyncIterable<{ relativePath, kind, size }>
```

`walk()` is the incremental, root-bounded recursive scan. It supports entry and
depth budgets, cancellation, and `symlinkPolicy: "skip" |
"follow-within-root"`. Budget exhaustion yields a `"truncated"` marker by
default or throws `FsSafeError("too-large")` with `limitBehavior: "throw"`.
Use `entryFilter(entry)` to return `"include"`, `"skip"`, or
`"skip-subtree"`. `"skip"` omits the current entry but still descends into a
directory; `"skip-subtree"` omits a directory and all of its descendants.
Directory reads remain fail-fast by default. With
`onDirectoryError: "skip-and-report"`, the iterator instead yields
`{ relativePath, kind: "directory-error", size: 0, error }` and continues with
the remaining tree.
See [Directory walking](walk.md) for the pure-Node guarantees and the contrast
with the standalone best-effort walkers.

`open()` returns a Node `FileHandle` for streaming. Prefer `await using` for cleanup:

```ts
await using opened = await fs.open("large.log");
{
  for await (const chunk of opened.handle.createReadStream()) {
    process.stdout.write(chunk);
  }
}
```

`open()`, `read()`, and `openWritable()` results include
`containment: "best-effort"`. The field reports the mechanism used; see the
[security model](security-model.md#containment-guarantees-by-platform).

### Writes

```ts
fs.write(rel, data, options?)            // overwrite-ok atomic write
fs.create(rel, data, options?)           // throws "already-exists" if target exists
fs.writeJson(rel, value, options?)       // JSON.stringify + atomic write
fs.createJson(rel, value, options?)      // create() variant of writeJson
fs.append(rel, data, options?)           // append text/buffer; syncs before close
fs.copyIn(rel, sourceAbsPath, options?)  // copy from outside the root, atomically, with size cap
fs.openWritable(rel, options?)           // FileHandle for streaming writes; supports await using
fs.move(from, to, options?)              // rename within the root; defaults to no clobber
fs.remove(rel, options?)                 // unlink file or rmdir empty directory
fs.mkdir(rel, options?)                  // mkdir -p (creates missing parents)
fs.ensureRoot(options?)                  // accepts "" / "." as the root itself
```

`write`, `create`, `append`, `writeJson`, and `createJson` accept `mode?: number`; use `0o600` for credentials and other private state. `writeJson` also accepts the same options as `JSON.stringify` plus `trailingNewline?: boolean` (defaults `true` so the file ends in `\n`).

`copyIn` is a one-shot ingest from a trusted absolute source path: it streams the source through the boundary, atomically renames into the root, and respects `maxBytes`.

Root operations that choose a new destination reject a leading Windows
drive-relative spelling such as `C:name` on every platform. This applies to
`write`, `create`, `append`, `openWritable`, `mkdir`, `copyIn`, and the
destination argument of `move`. In particular, `copyIn(path.basename(source),
source)` can reject a legal POSIX basename such as `c:photo.png`; callers that
derive portable destination names from host files must sanitize or map that
basename first.

`openWritable` opens a writable file with options `mode?: number` and `writeMode?: "replace" | "append" | "update"`. `replace` truncates existing files and is the default; `update` keeps existing contents. Use it for streaming output. Prefer `await using` for cleanup.

All mutation methods accept `denyMutations?: { paths?: string[]; prefixes?: string[] }`. Entries must be absolute paths. `paths` blocks those exact paths; `prefixes` blocks those paths and their descendants. fs-safe preserves path strings exactly and canonicalizes through existing ancestors before comparing, so a symlinked ancestor to a denied location is still denied. Denied mutations throw `FsSafeError` with code `denied-path`. Use this for caller-specific sensitive paths, not as a replacement for the root boundary, symlink, or hardlink checks.

### Inspection (advisory)

```ts
fs.exists(rel)                   // boolean
fs.stat(rel)                     // PathStat
fs.list(rel)                     // string[]
fs.list(rel, { withFileTypes })  // DirEntry[]
fs.resolve(rel)                  // absolute path inside the root, after canonicalization
```

These do not pin a later operation. They are safe to expose to UIs and decision points; for the actual read or write, use the verb methods so the operation pins identity at the point of use.

`resolve()` is the exception to the existing-object rule: because it selects a
location for later use, it rejects a leading drive-relative spelling. Reads,
`stat`, `exists`, `list`, `walk`, `remove`, and the source argument of `move`
accept an existing POSIX filename such as `c:notes.txt`. For `move`, only the
new destination name is subject to the portable guard.

## Native helper mode

Create-only writes prefer the bundled native helper for fd-relative opens and
atomic no-replace rename. Operations without native wiring retain their guarded
JavaScript implementations.

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

configureFsSafeNative({ mode: "off" });     // guarded JavaScript path
configureFsSafeNative({ mode: "require" }); // fail if the binding is unavailable
```

`auto` is the default. Configure the mode before creating roots. See the
[native helper policy](native-helper.md) for supported platforms, the native
surface, and the precise fallback boundary.

### Properties

```ts
fs.rootDir       // the directory you passed in
fs.rootReal      // its canonical real path (after symlink resolution)
fs.rootWithSep   // rootReal with a trailing separator, for prefix comparisons
fs.defaults      // the RootDefaults you passed
```

## Failure semantics

Every method throws `FsSafeError` with a `code`. Branch on `err.code`, not message text. Common codes:

| Code | When it fires |
|---|---|
| `invalid-path` | The input path is malformed, including embedded NUL bytes. Portable relative-path helpers and `FileStore` keys reject drive-relative segments; Root destination and resolution operations reject a leading drive-relative spelling such as `C:name`. |
| `outside-workspace` | The input resolves outside the root, or contains a `..` segment that would escape it. |
| `not-found` | The target does not exist (or its parent does not, with `mkdir: false`). |
| `not-file` | A read or copy targeted a non-regular file (directory, FIFO, socket, …). |
| `device-path` | A read/open target is a known unsafe device or process-fd path. |
| `already-exists` | `create()` or `move()` without `overwrite` hit an existing target. |
| `denied-path` | A mutation target matched `denyMutations.paths` or `denyMutations.prefixes`. |
| `symlink` | A path component is a symlink, and the call's `symlinks` policy is `reject`. |
| `hardlink` | The target's `nlink > 1` and `hardlinks` policy is `reject`. |
| `path-mismatch` | Post-open identity check failed — the opened fd does not match the resolved path. |
| `too-large` | Read exceeded `maxBytes`. |

Full list in the [Errors](errors.md) reference.

## Defaults vs per-call options

Defaults reduce repetition; per-call options handle exceptions:

```ts
const fs = await root("/srv/workspace", {
  symlinks: "reject",
  hardlinks: "reject",
  mkdir: true,
});

// Default: symlinks rejected.
await fs.readText("config.toml");

// One specific path needs to follow a symlink that lands inside the root.
await fs.readText("links/current.log", { symlinks: "follow-within-root" });
```

Text helpers default to UTF-8. Pass `encoding` per call to `readText`, `readJson`, `write`, `create`, or `append` when you need another encoding.

## Common patterns

### Read-only loader

```ts
const fs = await root("/srv/workspace", { symlinks: "reject", hardlinks: "reject" });
const load = fs.reader();
const a = await load("notes/today.txt");        // relative
const b = await load("/srv/workspace/state.bin"); // absolute, but inside the root
```

`fs.reader()` returns a `(path) => Promise<Buffer>` callback. Useful when wiring `fs-safe` into APIs that accept a generic loader function. Absolute paths outside the root are rejected with `outside-workspace`.

### "Touch only if missing" seeding

```ts
try {
  await fs.create("config/seed.json", initialJson);
} catch (err) {
  if (err instanceof FsSafeError && err.code === "already-exists") {
    // existing config wins
  } else {
    throw err;
  }
}
```

### Replace + verify

```ts
await fs.write("state.json", JSON.stringify(state, null, 2));
const echoed = await fs.readJson<State>("state.json");
assertDeepEqual(echoed, state);
```

`write` is atomic, so the file is either old or new — never half-written. Re-reading lets you detect a parallel writer, if one exists.

## See also

- [Reading](reading.md) — read variants in depth, plus stream patterns.
- [Writing](writing.md) — write/create/move/remove in depth.
- [pathScope()](path-scope.md) — the same boundary semantics over an absolute path you already trust.
- [Atomic writes](atomic.md) — the lower-level helpers used by `fs.write`.
- [Errors](errors.md) — the closed code union you'll be catching.
