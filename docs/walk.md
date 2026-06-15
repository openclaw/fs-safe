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
```

`symlinks` defaults to `"skip"`. `"include"` returns symlink entries without following them. `"follow"` resolves symlinks with `stat()` and may descend into linked directories, so use it only when that is intentional. Already-visited real directories are skipped so symlink cycles do not recurse forever.

`include` controls which entries are returned. `descend` controls which directory entries are traversed. A skipped directory can still be returned if `include` accepts it.

Unreadable directories are skipped rather than throwing, but every skipped directory is recorded in `failedDirs`. This keeps the helper suitable for best-effort inventories while letting pruning jobs tell an incomplete scan from an empty one: a destructive reconcile that deletes state for paths missing from `entries` must first confirm `failedDirs` holds no real read failures, or a transient `EIO`/`EACCES` blip would be mistaken for mass deletion. Use a stricter root-bounded operation when every entry must be accounted for.

## See also

- [`fileStore`](file-store.md) — managed stores use bounded walking for pruning.
- [Path scopes](path-scope.md) — boundary checks for known absolute paths.
