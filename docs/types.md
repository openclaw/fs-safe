# Types

The types most callers reach for. Shared data shapes are exported from `@openclaw/fs-safe/types`; method-specific option/result types live next to their subpath.

For atomic replacement, `ReplaceFileAtomicFileSystem` and `ReplaceFileAtomicSyncFileSystem` are exported from `@openclaw/fs-safe/atomic`. Async adapters use `chmod()` on the `FileHandle` returned by their required `open()` operation. The synchronous type adds optional `fchmodSync(fd, mode)`; custom sync adapters that explicitly request `mode` or `preserveExistingMode` must implement it. See [Atomic writes](atomic.md#test-injection).

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
  dev: number;
  gid: number;
  ino: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  mtimeMs: number;
  nlink: number;
  size: number;
  uid: number;
};
```

The shape returned by `Root.stat()`. It is a serializable view of the identity,
ownership, mode, size, timestamp, link count, and three file-kind facts the
boundary uses. Unlike Node's `Stats`, `isFile`, `isDirectory`, and
`isSymbolicLink` are boolean fields rather than methods.

## `DirEntry`

```ts
type DirEntry = PathStat & {
  name: string;       // base name within the listed directory
};
```

Returned by `Root.list(rel, { withFileTypes: true })`. Includes every
`PathStat` field plus the entry's `name`.

## `BasePathOptions`

```ts
type BasePathOptions = {
  rootDir: string;
  relativePath: string;
};

type FastPathMode = "auto" | "never" | "require";
```

`BasePathOptions` is the shared root-plus-relative-path record. `FastPathMode`
is retained as a public compatibility union; no current exported options record
consumes it, so setting a fast-path policy is not part of the current API.

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
  containment: "kernel-atomic" | "best-effort";
  realPath: string;
  stat: import("node:fs").Stats;
};

type ReadResult = {
  buffer: Buffer;
  containment: "kernel-atomic" | "best-effort";
  realPath: string;
  stat: import("node:fs").Stats;
};
```

`realPath` is the canonical real path the read or open landed on, after symlink resolution; `stat` is the verified `fstat` result. Public root results currently report `containment: "best-effort"`; the union also describes direct native `openBeneath()` results, which report `"kernel-atomic"` on Linux. See the [security model](security-model.md#containment-guarantees-by-platform).

## `RootDefaults` / `RootOptions`

```ts
type RenameIdentityPolicy = "strict" | "verify-content-with-lock";

type RootDefaults = {
  denyMutations?: DenyMutationPolicy;
  hardlinks?: "reject" | "allow";
  maxBytes?: number;
  mkdir?: boolean; // default true for mutation methods
  mode?: number;
  nonBlockingRead?: boolean;
  renameIdentity?: RenameIdentityPolicy;
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
type RootWriteOptions = Pick<RootDefaults, "denyMutations" | "mkdir" | "mode" | "renameIdentity"> & {
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
  | "path-mismatch" | "permission-unverified" | "secret-exists"
  | "store-reentrant-update" | "symlink"
  | "timeout" | "too-large" | "unsupported-platform";
```

Closed union you switch on. See the [Errors](errors.md) reference for what each one means.

`FsSafeError.category` is `"policy"` for unsafe input or target state rejected by a safety policy and `"operational"` for routine filesystem outcomes or environment/runtime failures. `not-found`, `not-empty`, and `not-removable` are operational.

## See also

- [`root()`](root.md) — how `RootDefaults` and `Root*Options` are used.
- [Errors](errors.md) — the closed code union in context.
- [Reading](reading.md), [Writing](writing.md) — option shapes per verb.
