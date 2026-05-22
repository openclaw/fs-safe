# Types

The types most callers reach for. Shared data shapes are exported from `@openclaw/fs-safe/types`; method-specific option/result types live next to their subpath.

```ts
import type {
  BasePathOptions,
  DirEntry,
  FastPathMode,
  PathStat,
  SafeEncoding,
} from "@openclaw/fs-safe/types";
```

## `PathStat`

```ts
type PathStat = {
  kind: "file" | "directory" | "symlink" | "fifo" | "socket" | "blockDevice" | "characterDevice" | "unknown";
  size: number;       // bytes
  mtimeMs: number;    // milliseconds since epoch
  mode: number;       // POSIX mode bits
  nlink: number;      // hardlink count
};
```

The shape returned by `Root.stat()`. A trimmed view of `node:fs.Stats` — only the fields the boundary cares about. Use `kind` instead of inspecting the various `is*` methods on a Node `Stats` object; it covers every case in one switchable string.

## `DirEntry`

```ts
type DirEntry = PathStat & {
  name: string;       // base name within the listed directory
};
```

Returned by `Root.list(rel, { withFileTypes: true })`. Includes the same `kind`/`size`/etc as `PathStat`, plus the entry's `name`.

## `BasePathOptions`

```ts
type BasePathOptions = {
  fastPathMode?: FastPathMode;
};

type FastPathMode = "auto" | "never" | "require";
```

Options shared by helpers that can take a "fast path" (use cheaper syscalls when the input is already absolute and clearly inside scope). The default is `"auto"` — let the helper pick. Force `"never"` in tests if you want to exercise the slow path. Force `"require"` if you need to assert that the fast path is taken (the helper throws if it can't).

Most callers don't need to touch this.

## `SafeEncoding`

```ts
type SafeEncoding = BufferEncoding | null;
```

Used by helpers that accept either an encoding (returning a string) or `null` (returning a `Buffer`). The Node `BufferEncoding` type is widened to include `null` for "give me bytes."

## `OpenResult` / `ReadResult`

Returned by `Root.open()` and `Root.read()`:

```ts
type OpenResult = {
  handle: import("node:fs/promises").FileHandle;
  realPath: string;
  stat: import("node:fs").Stats;
};

type ReadResult = {
  buffer: Buffer;
  realPath: string;
  stat: import("node:fs").Stats;
};
```

`realPath` is the canonical real path the read or open landed on, after symlink resolution; `stat` is the verified `fstat` result.

## `RootDefaults` / `RootOptions`

```ts
type RootDefaults = {
  denyMutations?: DenyMutationPolicy;
  hardlinks?: "reject" | "allow";
  maxBytes?: number;
  mkdir?: boolean;
  mode?: number;
  nonBlockingRead?: boolean;
  symlinks?: "reject" | "follow-within-root";
};

type DenyMutationPolicy = {
  paths?: readonly string[];
  prefixes?: readonly string[];
};

type RootOptions = {
  rootDir: string;
  defaults?: RootDefaults;
};
```

`RootDefaults` is what `root(rootDir, defaults)` accepts. See [`root()`](root.md) for the per-method options that override these. `denyMutations` is the exception: root and per-call deny entries are merged.

## `RootReadOptions` / `RootWriteOptions` / `RootCopyOptions`

```ts
type RootReadOptions = Pick<RootDefaults, "hardlinks" | "maxBytes" | "nonBlockingRead" | "symlinks">;
type RootWriteOptions = Pick<RootDefaults, "denyMutations" | "mkdir" | "mode"> & {
  encoding?: BufferEncoding;
  overwrite?: boolean;
};
type RootCopyOptions = Pick<RootDefaults, "denyMutations" | "maxBytes" | "mkdir" | "mode"> & {
  sourceHardlinks?: "reject" | "allow";
};
type RootOpenWritableOptions = Pick<RootDefaults, "denyMutations" | "mkdir" | "mode"> & {
  writeMode?: "replace" | "append" | "update";
};
type RootWriteJsonOptions = RootWriteOptions & {
  replacer?: Parameters<typeof JSON.stringify>[1];
  space?: Parameters<typeof JSON.stringify>[2];
  trailingNewline?: boolean;
};
type RootAppendOptions = RootWriteOptions & {
  prependNewlineIfNeeded?: boolean;
};
type RootMoveOptions = Pick<RootDefaults, "denyMutations"> & {
  overwrite?: boolean;
};
type RootRemoveOptions = Pick<RootDefaults, "denyMutations">;
type RootMkdirOptions = Pick<RootDefaults, "denyMutations">;
```

Per-method option shapes. Each picks the `RootDefaults` keys that apply, plus method-specific extras.

## `SymlinkPolicy` / `HardlinkPolicy`

```ts
type SymlinkPolicy = "reject" | "follow-within-root";
type HardlinkPolicy = "reject" | "allow";
```

The two policy unions you'll see throughout. `"reject"` is conservative; `"follow-within-root"` allows symlinks whose final target is still inside the root; `"allow"` (hardlinks only) is permissive. Defaults for both symlinks and hardlinks are `"reject"`; switch hardlinks to `"allow"` only when you intentionally accept hardlink aliases.

## `FsSafeErrorCode` / `FsSafeErrorCategory`

```ts
type FsSafeErrorCode =
  | "already-exists" | "denied-path" | "device-path" | "hardlink"
  | "helper-failed"
  | "helper-unavailable" | "insecure-permissions" | "invalid-path"
  | "not-empty" | "not-file" | "not-found" | "not-owned"
  | "not-removable" | "outside-workspace" | "path-alias"
  | "path-mismatch" | "permission-unverified" | "symlink"
  | "timeout" | "too-large" | "unsupported-platform";
```

Closed union you switch on. See the [Errors](errors.md) reference for what each one means.

`FsSafeError.category` is `"policy"` for unsafe input/target-state failures and `"operational"` for environment/runtime failures.

## See also

- [`root()`](root.md) — how `RootDefaults` and `Root*Options` are used.
- [Errors](errors.md) — the closed code union in context.
- [Reading](reading.md), [Writing](writing.md) — option shapes per verb.
