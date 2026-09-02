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

A private workspace is a directory created at mode `0o700` under a caller-provided temp root. It is unique per call (random suffix). Calling `cleanup()` or leaving an `await using` scope moves an unchanged workspace through a private quarantine before removal. Descriptor-bounded cleanup prevents recursive traversal of substitutions; the compatible JavaScript fallback has the narrower race contract documented below.

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
  cleanup(): Promise<"removed" | "missing" | "identity-mismatch" | "indeterminate">;
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
Both the async and sync `read` methods throw `FsSafeError("not-file")` when the
named leaf is a directory or another non-regular target, and preserve the
`not-found`, `hardlink`, or `symlink` code for those stable target states.
Operational filesystem read failures use `read-failed` with the Node error in
`cause`.

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

**Compatibility and security:** workspace creation remains available in native
`auto`, `off`, and unavailable-native environments. The default
`cleanupSafety: "compatible"` preserves the JavaScript cleanup behavior from
0.6: it verifies the workspace identity, moves the public name to a fresh
`.fs-safe-workspace-cleanup-<uuid>` sibling, verifies that quarantine, and then
uses guarded pathname-recursive removal. This fallback never recursively
removes the public workspace name, but it is not atomic conditional deletion: a
same-privilege peer that discovers and replaces the private quarantine after
verification can still redirect the final pathname removal.

Set `cleanupSafety: "require-bounded"` when that concurrent attacker is in scope.
Creation then requires native no-replace directory rename, native owned-tree
removal, and a retained parent descriptor **before** `mkdtemp` creates
a child. If any capability is unavailable, creation throws
`FsSafeError("helper-unavailable")`; no child is created and a scoped callback is
not called. The compatible default retains its fallback even if process-global
native mode is `require`; select `require-bounded` to make cleanup capability
mandatory for this API.

On Linux, bounded cleanup requires a successful runtime probe of the exact
`openat2` child-directory flags, including `RESOLVE_NO_XDEV`, against the retained
parent descriptor. If the kernel or seccomp policy denies that capability,
compatible mode uses the guarded JavaScript fallback; `require-bounded` rejects
before child creation. The probe runs once at creation, without filesystem mutation.

Bounded cleanup checks the parent and public workspace identity, quarantines
the direct child without replacement, and verifies the quarantine against the
retained workspace descriptor. It binds every enumerated child to its native
identity before opening it, rejects mount crossings, and traverses descendants
only through opened directory handles; symlinks/reparse entries are removed as
leaves and never traversed. Windows marks the exact opened objects for deletion by handle.

POSIX has no unlink-by-fd or expected-inode unlink for directory entries. After
the final identity check, each `unlinkat` can still be raced; the possible side
effect is bounded to one substituted non-directory leaf or one empty directory
entry per raced syscall. A substituted nonempty directory is never recursively
traversed and is preserved as `"indeterminate"`, but a leaf replacement removed
in that irreducible final gap cannot be distinguished after the syscall.

The workspace captures its identity, binding, and descriptors until cleanup.
Later process-global mode changes or loader resets do not revoke that authority.
Manual, disposal, and process-exit cleanup share one serialized owner,
registered before store construction; a construction failure after registration
remains exit-cleanable. Earlier creation failures close retained descriptors
without deleting an unverified child.

If the quarantine does not match the creation descriptor, cleanup leaves it in
place without restoring the public name or recursively deleting it and returns
`"indeterminate"`. A collision, uncertain rename outcome, changed parent,
mount/device crossing, changed reparse state, or detected concurrent mutation also
preserves the remaining artifact. Recover `.fs-safe-workspace-cleanup-<uuid>` entries only
after excluding competing mutators and re-establishing ownership.

A missing workspace returns `"missing"`. A replacement observed at the public
name before quarantine returns `"identity-mismatch"` when the parent is stable;
an ambiguous parent returns `"indeterminate"`. After successful removal,
repeated cleanup returns `"missing"` without touching a recreated public name.
Other statuses remain stable. Operational removal errors propagate and later
cleanup returns `"indeterminate"` without retrying. Disposal and scoped helpers
ignore returned statuses, while manual cleanup exposes the result.

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
  } else if (cleanup === "indeterminate") {
    alertOperator("restore workspace cleanup could not establish safe completion; inspect retained entries");
  }
}
```

The sync variant `tempWorkspaceSync` exposes the same surface with sync return
types and a `FileStoreSync` at `workspace.store`.

### `withTempWorkspace`

The recommended shape. Attempts cleanup on every exit path:

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
  cleanupSafety?: "compatible" | "require-bounded"; // default compatible
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
  cleanup(): Promise<void>;                 // removes the original private workspace dir
  [Symbol.asyncDispose](): Promise<void>;   // alias of cleanup()
};
```

