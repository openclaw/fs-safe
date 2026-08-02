# Temp workspaces

`@openclaw/fs-safe/temp` is the stable temp surface: private temp **workspaces** with auto-cleanup plus the secure per-user temp root the helpers default to.

```ts
import {
  tempWorkspace,
  withTempWorkspace,
  tempWorkspaceSync,
  withTempWorkspaceSync,
  resolveSecureTempRoot,
} from "@openclaw/fs-safe/temp";
```

## Private temp workspaces

A private workspace is a directory created at mode `0o700` under a caller-provided temp root. It is unique per call (random suffix) and cleaned up when you call `cleanup()` or leave an `await using` scope.

### `tempWorkspace`

The compact factory. Returns:

```ts
type TempWorkspace = {
  dir: string;
  identity: { dev: number | bigint; ino: number | bigint };
  store: FileStore;
  path(fileName: string): string;
  write(fileName: string, data: string | Uint8Array): Promise<string>;
  writeText(fileName: string, data: string): Promise<string>;
  writeJson(fileName: string, data: unknown, options?: { trailingNewline?: boolean }): Promise<string>;
  copyIn(fileName: string, sourcePath: string): Promise<string>;
  read(fileName: string): Promise<Buffer>;
  cleanup(): Promise<"removed" | "missing" | "identity-mismatch">;
  [Symbol.asyncDispose](): Promise<void>;
};
```

```ts
import { tempWorkspace } from "@openclaw/fs-safe/temp";

await using workspace = await tempWorkspace({ rootDir: "/tmp/my-app", prefix: "build-" });
const inputPath = await workspace.write("input.txt", "data");
await runBuild(workspace.dir, inputPath);
```

`write` writes at `mode` (default `0o600`); `writeText` and `writeJson` are convenience wrappers for the common scratch-file shapes; `copyIn` ingests an absolute source path through the same atomic-rename machinery as `Root.copyIn`. `read` is a small accessor that reads back any file you wrote into the workspace.

`store` is a `fileStore({ rootDir: workspace.dir, private: true })` handle. Use
it when you want the richer store surface, including `writeStream`, `exists`,
`remove`, `readJsonIfExists`, or `store.json<T>(rel)`:

```ts
await using workspace = await tempWorkspace({ rootDir: "/tmp/my-app", prefix: "build-" });
const state = workspace.store.json<State>("state.json");
await state.write({ ready: true });
```

The workspace owns cleanup; the store is only a view over the workspace
directory.

The identity receipt is captured when the workspace is created. Manual,
disposal, and process-exit cleanup remove the path only while `lstat` still
matches that receipt. If another actor renames the workspace away and places a
new directory at the old name, cleanup returns `"identity-mismatch"` and leaves
the replacement untouched. Disposal hooks perform the same check and ignore
the returned status.

When cleanup is part of a retention or audit decision, inspect the receipt
instead of treating cleanup as fire-and-forget:

```ts
const workspace = await tempWorkspace({ rootDir: "/var/lib/app/tmp", prefix: "restore-" });
try {
  await restoreInto(workspace.dir);
} finally {
  const cleanup = await workspace.cleanup();
  if (cleanup === "identity-mismatch") {
    alertOperator("restore workspace path was replaced; replacement preserved");
  }
}
```

The sync variant `tempWorkspaceSync` exposes the same surface with sync return
types and a `FileStoreSync` at `workspace.store`.

### `withTempWorkspace`

The recommended shape. Auto-cleanup on every exit path:

```ts
import { withTempWorkspace } from "@openclaw/fs-safe/temp";

const result = await withTempWorkspace({ rootDir: "/tmp/my-app", prefix: "build-" }, async (workspace) => {
  await workspace.write("input.txt", "data");
  return await runBuild(workspace.dir);
});
```

The callback receives the same workspace shape as `tempWorkspace()`. Cleanup is wired to run after the callback resolves or rejects.

### Manual lifetime

Lower-level. You manage the lifetime:

```ts
const workspace = await tempWorkspace({ rootDir: "/tmp/my-app", prefix: "scan-" });
try {
  // …work in workspace.dir…
} finally {
  await workspace.cleanup();
}
```

### Sync variants

`tempWorkspaceSync` and `withTempWorkspaceSync` are the synchronous siblings. Useful for setup code in tests or boot paths that have not entered async land yet.

### Options

```ts
type TempWorkspaceOptions = {
  rootDir: string;          // parent directory for workspaces
  prefix: string;           // dir prefix (sanitized)
  dirMode?: number;         // dir mode; default 0o700
  mode?: number;            // file write mode; default 0o600
};
```

## Advanced temp primitives

When you don't need the stable workspace abstraction, the lower-level temp-file
and sibling-temp helpers live behind `@openclaw/fs-safe/advanced`. They are
composition primitives for stores and atomic writers, not the primary API.
`tempWorkspace()` carries the stable lifetime contract for application code;
`tempFile()` is a one-shot building block whose options may move as store and
archive internals evolve.

### `tempFile`

```ts
import { tempFile } from "@openclaw/fs-safe/advanced";

const target = await tempFile({ fileName: "report.pdf", prefix: "render-" });
try {
  await render(target.path);
  await fs.copyFile(target.path, "/srv/workspace/reports/today.pdf");
} finally {
  await target.cleanup();
}
```

Returns:

```ts
type TempFile = {
  path: string;                            // absolute path; safe to write to
  dir: string;                             // the enclosing private workspace dir
  file(fileName?: string): string;          // resolve another file in the same dir
  cleanup(): Promise<void>;                 // removes the private workspace dir
  [Symbol.asyncDispose](): Promise<void>;   // alias of cleanup()
};
```

### `withTempFile`

Same shape with auto-cleanup:

