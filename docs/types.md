# Types

The types most callers reach for. Shared data shapes are exported from `@openclaw/fs-safe/types`; method-specific option/result types live next to their subpath.

For atomic replacement, `ReplaceFileAtomicFileSystem` and `ReplaceFileAtomicSyncFileSystem` are exported from `@openclaw/fs-safe/atomic`. Async adapters use `chmod()` on the `FileHandle` returned by their required `open()` operation. The synchronous type adds optional `fchmodSync(fd, mode)`; custom sync adapters that explicitly request `mode` or `preserveExistingMode` must implement it. See [Atomic writes](atomic.md#test-injection).

`ReplaceFileAtomicDestinationState` is also exported from that subpath. It is a
readonly union of `{ state: "removed", path }` and
`{ state: "writing" | "published", path, dev: bigint, ino: bigint }`. Both atomic
replacement option types accept synchronous `assertBeforeMutation` and
`onDestinationState` callbacks. See [authority and destination state](atomic.md#atomic-write-authority-and-destination-state).

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

Returned by `Root.list(rel, { withFileTypes: true })` and [`Root.entries()`](entries.md). Includes every
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

Import the result types rather than copying their shapes:

```ts
import type { OpenResult, ReadResult, WritableOpenResult } from "@openclaw/fs-safe/root";
```

`realPath` is the canonical real path the read or open landed on, after symlink resolution; `stat` is the verified `fstat` result. Public root results currently report `containment: "best-effort"`; the union also describes direct native `openBeneath()` results, which report `"kernel-atomic"` on Linux. See the [security model](security-model.md#containment-guarantees-by-platform).

`ReadResult` carries the read `buffer`. `OpenResult` and `WritableOpenResult`
carry an owned Node `FileHandle` as `handle` and implement
`[Symbol.asyncDispose]()`; use `await using` or explicitly close the handle.
See [reading](reading.md#fs-open-rel-options) and
[writable handles](writing.md#openwritable-for-streaming) for ownership and streaming.

## `RootDefaults` / `RootOptions`

```ts
import type {
  DenyMutationPolicy,
  RenameIdentityPolicy,
  RootDefaults,
  RootOptions,
} from "@openclaw/fs-safe/root";
```

`RootDefaults` is what `root(rootDir, defaults)` accepts. `RootOptions` is the
`{ rootDir, defaults? }` record. See the [Root signature and defaults](root.md#signature)
for fields and behavior. `denyMutations` and `assertBeforeMutation` compose with
per-call restrictions: deny entries are merged, and the root authority assertion
runs before the per-call assertion.

## `RootReadOptions` / `RootWriteOptions` / `RootCopyOptions`

```ts
import type {
  RootAppendOptions,
  RootCopyOptions,
  RootCreateJsonOptions,
  RootCreateOptions,
  RootCreateStreamOptions,
  RootMkdirOptions,
  RootMoveOptions,
  RootOpenOptions,
  RootOpenWritableOptions,
  RootReadOptions,
  RootRemoveOptions,
  RootWriteJsonOptions,
  RootWriteOptions,
} from "@openclaw/fs-safe/root";
```

Each method accepts only its applicable defaults and method-specific options:

| Types | Contract |
|---|---|
| `RootReadOptions` | Read symlink/hardlink policy and `maxBytes`; see [read options](reading.md#read-options). |
| `RootOpenOptions` | Read link policies, without `maxBytes`. The returned handle's I/O belongs to the caller. |
| `RootWriteOptions`, `RootWriteJsonOptions`, `RootAppendOptions` | [Write options](writing.md#write-options), JSON formatting, and append newline handling. |
| `RootCreateOptions`, `RootCreateJsonOptions`, `RootCreateStreamOptions` | [Exclusive creation](writing.md#atomic-buffered-creation), private permissions, and `durable: "file"`; streamed creation also accepts byte limits and cancellation. |
| `RootCopyOptions` | [Guarded copying](writing.md#write-verbs), source policy, `CopyCloneMode`, and `RootCopyPublicationReceipt`. |
| `RootOpenWritableOptions` | [Writable handles](writing.md#openwritable-for-streaming) with `writeMode`, without buffered-write durability or byte limits. |
| `RootMoveOptions`, `RootRemoveOptions`, `RootMkdirOptions` | [Mutation methods](root.md#writes) with their collision, removal-budget, and directory-privacy options. |

## `SymlinkPolicy` / `MutationSymlinkPolicy` / `HardlinkPolicy`

```ts
type SymlinkPolicy = "reject" | "follow-within-root" | "follow-parents-within-root";
type MutationSymlinkPolicy = "reject" | "follow-parents-within-root";
type HardlinkPolicy = "reject" | "allow";
```

`"reject"` is conservative; `"follow-within-root"` allows symlinks whose final target is still inside the root; `"allow"` (hardlinks only) is permissive. Defaults for read symlinks and hardlinks are `"reject"`; switch hardlinks to `"allow"` only when you intentionally accept hardlink aliases.

`"follow-parents-within-root"` allows contained parent directory aliases while
rejecting final symlinks. Mutation policy is opt-in and independent of read
policy; omission preserves each mutation method's existing behavior.

## `FsSafeErrorCode` / `FsSafeErrorCategory`

`FsSafeErrorCode` is a closed union you switch on; the [code union](errors.md#code-union) lists every member and the [code reference](errors.md#code-reference) explains each one.

`FsSafeError.category` is `"policy"` for unsafe input or target state rejected by a safety policy and `"operational"` for routine filesystem outcomes or environment/runtime failures. [Errors](errors.md#shape) lists the exact operational set.

## See also

- [`root()`](root.md) — how `RootDefaults` and `Root*Options` are used.
- [Errors](errors.md) — the closed code union in context.
- [Reading](reading.md), [Writing](writing.md) — option shapes per verb.
