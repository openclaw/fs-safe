# Directory walking

`walkDirectory()` and `walkDirectorySync()` provide budget-bounded directory scans for callers that would otherwise hand-roll recursive `readdir()` loops. The bounds are `maxDepth` and `maxEntries`; this helper does not create a security boundary. Use [`root()`](root.md) when the path itself is caller-influenced.

```ts
import { walkDirectory } from "@openclaw/fs-safe/walk";

const scan = await walkDirectory("/safe/workspace", {
  maxDepth: 3,
  maxEntries: 10_000,
  symlinks: "skip",
  include: (entry) => entry.kind === "file",
  descend: (entry) => entry.name !== ".git",
});

if (scan.truncated) {
  throw new Error("workspace scan exceeded entry budget");
}
```

## Result

```ts
type WalkDirectoryResult = {
  entries: WalkDirectoryEntry[];
  scannedEntryCount: number;
  truncated: boolean;
  failedDirs?: WalkDirectoryFailure[];
};

type WalkDirectoryEntry = {
  name: string;
  path: string;
  relativePath: string;
  depth: number;
  kind: "file" | "directory" | "symlink" | "other";
  dirent: import("node:fs").Dirent;
};

type WalkDirectoryFailure = {
  path: string;
  relativePath: string;
  depth: number;
  error: unknown;
};
```

`depth` starts at `1` for direct children of `rootDir`. `relativePath` is always relative to the supplied root. `scannedEntryCount` counts directory entries examined, including entries filtered out by `include`.

`walkDirectory()` and `walkDirectorySync()` always return `failedDirs`; the property remains optional on the exported `WalkDirectoryResult` type so existing callers that manually construct the legacy result shape remain source-compatible. It lists every directory whose `realpath`/`readdir` threw, so its contents are absent from `entries`. `error` is the thrown value (a `NodeJS.ErrnoException` at runtime), so callers can distinguish a benign missing-directory race (`ENOENT`) from a real read failure (`EACCES`, `EIO`, `ESTALE`, …). The walk-root failure has an empty `relativePath` and `depth: 0`. Failures resolving a symlink's target kind are not reported here.

## Options

```ts
type WalkDirectoryOptions = {
  maxDepth?: number;
  maxEntries?: number;
  symlinks?: "skip" | "follow" | "include";
  include?: (entry: WalkDirectoryEntry) => boolean;
  descend?: (entry: WalkDirectoryEntry) => boolean;
};

type AsyncWalkDirectoryOptions = Omit<WalkDirectoryOptions, "include" | "descend"> & {
  include?: (entry: WalkDirectoryEntry) => boolean | Promise<boolean>;
  descend?: (entry: WalkDirectoryEntry) => boolean | Promise<boolean>;
};
```

`symlinks` defaults to `"skip"`. `"include"` returns symlink entries without following them. `"follow"` resolves symlinks with `stat()` and may descend into linked directories, so use it only when that is intentional. Already-visited real directories are skipped so symlink cycles do not recurse forever.

Before descending into a child directory, `skip` and `include` recheck whether
that entry has become a symlink, including changes made while a filter waits.
The explicitly supplied walk root may still be a symlink. This best-effort
child check does not turn the standalone walker into a confinement boundary;
use `Root.walk()` when root confinement is required.

`include` controls which entries are returned. `descend` controls which directory entries are traversed. A skipped directory can still be returned if `include` accepts it.

The asynchronous `walkDirectory()` accepts `AsyncWalkDirectoryOptions`. It resolves each `include` decision before calling `descend`, and resolves descent before reading the directory's children. Decisions run serially in the existing filesystem-order depth-first traversal. Both callbacks retain the supplied options object as their `this` receiver.

Absent callbacks and primitive results keep the synchronous selection path. Object and function results are awaited directly, including promises and thenables. For JavaScript callers, nullish results retain the default `true`; other resolved values use their existing truthiness. Return booleans or promises of booleans for the typed API.

```ts
import fs from "node:fs/promises";
import path from "node:path";

const scan = await walkDirectory("/safe/workspace", {
  include: (entry) => entry.kind === "file",
  descend: async (entry) => {
    const marked = await fs.access(path.join(entry.path, "SKILL.md"))
      .then(() => true, () => false);
    return !marked;
  },
});
```

This prunes a directory after finding its marker without listing that directory's children. Callback throws and promise rejections reject the walk; they are not directory failures in `failedDirs`. Filtering still consumes the examined-entry budget. `WalkDirectoryOptions` and `walkDirectorySync()` remain synchronous; the async options do not add confinement or cancellation to the standalone walker.

Unreadable directories are skipped rather than throwing, but every skipped directory is recorded in `failedDirs`. This keeps the helper suitable for best-effort inventories while letting pruning jobs tell an incomplete scan from an empty one: a destructive reconcile that deletes state for paths missing from `entries` must first confirm `failedDirs` holds no real read failures, or a transient `EIO`/`EACCES` blip would be mistaken for mass deletion. Use a stricter root-bounded operation when every entry must be accounted for.

## Root-bounded async iteration

`Root.walk(rel, options)` is the root-bounded counterpart to these standalone
inventory helpers. It yields `{ relativePath, kind, size }` incrementally and
accepts `maxDepth`, `maxEntries`, `symlinkPolicy: "skip" |
"follow-within-root"`, `order: "sorted" | "filesystem"`, and an `AbortSignal`. The default budget behavior yields
one `kind: "truncated"` marker and ends; pass `limitBehavior: "throw"` for a
typed `FsSafeError("too-large")` instead.

For followed symlinks, both `kind` and `size` describe the resolved target.