Cleanup captures the directory identity at creation time. If that path is
renamed away and replaced, cleanup preserves the replacement rather than
recursively deleting a directory it did not create.

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

`writeSiblingTempFile` chooses a random, initially absent sibling name in `dir`
and calls `writeTemp()`. After the callback succeeds, it validates the produced
regular file before taking ownership: symlinks, directories, other non-regular
files, hardlinks, and changes between the pre-open pathname, opened descriptor,
and current pathname are rejected. The callback must finish and close its
writer before returning. Its return value is preserved as `result`.

The helper retains one descriptor through requested mode application, opt-in
file synchronization, rename, and publication verification. It opens read-only
unless file synchronization is requested, so closed read-only producer output
remains publishable under the historical default. Omitting
`mode` preserves the callback-produced mode without chmod; explicit modes,
including `0`, are applied through that descriptor. File-mode errors are
tolerated for compatibility with the helper's historical best-effort behavior.
No chmod, content read, or reopen follows
the staged or published pathname. `resolveFinalPath(result)` must resolve to a
distinct direct child of the same directory. Final-path writes are serialized
within the process, and the retained descriptor and current name must still
have the admitted exact bigint identity and exactly one link before rename and
after publication. A verification failure after rename does not roll back or
delete the final name.

`syncTempFile` and `syncParentDir` retain their historical `false` defaults.
Explicit `syncTempFile: true` synchronizes the descriptor before rename;
file-sync errors propagate except for the existing `EPERM` compatibility case.
Explicit `syncParentDir: true` requests best-effort parent sync after rename.
Omitting either option or passing `false` skips that sync, never the identity
checks. Parent synchronization can be unsupported or fail without rejecting
the write, so success is not a strict crash-durability receipt.

Cleanup only unlinks an admitted file while the parent, pathname identity, and
single-link regular-file checks still agree. Observed substitutes are preserved,
including during process-exit cleanup. Operational cleanup failures retain an
identity-bound exit retry. If the callback throws or admission fails, no file
has been adopted: even a regular partial file is left for caller-directed
recovery. The helper never recursively removes a sibling temp.

On POSIX, admission uses no-follow and nonblocking open flags, so a FIFO swap
does not block the helper. Windows retains Node's guarded pathname-open behavior
because Node has no portable no-follow flag there; metadata is checked before
and after opening, and unknown Windows identities fail closed after one bounded
re-inspection without reopening. These helpers remain available with native
mode `off`; they do not acquire the native-required retained-directory contract
of [`stageFileInDirectory`](staged-file.md).

Identity checks and pathname rename/unlink are separate syscalls, not atomic
conditional mutations. A hostile process can still replace a leaf or parent in
the final syscall gap or mutate an open file's contents. Use an approved writable
directory and cooperative locking or OS isolation; a moved parent can leave an
unpublished original temp behind. Observed replacements are preserved, but
arbitrary concurrent namespace changes cannot be prevented by these helpers.

By default the helper attempts to set `dir` to `dirMode` (default `0o700`)
through the shared verified POSIX directory-descriptor helper. Only the actual
descriptor chmod error is tolerated, preserving the historical best-effort
directory-mode behavior. Directory lstat, open, type, identity, and close errors
still propagate; there is no pathname chmod fallback. Windows only passes the
directory mode to `mkdir`. Pass
`chmodDir: false` when an existing staging/output directory mode must be preserved.

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
Its private workspace uses the same identity-aware directory cleanup as
`tempFile()`: moving and replacing the workspace preserves the replacement.
This workspace owns its contents, unlike the unadmitted sibling pathname above.

## Secure temp root

The `resolveSecureTempRoot()` helper picks a per-user directory under the system temp dir, creates it at mode `0o700` if missing, and returns the absolute path. The other helpers in this module call it by default; you can call it directly if you need to materialize the root yourself.

```ts
import { resolveSecureTempRoot } from "@openclaw/fs-safe/temp";

const tempRoot = resolveSecureTempRoot({ fallbackPrefix: "my-app" });
// e.g. /tmp/my-app-501
```

Consumers that only need this resolver can use the narrow package subpath:

```ts
import {
  resolveSecureTempRoot,
  type ResolveSecureTempRootOptions,
} from "@openclaw/fs-safe/secure-temp-root";
```

This entry excludes the temp workspace and store implementations from the
module graph, keeping the import closure small for browser-aware builds that
shim or exclude Node built-ins. The resolver remains a Node filesystem API; the
narrow entry does not make it runnable in a browser.

### Options

```ts
type ResolveSecureTempRootOptions = {
  fallbackPrefix: string;             // one portable path segment; invalid values throw
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
