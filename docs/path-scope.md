# pathScope()

`pathScope()` is an advanced helper with the same boundary semantics as `root()`, but it operates on **absolute paths** the caller already trusts and returns plain `{ ok, path }` results instead of throwing. Use it when you want the boundary check up front before handing an absolute path to another library.

```ts
import { pathScope } from "@openclaw/fs-safe/advanced";

const uploads = pathScope("/srv/uploads", { label: "uploads directory" });

const photo = uploads.resolve("user/photo.jpg");
if (!photo.ok) throw new Error(photo.error);

await sharp(photo.path).resize(800).toFile(/* … */);
```

## When to reach for it

`root()` is the right answer when you want method-style I/O (`fs.write`, `fs.readText`). `pathScope()` is the right answer when:

- You're handing absolute paths to **other libraries** that take absolute path strings (Sharp, FFmpeg, `tar`, native modules) and just want the boundary check up front.
- You want to validate user-supplied paths in bulk and return a typed `Result` rather than catching exceptions.
- You want the scope's `label` to appear in the error message: `"Invalid path: must stay within uploads directory"`.

## Signature

```ts
function pathScope(rootDir: string, options: PathScopeOptions): PathScope;

type PathScopeOptions = {
  label: string;          // appears in error messages
};

type PathScopeResolveOptions = {
  defaultName?: string;   // used when the requested path is empty
};

type PathResult = { ok: true; path: string } | { ok: false; error: string };
type PathsResult = { ok: true; paths: string[] } | { ok: false; error: string };

type PathScope = {
  rootDir: string;
  label: string;
  resolve(requestedPath: string, options?: PathScopeResolveOptions): PathResult;
  resolveAll(requestedPaths: string[]): PathsResult;
  existing(requestedPaths: string[]): Promise<PathsResult>;
  files(requestedPaths: string[]): Promise<PathsResult>;
  writable(requestedPath: string, options?: PathScopeResolveOptions): Promise<PathResult>;
  ensureDir(requestedPath: string, options?: PathScopeResolveOptions & { mode?: number }): Promise<PathResult>;
};
```

## Methods

### `resolve(rel, options?)`

Synchronous, lexical only — no filesystem touch. Resolves the relative path against `rootDir` and verifies the result stays inside the scope. Use when you only need the path string:

```ts
const r = uploads.resolve("user/photo.jpg");
if (!r.ok) return reply(400, r.error);
console.log(r.path); // /srv/uploads/user/photo.jpg
```

If the requested path is empty, `defaultName` (when set) is used.

### `resolveAll(rels)`

Synchronous bulk resolve. Returns `{ ok: true, paths }` if every input is in scope, or `{ ok: false, error }` on the first failure.

### `existing(rels)`

Async. Like `resolveAll`, but additionally allows trusted absolute paths whose `realpath` is inside the scope. Useful when callers pass either a relative path or an absolute path you've already validated.

### `files(rels)`

Async. Strict variant: every input must already exist as a regular file inside the scope, with `nlink === 1`. Symlinked entries are rejected.

### `writable(rel, options?)`

Async. Resolves a writable target: requires the parent directory to already
exist canonically inside the scope, refuses targets whose existing inode is a
symlink or hardlinked, and returns the absolute path to use for the write. Use
`ensureDir()` first when the parent needs to be created.

```ts
const t = await uploads.writable("reports/2026/05/report.pdf");
if (!t.ok) return reply(400, t.error);
await fs.writeFile(t.path, body);
```

### `ensureDir(rel, options?)`

Async. `mkdir -p` inside the scope. Walks each segment, refuses any symlink in the path, creates missing directories. Optional `mode` sets the directory mode.

```ts
const dir = await uploads.ensureDir("inbox", { mode: 0o755 });
if (!dir.ok) return reply(500, dir.error);
```

## Result type vs throwing

`pathScope` returns `{ ok: true, path }` / `{ ok: false, error }` instead of throwing. This makes it pleasant to use at validation boundaries:

```ts
function handle(req: Req, res: Res) {
  const r = uploads.resolve(req.body.path);
  if (!r.ok) return res.status(400).json({ error: r.error });
  return doWork(r.path);
}
```

For exception-flavored APIs, use `root()` instead — it throws `FsSafeError` with a typed `code`.

## Combine with `root()`

A common pattern at the edge of an HTTP handler: validate the input with `pathScope`, do the I/O with `root()`:

```ts
const uploads = pathScope("/srv/uploads", { label: "uploads" });
const fs = await root("/srv/uploads", { hardlinks: "reject" });

const r = uploads.resolve(req.body.path);
if (!r.ok) return reply(400, r.error);
const rel = path.relative(fs.rootReal, r.path);

const text = await fs.readText(rel);
```

## See also

- [`root()`](root.md) — method-style boundary that throws on failure.
- [Path helpers](path.md) — `isPathInside`, `safeRealpathSync`, `isWithinDir` for ad-hoc checks.
- [Errors](errors.md) — error semantics (note: `pathScope` returns errors, doesn't throw).