The default `order: "sorted"` visits each directory's names in lexicographic
order before descending depth first. It reads and sorts all names in each
visited directory. With `maxEntries`, it prepares small metadata batches capped
by the remaining global entry budget. Every batch stops at the first directory
or symlink, so recursive descent cannot spend a budget already used by later
siblings. An early `break` may leave metadata from the current batch unused;
the total still stays within `maxEntries`. Filtering requires metadata and
consumes the entry budget, including entries skipped by the filter.

Without `maxEntries`, sorted walks reuse a full directory metadata snapshot
from the `Root.list()` owner. This preserves the existing fast complete-scan
behavior and its snapshot semantics: changes made after a directory is listed
do not alter its already-captured entries. Supply an entry budget or use
filesystem order when metadata work must remain incremental. Sorted entries
describe the observations captured in their directory snapshot or batch.

Use `order: "filesystem"` when a wide directory must not be fully enumerated:

```ts
for await (const entry of capability.walk("", {
  order: "filesystem",
  maxEntries: 128,
  symlinkPolicy: "skip",
})) {
  consume(entry);
}
```

This order follows the filesystem's directory stream and is not deterministic.
It reads one entry at a time, including one name of lookahead to distinguish an
exactly exhausted budget from truncation. The lookahead does not request full
entry metadata from fs-safe, and an early `break` does not prefetch later child
metadata. If a filesystem does not supply directory-entry
types, Node may classify that one extra entry with a synchronous `lstat`.
Handles close on completion, truncation, cancellation, errors, or an
early `break`. Both orders keep the same depth-first traversal, entry filtering,
and truncation rules. Cancellation is checked between entries, with event-loop
handoffs between budgeted sorted batches. Root and directory checks and admitted
child metadata reads are synchronous; no mode can interrupt a filesystem
syscall already in progress or the sorted mode's name sorting.

If a thrown walk failure and directory close both fail, disposal throws a
`SuppressedError` with the close failure in `error` and the original failure in
`suppressed`, preserving both causes.

`entryFilter` is evaluated for each resolved file, directory, or other entry.
The `RootWalkEntryFilter` callback returns a `RootWalkEntryFilterResult`
or a `Promise<RootWalkEntryFilterResult>`:

```ts
for await (const entry of capability.walk("", {
  symlinkPolicy: "skip",
  entryFilter: (entry) =>
    entry.kind === "directory" && entry.relativePath === ".git"
      ? "skip-subtree"
      : "include",
  onDirectoryError: "skip-and-report",
})) {
  if (entry.kind === "directory-error") {
    console.warn("incomplete subtree", entry.relativePath, entry.error);
    continue;
  }
  consume(entry);
}
```

The result values are `"include"`, `"skip"`, and `"skip-subtree"`. Plain
`"skip"` omits an entry but still descends when it is a directory;
`"skip-subtree"` omits that directory and prunes its descendants. Returning
`"skip-subtree"` for a non-directory is equivalent to `"skip"`.

An asynchronous filter can inspect a marker before deciding whether to prune:

```ts
for await (const entry of capability.walk("", {
  symlinkPolicy: "skip",
  entryFilter: async (entry) => {
    if (
      entry.kind === "directory" &&
      await capability.exists(`${entry.relativePath}/SKILL.md`)
    ) {
      return "skip-subtree";
    }
    return "include";
  },
})) {
  consume(entry);
}
```

Filters run serially outside metadata batches and retain the supplied options
object as their `this` receiver. When an awaited filter resolves, the walk
checks cancellation and revalidates the current listing directory and Root
identities before using the decision. These checks do not refresh the entry's
captured metadata or pin a later operation.

Cancellation and iterator disposal wait for a pending filter to settle. The
walk does not race the callback against the abort signal or close its directory
while the callback is running; callbacks must settle their own work for
cancellation to finish. Callback throws and promise rejections reject the walk
through its normal cleanup path, even with `onDirectoryError: "skip-and-report"`.

`onDirectoryError` defaults to `"throw"`, preserving the original fail-fast
contract. `"skip-and-report"` yields a discriminated
`{ kind: "directory-error", relativePath, size: 0, error }` marker for a
directory that cannot be resolved or listed, then continues with its siblings.
This policy also applies when the directory or Root identity recheck after an
awaited filter fails; callback failures themselves are not directory errors.
Every examined directory entry consumes `maxEntries` before filtering, so
`"skip"` cannot turn the iterator into an unbounded traversal. Reporting and
`"truncated"` markers describe already-reached state and do not authorize
further descent.

The pure-Node path validates every directory through the Root boundary, pins
its exact identity, and rechecks it and the Root identity around each metadata
batch or individual filesystem-order observation. Sorted batches contain no
await or caller code between their before/after checks. It tracks canonical
directories to stop symlink cycles.
Directory rechecks retain exact identities while using ordinary numeric metadata
when it represents those identities without rounding. Large identities and
Windows unknown-identity retries keep the bigint inspection path.
Neither mode holds a descriptor for every path component, so it is not a process sandbox against a hostile peer that
can continuously swap and restore directories. Each individual lookup retains
the documented Node `Root` boundary checks.

Unlike `walkDirectory()` and `walkDirectorySync()`, `Root.walk()` is
root-bounded and reports failures inline because an async iterator has no final
result summary. Its default remains to throw on unreadable or invalid
directories.

## See also

- [`fileStore`](file-store.md) — managed stores use bounded walking for pruning.
- [Path scopes](path-scope.md) — boundary checks for known absolute paths.
- [Migrating to 0.5](migrating-to-0.5.md) — adopting bounded pruning and partial-result handling.
