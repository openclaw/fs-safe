# Testing

## Manual watch stress campaign

Build from the exact revision being qualified with `pnpm install --frozen-lockfile`,
`pnpm native:build`, and `pnpm build`, then run on a disposable machine:

```sh
node scripts/watch-stress.mjs --scenario all
```

Individual scenario names are `scale`, `fanout`, `churn`, `lifecycle`,
`adversarial`, `limits`, `idle`, and `soak`. The runner uses plain Node and no
additional dependencies. Each scenario prints one JSON result line; progress
goes to stderr. `all` isolates scenarios in child processes and stops at the
first failure. This suite is manual and is not part of per-PR CI.

Run `node scripts/watch-stress.mjs --scenario oracle-selftest` first to check
that a poisoned cache fails comparison and can recover only after invalidation.
All fixture Roots live in `os.tmpdir()`. The consumer cache refreshes only from
`onInvalidate`, using guarded Root reads of invalidated paths/scopes. After
quiescence and a fresh `reconcile()`, checkpoints compare it with an independent
filesystem walk, including file-content hashes. A mismatch is a failure, with
no comparison retry or checkpoint-triggered cache refresh. Transient guarded
read failures retain already-invalidated consumer work and settle at 25 ms
intervals, with a 120-second flush deadline; these errors are counted in results.

Scale uses 50,000 files in 2,000 child directories. Fan-out checks 64 and 256
distinct Roots, one shared hub thread, and return to the warmed handle baseline.
Churn first creates 1,024 entries while JavaScript is blocked to exceed the
default 256-path detail budget, then runs at least five minutes with persistent
differences across 10,000-mutation batches and isolated edit latency measurements.
Lifecycle performs 10,000 ready/close cycles plus admission
cancellation, close-during-ready, 1,000 scope replacements, and callback-close.
Adversarial cases exercise Root swaps, outside symlinks, recursive deletion and
10,000 same-name create/delete pairs. Soak runs 60 minutes, checking the oracle
each minute. Linux needs passwordless `sudo` for the limits scenario; it lowers
`fs.inotify.max_user_watches` to 1 in a child shell with a restoration trap and
verifies restoration. Never run that scenario on a shared production host.

RSS limits are fixed before execution: 512 MiB peak for churn/soak, at most
64 MiB churn growth after warmup, and at most 32 MiB lifecycle growth after 3,000
cycles. Soak collects garbage twice at every checkpoint, limits collected-heap
and external-memory growth to 8 MiB after minute five, and requires the fitted
RSS slope over minutes 31–60 to stay at or below 1 MiB/minute. The runner launches
soak with `--expose-gc` automatically, including through `--scenario all`.
Reports include samples and fitted slopes. Idle runs for ten minutes
with 16 subscriptions and a one-hour reconciliation interval to isolate native
hub wakeups, requiring less than 1% of one CPU and, on Linux, at most 30 hub
context switches. macOS captures `ps -M`; Windows captures PowerShell thread
CPU time and handle counts. macOS descriptor counts use `lsof`.

The macOS limits case also exercises injected UserDropped/KernelDropped flags
through the native decoder and labels these as synthetic. Natural FSEvents drop
flags are not independently observable through the current public batch. Windows
records native overflow and recovery, but the shared batch does not distinguish
RDCW kernel-buffer loss from bounded native queue loss; a Windows qualification
must retain that limitation rather than call it proved kernel overflow.

## Linux openat2 fallback

Build the host addon and package first. The test hook is cached with the native
capability probe; set it before starting the process, rather than changing it
between tests in one process:

```bash
pnpm native:build
pnpm build
FS_SAFE_TEST_NO_OPENAT2=1 FS_SAFE_NATIVE_MODE=require pnpm test test/linux-openat2-fallback.test.ts test/root-move-noreplace.test.ts test/root-move-native-integration.test.ts test/native-write-containment.test.ts
```

On Linux, the seccomp harness also exercises the real syscall failure without
the environment hook. It needs a C compiler and permission to install an
unprivileged seccomp filter; it affects only its child process:

```bash
cc test/fixtures/deny-openat2.c -o /tmp/fs-safe-deny-openat2
/tmp/fs-safe-deny-openat2 ENOSYS node test/fixtures/linux-openat2-fallback.mjs "$PWD/native/fs-safe-native.linux-x64-gnu.node"
/tmp/fs-safe-deny-openat2 EPERM node test/fixtures/linux-openat2-fallback.mjs "$PWD/native/fs-safe-native.linux-x64-gnu.node"
```

Use the matching native artifact filename on other Linux architectures/libcs.
The fixture proves nested moves, collisions, read/write, traversal, symlink and
hardlink rejection, cached selection, and `helper-unavailable` for strict
bounded cleanup. Bounded-cleanup success tests require real `openat2`; run the
full suite with the environment hook unset.

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
- Force guarded JavaScript behavior without removing platform packages from your runners.
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

## Watch memory diagnosis

The original soak rule rejected more than 64 MiB RSS growth after minute five.
That outcome remains in `memory.legacyRss`, with its original limit and pass/fail
value; it is no longer the soak pass criterion. Static guarded poll scans alone
reproduced growth from 72 to 181 MiB RSS while collected heap stayed near 7–8 MiB:
V8 expanded its almost-empty young generation to 128 MiB, with 103 MiB physically
committed. A diagnostic run limiting that space ended at 85 MiB RSS with the
same live heap. The normal harness keeps Node's default nursery sizing.

The 60-minute qualification separates this capacity warm-up from the later RSS
trend. The measured Linux event run had under 1 MiB collected-heap drift and a
0.55 MiB/minute second-half RSS slope; its final ten-minute RSS range was 1.60 MiB.
The 8 MiB live-memory allowance and 1 MiB/minute RSS slope leave measurement
margin while rejecting retained growth and continued rapid RSS growth. The
512 MiB peak ceiling is unchanged. Native allocation leaks need independent
accounting/profiling too: the investigation found a much smaller cleanup-hook
context leak even when registrations, pending sets, and TSFN counters retired.

Build the native addon and package from the same revision, then run each control
in a fresh Node process on a disposable machine:

```sh
node --expose-gc scripts/watch-memory.mjs --arm events --minutes 60 --output .artifacts/events
node --expose-gc scripts/watch-memory.mjs --arm none --minutes 30 --output .artifacts/none
node --expose-gc scripts/watch-memory.mjs --arm poll --minutes 30 --output .artifacts/poll
node --expose-gc scripts/watch-memory.mjs --arm lifecycle --minutes 30 --output .artifacts/lifecycle
node --expose-gc scripts/watch-memory.mjs --arm steady --minutes 30 --output .artifacts/steady
```

`events` and `poll` combine low-rate edits, a 10,000-operation burst every fifth
minute, and subscription cycling. `steady` omits cycling; `lifecycle` omits
writes. `none` drives the same writer and consumer cache using explicit synthetic
invalidations, without constructing subscriptions. That arm is an allocation
control, not evidence of watcher correctness. Every arm checks its consumer
cache against an independent filesystem walk at each checkpoint.

The diagnostic runner emits JSONL to stdout and `memory.jsonl` in its output
directory. Each minute includes all five `process.memoryUsage()` fields before
and after collection, V8 heap-space capacity, Linux `smaps_rollup`, operation and
guarded-read counts, and live/created/destroyed native watch allocations.
`--gc none` measures the same workload without forced collection. `--snapshots`
writes V8 snapshots at minutes 5 and 30; use a separate run because snapshots
perturb memory usage. On macOS, `--tools` saves `vmmap --summary` and `leaks`
reports at minutes 5, 30, and 60. `--smoke` is a short calibration, explicitly
marked in output; it is not a duration-qualified soak.

The native allocation getter is internal and requires `NODE_ENV=test` or
`VITEST=true`; the runner sets the former. After close, it requires no live
registrations, pending sets, callback payloads, or thread-safe functions.
Diagnostic success establishes correctness and retirement; it does not classify
an RSS curve as a leak or automatically approve a memory budget.

## See also

- [Security model](security-model.md) — what the boundary is supposed to defend; design tests around the same threats.
- [`root()`](root.md) — the surface most tests will exercise.
- [Temp workspaces](temp.md) — `withTempWorkspace` for cleanup-on-exit test directories.
