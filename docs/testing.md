# Testing

`@openclaw/fs-safe/test-hooks` exposes test-only injection points. Registration
is allowed only when `process.env.NODE_ENV === "test"` or
`process.env.VITEST === "true"`; registering a non-empty hook set elsewhere
throws. Production code must not import this subpath.

```ts
import {
  __setFsSafeTestHooksForTest,
  type FsSafeTestHooks,
} from "@openclaw/fs-safe/test-hooks";
```

The double-underscore prefix is a deliberate "hands off" signal: production code should never import this module. ESLint or your equivalent linter should flag it.

## When to reach for hooks

- Reproduce a TOCTOU race deterministically: simulate a symlink swap between resolve and open, or between write and rename.
- Force guarded JavaScript behavior without removing bundled binaries from your runners.
- Inject latency to test cancellation/timeout paths.

If you don't need to inject a race, you don't need hooks — most tests should drive the library through normal calls and assert on observable behavior.

## Hooks API

```ts
type FsSafeTestHooks = {
  afterPreOpenLstat?: (filePath: string) => Promise<void> | void;
  beforeOpen?: (filePath: string, flags: number) => Promise<void> | void;
  afterOpen?: (filePath: string, handle: import("node:fs/promises").FileHandle) => Promise<void> | void;
  afterPublishTargetCreated?: (method, targetPath, identity) => Promise<void> | void;
  beforePublishDirectorySync?: (method, targetPath, identity) => Promise<void> | void;
  // Additional archive, store, root-fallback, temp, and trash race hooks are
  // documented on the focused Test hooks reference page.
};

function __setFsSafeTestHooksForTest(hooks?: FsSafeTestHooks): void;
function getFsSafeTestHooks(): FsSafeTestHooks | undefined;
```

Hooks are called at well-defined points in the library's hot paths:

- **`afterPreOpenLstat`** — runs after the pre-open `lstat`. A common use is to swap the path's target via `fs.symlink`/`fs.unlink` to drive a TOCTOU race.
- **`beforeOpen`** — runs before `fs.open` with the exact flags the root read path will use.
- **`afterOpen`** — runs after the file handle is opened. Useful to wrap handle methods or inject a size race before a stream is consumed.
- **`afterPublishTargetCreated`** — runs after exclusive publication created a target but before its final fences.
- **`beforePublishDirectorySync`** — runs after target verification and immediately before strict parent sync; useful for exercising `onSyncFailure`.

`__setFsSafeTestHooksForTest(undefined)` clears all hooks. Always clean up between tests.

## Example: simulate a TOCTOU swap

```ts
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root, FsSafeError } from "@openclaw/fs-safe";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-toctou-"));
  await writeFile(path.join(dir, "real.txt"), "secret");
  await writeFile(path.join(dir, "decoy.txt"), "decoy");
});
afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  await rm(dir, { recursive: true, force: true });
});

it("rejects a swap between resolve and open", async () => {
  const fs = await root(dir, { symlinks: "reject" });

  __setFsSafeTestHooksForTest({
    afterPreOpenLstat: async (absPath) => {
      // swap real.txt for a symlink to decoy.txt right before the open
      await unlink(absPath);
      await symlink(path.join(dir, "decoy.txt"), absPath);
    },
  });

  await expect(fs.read("real.txt")).rejects.toMatchObject({
    name: "FsSafeError",
    code: expect.stringMatching(/symlink|path-mismatch/),
  });
});
```

The `code` may be `symlink` (caught at open by `O_NOFOLLOW`) or `path-mismatch` (caught by the post-open identity check) depending on platform — both are correct refusals.

## Example: force guarded JavaScript fallback behavior

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
});

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
});

it("runs without the native helper", async () => {
  const fs = await root(dir);
  await fs.write("file.txt", "ok");
  await expect(fs.readText("file.txt")).resolves.toBe("ok");
});
```

## Cleanup is mandatory

Hooks set by `__setFsSafeTestHooksForTest` persist across tests until explicitly cleared. Always clear in `afterEach` (or your test framework's equivalent) — leaked hooks will silently change behavior in unrelated tests and cause maddening intermittent failures.

```ts
import { afterEach } from "vitest";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});
```

A global hook clear in your test setup file is a good safety net.

See the [complete Test hooks reference](test-hooks.md) for every optional hook.

## Patterns for testing fs-safe-using code

You usually don't need hooks. Most tests follow this shape:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "@openclaw/fs-safe";

let dir: string;
let fs: Awaited<ReturnType<typeof root>>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "my-feature-"));
  fs = await root(dir, { symlinks: "reject", hardlinks: "reject", mkdir: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("writes and reads through the boundary", async () => {
  await fs.write("notes/today.txt", "hello");
  expect(await fs.readText("notes/today.txt")).toBe("hello");
});
```

For tests that need a private temp workspace, [`withTempWorkspace`](temp.md) makes the setup-and-teardown story trivial.

## Repo test shards

Run the full local gate before handoff:

```sh
pnpm check
```

Run only the security boundary corpus while iterating on root/path/archive/temp hardening:

```sh
pnpm test:security
```

Run the static primitive guard after changing low-level filesystem helpers:

```sh
pnpm lint:fs-boundary
```

It catches the specific raw fallback patterns that previously led to
check-then-use bugs, such as direct copy-to-destination fallback and sync temp
workspace reads that bypass pinned file descriptors.

`pnpm check` also runs `pnpm lint:file-size`. New source and test files should stay under 500 lines. Existing larger files have explicit budgets in `scripts/check-file-size.mjs`; do not increase those budgets as part of unrelated work.

## See also

- [Security model](security-model.md) — what the boundary is supposed to defend; design tests around the same threats.
- [`root()`](root.md) — the surface most tests will exercise.
- [Temp workspaces](temp.md) — `withTempWorkspace` for cleanup-on-exit test directories.
