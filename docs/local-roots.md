# Local roots

The local-roots helpers accept a file path plus a list of trusted absolute
directories and return the first canonical root that contains the file. Use
them when configuration may name one of several approved media, cache, or
workspace roots.

```ts
import {
  readLocalFileFromRoots,
  resolveLocalPathFromRootsSync,
} from "@openclaw/fs-safe/advanced";
```

## Input shape

Both helpers take one options object. `filePath` may be absolute, home-relative,
relative to the current working directory, or a local `file://` URL. Relative
inputs are resolved exactly as Node resolves them; they are not searched as a
basename under each root.

```ts
type LocalRootsInputOptions = {
  filePath: string;
  roots: readonly string[]; // trusted absolute paths, checked in order
  label?: string;           // used in validation errors
};
```

Roots may use `~` or local `file://` spellings, but each resolved root must be
absolute. Existing root symlinks are canonicalized before containment is
checked. Invalid root entries throw `FsSafeError("invalid-path")`; an invalid
`file://` input throws `Error`. A path that is valid but does not fall inside
any usable root returns `null`.

## `resolveLocalPathFromRootsSync(options)`

```ts
type ResolveLocalPathFromRootsSyncOptions = LocalRootsInputOptions & {
  allowMissing?: boolean; // default false
  requireFile?: boolean;  // default false
};

type LocalRootsPathResult = {
  path: string; // canonical candidate path
  root: string; // canonical containing root
};
```

For an existing upload:

```ts
import { resolveLocalPathFromRootsSync } from "@openclaw/fs-safe/advanced";

const r = resolveLocalPathFromRootsSync({
  filePath: "/srv/uploads/photo.jpg",
  roots: ["/srv/uploads", "/srv/cache"],
  requireFile: true,
});

if (!r) throw new Error("photo is outside the configured roots");
console.log(r.path); // canonical path to photo.jpg
console.log(r.root); // canonical /srv/uploads
```

By default the candidate must exist. `allowMissing: true` instead canonicalizes
the nearest existing ancestor and validates the missing tail, which is useful
when selecting a future output location. `requireFile: true` rejects existing
directories and other non-file leaves. Dangling symlinks and candidates whose
ancestors cannot be canonicalized are rejected rather than treated as safe
missing paths.

## `readLocalFileFromRoots(options)`

The asynchronous helper opens the candidate through the matched [`Root`](root.md),
so no-follow, identity, hardlink, device-path, and byte-limit checks happen at
the read itself.

```ts
type ReadLocalFileFromRootsOptions = LocalRootsInputOptions & {
  hardlinks?: "reject" | "allow";
  maxBytes?: number;
  nonBlockingRead?: boolean;
  symlinks?: "reject" | "follow-within-root";
};

type LocalRootsReadResult = ReadResult & {
  root: string; // canonical containing root
};
```

```ts
const r = await readLocalFileFromRoots({
  filePath: "/srv/uploads/photo.jpg",
  roots: ["/srv/uploads", "/srv/cache"],
  maxBytes: 8 * 1024 * 1024,
});
if (!r) throw new Error("photo is missing, unreadable, or outside the roots");
process.stdout.write(r.buffer);
```

The helper returns `null` when no configured root can be opened or no safe read
succeeds. This intentionally collapses missing, outside-root, and per-root read
failures; use a single `Root` directly when the caller must distinguish those
outcomes. Omitting `maxBytes` preserves `Root`'s 16 MiB default.

## File URL and Windows-path companions

The advanced surface also exports the normalization helpers used around this
API:

```ts
import {
  assertNoWindowsNetworkPath,
  basenameFromMediaSource,
  hasEncodedFileUrlSeparator,
  isWindowsDriveLetterPath,
  isWindowsNetworkPath,
  safeFileURLToPath,
  trySafeFileURLToPath,
} from "@openclaw/fs-safe/advanced";
```

- `safeFileURLToPath(fileUrl)` parses a local file URL and refuses remote hosts
  or paths that decode to Windows network paths.
- `trySafeFileURLToPath(fileUrl)` returns `undefined` instead of throwing.
- `isWindowsDriveLetterPath()` and `isWindowsNetworkPath()` classify Windows
  absolute and network spellings.
- `assertNoWindowsNetworkPath()` throws for a network path on Windows.
- `basenameFromMediaSource()` extracts a best-effort filename from a URL, data
  URI, or path.
- `hasEncodedFileUrlSeparator()` detects percent-encoded slash or backslash
  spellings.

## See also

- [`root()`](root.md) — use when one trusted root should preserve individual
  failure codes.
- [Path helpers](path.md) — lexical and canonical containment primitives.
- [`pathScope()`](path-scope.md) — result-shaped single-root validation.
