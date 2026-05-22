# Path helpers

`@openclaw/fs-safe/path` is the lower-level lexical and canonical path surface — useful when you have your own logic that needs to know "is this path inside that directory" without going through `root()` or `pathScope()`.

```ts
import {
  isPathInside,
  isPathInsideWithRealpath,
  isWithinDir,
  resolveSafeBaseDir,
  safeRealpathSync,
  safeStatSync,
  assertNoNulPathInput,
  assertNoUnsafeDeviceReadPath,
  isUnsafeDeviceReadPath,
  isNotFoundPathError,
  isSymlinkOpenError,
  hasNodeErrorCode,
} from "@openclaw/fs-safe/path";
```

Only `root()`, `FsSafeError`, and the Python helper config live on the main entry. Path helpers are deliberately a subpath import so the main entry stays small.

## Boundary checks

### `isPathInside(rootDir, target)`

Pure lexical check. Returns `true` if `target` is `rootDir` itself or a descendant, after normalizing both inputs. **Does not** touch the filesystem — does not follow symlinks.

```ts
isPathInside("/srv/uploads", "/srv/uploads/photo.jpg");      // true
isPathInside("/srv/uploads", "/srv/uploads/../escape.txt");  // false
isPathInside("/srv/uploads", "/srv/uploads-other/x");        // false
isPathInside("/srv/uploads", "/srv/uploads");                // true (root itself counts)
```

The check is platform-aware: on Windows, paths are normalized for case and separator before comparison.

### `isPathInsideWithRealpath(rootDir, target, opts?)`

Synchronous. Same as `isPathInside`, but resolves both inputs through `realpath` first. Use this when you want the canonical answer and either input might be a symlink.

```ts
isPathInsideWithRealpath("/srv/uploads", "/srv/symlink-to-elsewhere"); // false
```

```ts
type Options = {
  requireRealpath?: boolean;            // default true
  cache?: Map<string, string>;
};
```

Does not throw on missing inputs — `realpath` failures are absorbed by the underlying `safeRealpathSync`. By default (`requireRealpath: true`) the function returns `false` when either input cannot be resolved. Pass `{ requireRealpath: false }` to fall back to the lexical answer from `isPathInside` instead.

### `isWithinDir(rootDir, targetPath)`

Convenience wrapper around `isPathInside`. Same semantics, different name kept for callers that prefer the noun phrase.

### `resolveSafeBaseDir(rootDir)`

Resolve a base directory to an absolute, normalized form ready for prefix comparison. Pre-normalized directories make subsequent `isPathInside` checks unambiguous.

```ts
const base = resolveSafeBaseDir("/srv/uploads/.");  // "/srv/uploads"
```

## Realpath and stat

### `safeRealpathSync(targetPath, cache?)`

Synchronous `realpath` that returns `null` instead of throwing on any error. Pass an optional `Map<string, string>` to cache results across calls within a single operation.

```ts
const real = safeRealpathSync("/srv/uploads/photo.jpg");
if (real === null) return notFound();
```

All `realpath` failures collapse to `null` — there is no distinction between `ENOENT`, `EACCES`, and other I/O errors. Use `fs.realpathSync` directly if you need to branch on the error code.

### `safeStatSync(targetPath)`

Synchronous `stat` that returns `null` instead of throwing on missing paths. Returns `Stats` on success.

```ts
const stat = safeStatSync("/srv/uploads/photo.jpg");
if (!stat?.isFile()) return notFound();
```

### `assertNoNulPathInput(filePath, message?)`

Throws `FsSafeError` with code `invalid-path` when a path string contains an embedded NUL byte. Use it before calling Node `fs` APIs directly; Node's native error can include raw path text in the message.

### `assertNoUnsafeDeviceReadPath(filePath, options?)`

Throws `FsSafeError` with code `device-path` when a read target is a known unsafe device or process-fd path. The built-in read/open helpers call this automatically before opening files; use it only when you are building your own read primitive.

```ts
assertNoUnsafeDeviceReadPath("/dev/zero"); // throws on POSIX
isUnsafeDeviceReadPath("/dev/fd/0");       // true on POSIX
```

The check is intentionally not a normal consumer policy knob. Safe read APIs reject these targets by default because they can block forever, stream indefinitely, or alias process file descriptors.

## Error inspection

### `isNotFoundPathError(err)`

`true` if the error is a `NodeJS.ErrnoException` with code `ENOENT` (file or directory missing).

```ts
try {
  await fs.readFile(p);
} catch (err) {
  if (isNotFoundPathError(err)) return null;
  throw err;
}
```

### `isSymlinkOpenError(err)`

`true` if the error indicates a symlink-related open failure (typically `ELOOP` or platform-specific symlink rejections from `O_NOFOLLOW`).

### `hasNodeErrorCode(err, code)`

Generic helper. `true` if `err` is a `NodeJS.ErrnoException` with the matching `code` string.

```ts
if (hasNodeErrorCode(err, "EACCES")) return reply(403);
```

## When to use these vs `root()`

| Path helpers | `root()` |
|---|---|
| Pure functions over absolute path strings. | Boundary handle with method-style I/O. |
| No I/O performed (except `safeRealpathSync`/`safeStatSync`). | Every method goes to disk. |
| Fits inside other helpers / validation pipelines. | Standalone consumer of caller-supplied paths. |

If you're writing a validator that says "is this safe?" without performing the operation, the path helpers are the right tool. If you're going to perform the read or write, use `root()` so the boundary check is fused with the operation.

## Common patterns

### "Resolve, then assert it's inside my dir"

```ts
import { isPathInsideWithRealpath, isNotFoundPathError } from "@openclaw/fs-safe/path";

let canonical: string;
try {
  canonical = await fs.realpath(input);
} catch (err) {
  if (isNotFoundPathError(err)) return reply(404);
  throw err;
}
if (!isPathInsideWithRealpath("/srv/uploads", canonical)) {
  return reply(403);
}
```

### Cache realpaths in a request scope

```ts
const cache = new Map<string, string>();
for (const p of inputs) {
  const real = safeRealpathSync(p, cache);
  if (real && isPathInside(root, real)) keep.push(real);
}
```

### Branch on `ENOENT` vs other errors

```ts
try {
  return await fs.readFile(p);
} catch (err) {
  if (isNotFoundPathError(err)) return null;
  if (hasNodeErrorCode(err, "EACCES")) return null;
  throw err;
}
```

## Path-policy helpers

`path-policy.ts` exposes two assertions used by `root()` internally; they are exported for callers building their own helpers:

```ts
import {
  assertNoPathAliasEscape,
  assertNoHardlinkedFinalPath,
  PATH_ALIAS_POLICIES,
} from "@openclaw/fs-safe/advanced";
```

- `assertNoPathAliasEscape({ rootRealPath, candidatePath, policy })` — async. Asserts the candidate's resolved real path is inside the root. Configurable via `PATH_ALIAS_POLICIES` (which currently ships only the default `"strict"` policy).
- `assertNoHardlinkedFinalPath({ filePath })` — async. Throws if the file at `filePath` has `nlink > 1`.

Use these when writing a custom helper that wants the same guards `root()` uses but with different surrounding logic.

## See also

- [`root()`](root.md) — the high-level boundary that uses these checks internally.
- [`pathScope()`](path-scope.md) — `Result`-style scope checks.
- [Reading](reading.md) — `Root.read()` and friends use `isPathInside` + identity checks.