```ts
import { withTempFile } from "@openclaw/fs-safe/advanced";

await withTempFile({ fileName: "out.zip", prefix: "pack-" }, async (filePath) => {
  await pack(filePath);
  await uploadAndForget(filePath);
});
```

## Sibling temp writes

When you want to write to a temp file in **the same directory** as a future destination — useful when you need atomic placement but don't want to use `replaceFileAtomic`'s full machinery.

### `writeSiblingTempFile`

```ts
import { writeSiblingTempFile } from "@openclaw/fs-safe/advanced";

const result = await writeSiblingTempFile<string>({
  dir: "/srv/workspace",
  mode: 0o600,
  writeTemp: async (tempPath) => {
    await fs.writeFile(tempPath, JSON.stringify(state));
    return "state.json";
  },
  resolveFinalPath: (fileName) => path.join("/srv/workspace", fileName),
});
// result.filePath, result.result (returned by writeTemp)
```

`writeSiblingTempFile` chooses a random sibling name in `dir`, calls your `writeTemp()` callback, validates that `resolveFinalPath(result)` is still inside that same directory, and renames the temp file there.

By default it preserves the historical private-helper behavior of chmodding
`dir` to `dirMode` (default `0o700`). Pass `chmodDir: false` when the directory
is a public staging/output path whose existing mode must be preserved.

### `writeViaSiblingTempPath`

A higher-level convenience for callback-based producers. The callback writes to
a private temp path, then the helper copies the result into `targetPath` through
the root boundary:

```ts
import { writeViaSiblingTempPath } from "@openclaw/fs-safe/advanced";

await writeViaSiblingTempPath({
  rootDir: "/srv/workspace",
  targetPath: "/srv/workspace/state.json",
  writeTemp: async (tempPath) => {
    await fs.writeFile(tempPath, JSON.stringify(state));
  },
});
```

If `replaceFileAtomic` does what you need, prefer that. Use
`writeViaSiblingTempPath` when the producer needs a concrete temp pathname but
the final destination still needs root-boundary checks.

## Secure temp root

The `resolveSecureTempRoot()` helper picks a per-user directory under the system temp dir, creates it at mode `0o700` if missing, and returns the absolute path. The other helpers in this module call it by default; you can call it directly if you need to materialize the root yourself.

```ts
import { resolveSecureTempRoot } from "@openclaw/fs-safe/temp";

const tempRoot = resolveSecureTempRoot({ fallbackPrefix: "my-app" });
// e.g. /tmp/my-app-501
```

### Options

```ts
type ResolveSecureTempRootOptions = {
  fallbackPrefix: string;             // fallback directory base name
  preferredDir?: string;              // preferred secure temp root
  skipPreferredOnWindows?: boolean;
  unsafeFallbackLabel?: string;       // text used in thrown errors
  warningPrefix?: string;             // default "[fs-safe]"
  warn?: (message: string) => void;    // default console.warn

  // Platform/test adapters; production callers normally omit these.
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  tmpdir?: () => string;
  accessSync?: typeof import("node:fs").accessSync;
  chmodSync?: typeof import("node:fs").chmodSync;
  lstatSync?: (path: string) => {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode?: number;
    uid?: number;
  };
  mkdirSync?: (
    path: string,
    options: { recursive: boolean; mode?: number },
  ) => void;
};
```

When `process.getuid()` is available, the fallback is
`<tmpdir>/<fallbackPrefix>-<uid>`. Without a UID (including Windows), it is
`<tmpdir>/<fallbackPrefix>`; no username is appended. The helper never returns
the shared `os.tmpdir()` directory itself. It requires the selected path to be
a writable, non-symlink directory and, when UID/mode facts are available,
owned by the current user without group/world write bits. It creates or repairs
the fallback to mode `0o700` where mode bits apply. If it cannot establish that
state, it throws an ordinary `Error`; there is no native mode or
`helper-unavailable` branch on this API.

## Common patterns

### Build something, atomically place it

```ts
import { replaceDirectoryAtomic } from "@openclaw/fs-safe/atomic";

await withTempWorkspace({ rootDir: "/srv/site/tmp", prefix: "build-" }, async (ws) => {
  await runCompiler({ outDir: ws.dir });
  await replaceDirectoryAtomic({
    stagedDir: ws.dir,
    targetDir: "/srv/site/public",
  });
});
```

### Stream a download to a sibling temp, then commit

```ts
import { writeSiblingTempFile } from "@openclaw/fs-safe/advanced";
import fs from "node:fs/promises";

const r = await writeSiblingTempFile({
  dir: "/srv/cache",
  writeTemp: async (tempPath) => {
    const handle = await fs.open(tempPath, "w");
    try {
      await pipeline(downloadStream, handle.createWriteStream());
    } finally {
      await handle.close();
    }
    return "blob.bin";
  },
  resolveFinalPath: (fileName) => path.join("/srv/cache", fileName),
});

console.log(`downloaded ${r.filePath}`);
```

### Per-call private scratch in a test

```ts
import { withTempWorkspace } from "@openclaw/fs-safe/temp";

it("processes a fixture", async () => {
  await withTempWorkspace({ rootDir: "/tmp/my-tests", prefix: "test-" }, async (ws) => {
    await fs.writeFile(path.join(ws.dir, "input.txt"), fixture);
    const out = await processFile(path.join(ws.dir, "input.txt"));
    expect(out).toEqual(expected);
  });
});
```

## See also

- [Atomic writes](atomic.md) — `replaceDirectoryAtomic` for whole-directory swaps.
- [`root()`](root.md) — `fs.copyIn(rel, sourceAbs)` for moving files from a temp into a `Root`.
- [File lock](sidecar-lock.md) — when many processes share a temp tree.
