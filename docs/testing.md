# Testing

The [seeded differential harness](https://github.com/openclaw/fs-safe/blob/main/scripts/differential-root.md) compares
isolated Node/Bun, native/fallback and sync/async public API runs, retaining
replayable return/error/tree receipts and bounded reduced repros. Its small
`node scripts/differential-root.mjs --ci` corpus runs in native CI lanes.

## Coverage gates

The coverage workflow measures `src/**/*.ts` with V8 on Linux, macOS, and
Windows, then merges their counters before enforcing the thresholds in
`vitest.config.ts`: lines 94%, statements 92%, functions 95%, and branches 89%.
`pnpm test:coverage:collect` disables per-OS thresholds so platform-only paths
are credited by their own OS; `pnpm test:coverage:merge` requires all three
reports and enforces the combined gate. The DACL batch child entrypoint also
runs in-process in a unit test so its protocol and budget handling are measured.

The Linux Rust job uses pinned `cargo-llvm-cov` and a pinned nightly compiler
for line and branch instrumentation. It combines native crate unit tests with
TS native suites running the instrumented addon, and exports LCOV plus separate
unit-only and combined summaries. The Rust line threshold is 71%; addon execution
must also increase covered Rust lines beyond the unit tests. Only native crate sources compiled on Linux are measured;
macOS/Windows Rust implementations and the archive WASM crate are outside this
report. Run `pnpm build` followed by `bash scripts/native-coverage.sh` on Linux
after installing the toolchain versions specified in `coverage.yml`.

Percentages complement behavioral gates: mutation-policy proof, nightly watch
stress, and platform lanes are equally important. High coverage cannot establish
root confinement, race safety, event delivery, or bounded resource retirement.

## Hosted mutation-policy proof

The [hosted workflow](https://github.com/openclaw/fs-safe/blob/main/.github/workflows/mutation-policy-proof.yml)
builds the event-head package and host addon on Node 24 Linux, macOS, and Windows.
The [harness](https://github.com/openclaw/fs-safe/blob/main/scripts/mutation-policy-proof.mjs)
runs isolated temporary fixtures and binds sources, built modules, and the addon
to the tested revision. Its [receipt contract](https://github.com/openclaw/fs-safe/blob/main/test/mutation-policy-proof-contract.test.ts)
and [case contract](https://github.com/openclaw/fs-safe/blob/main/test/mutation-policy-proof-cases-contract.test.ts)
define the executable inventory and bounds.

Receipts describe representative observations: final listings and sentinels
neither count native syscalls nor exclude transient effects. Windows compatibility
payload writes remain JavaScript even when native-required sidecar publication
uses `Root.create`. Hosted cases complement internal interleaving tests; they
are neither exhaustive race proof nor performance clearance. Inspect exact
hosted artifacts before relying on a receipt's claims.

## Watch stress campaign

Build from the exact revision being qualified with `pnpm install --frozen-lockfile`,
`pnpm native:build`, and `pnpm build`, then run on a disposable machine:

```sh
node scripts/watch-stress.mjs --scenario all
```

Individual scenario names are `scale`, `fanout`, `churn`, `lifecycle`,
`adversarial`, `limits`, `idle`, and `soak`. The runner uses plain Node and no
additional dependencies. Each scenario prints one JSON result line; progress
goes to stderr. `all` isolates scenarios in child processes and stops at the
first failure. The full qualification remains manual. A smaller nightly campaign runs outside
per-PR CI; it can also be dispatched with `watch-stress.yml`.

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

### Nightly workload

The nightly workflow runs on `ubuntu-latest` (x64), `ubuntu-24.04-arm`,
`macos-15` (arm64), `macos-15-intel`, and the Windows latest 16-core runner,
using Node 24 and freshly built native bindings. Each job has a 25-minute
budget, uploads one JSON result per scenario (including failures), and fails
if any scenario fails. Remaining scenarios still run after a failure. Only
Linux runs the kernel-limits scenario automatically.

The same harness accepts these environment overrides; defaults remain the
full qualification workload. Child processes inherit the settings, which are
recorded in every JSON result.

| Environment variable | Default | Nightly |
| --- | ---: | ---: |
| `FS_SAFE_STRESS_SCALE_DIRECTORIES` (25 files each) | 2,000 | 400 (10,000 files) |
| `FS_SAFE_STRESS_FANOUT` (maximum subscriptions) | 256 | 64 |
| `FS_SAFE_STRESS_CHURN_SECONDS` | 300 | 60 |
| `FS_SAFE_STRESS_LIFECYCLE_CYCLES` | 10,000 | 1,000 |
| `FS_SAFE_STRESS_IDLE_SECONDS` | 600 | 120 |
| `FS_SAFE_STRESS_SOAK_MINUTES` (minimum 10) | 60 | 10 |

Soaks shorter than 30 minutes keep the hard peak-RSS, collected-heap, and external-memory
growth gates, but report the second-half RSS slope and its limit without using it
to pass or fail (`memory.rssSlopeGated: false`): [#701](https://github.com/openclaw/fs-safe/pull/701)
found that V8 capacity expansion and allocator retention can raise RSS while live memory stays flat.
Runs of 30 minutes or longer enforce the same second-half slope limit; only runs of
at least 60 minutes report `memory.qualification: true`.
Lifecycle memory is sampled across ten intervals, with
the first two excluded as warm-up; idle's Linux wakeup bound scales with the
requested duration (three per minute). Adversarial cases remain unchanged.

## Linux openat2 fallback

Build the host addon and package first. The test hook is cached with the native
capability probe; set it before starting the process, rather than changing it
between tests in one process:

```bash
pnpm native:build
pnpm build
FS_SAFE_TEST_NO_OPENAT2=1 FS_SAFE_NATIVE_MODE=require pnpm test test/linux-openat2-parity.test.ts test/linux-openat2-fallback.test.ts test/root-move-noreplace.test.ts test/root-move-native-integration.test.ts test/native-write-containment.test.ts
```

On Linux, the seccomp harness also exercises the real syscall failure without
the environment hook. It needs a C compiler and permission to install an
unprivileged seccomp filter; it affects only its child process:

```bash
cc test/fixtures/deny-openat2.c -o /tmp/fs-safe-deny-openat2
/tmp/fs-safe-deny-openat2 ENOSYS node test/fixtures/linux-openat2-fallback.mjs "$PWD/native/fs-safe-native.linux-x64-gnu.node"
/tmp/fs-safe-deny-openat2 EPERM node test/fixtures/linux-openat2-fallback.mjs "$PWD/native/fs-safe-native.linux-x64-gnu.node"
FS_SAFE_TEST_OPENAT2_FILTER=/tmp/fs-safe-deny-openat2 FS_SAFE_NATIVE_MODE=require pnpm test test/linux-openat2-parity.test.ts
```

Use the matching native artifact filename on other Linux architectures/libcs.
The fixtures prove in-root alias operations and policy parity, nested moves,
collisions, read/write, traversal and escaping-link rejection, hardlink rejection,
cached selection, and `helper-unavailable` for strict
bounded cleanup. Bounded-cleanup success tests require real `openat2`; run the
full suite with the environment hook unset. PR CI's `Native check
(linux-x64-no-openat2)` runs the native Node suites and watch proofs with the
hook set. It replaces the four bounded-cleanup success suites and quarantine
success proof with the explicit refusal fixture above. XFS tree-clone proof
requires the same openat2/NO_XDEV primitive and runs in the ordinary Linux
lanes. Bun's full compatibility
suite remains in the normal native lanes, because it includes bounded cleanup.

## When to reach for hooks

- Reproduce a TOCTOU race deterministically: simulate a symlink swap between resolve and open, or between write and rename.
- Force guarded JavaScript behavior without removing platform packages from your runners.
- Inject latency to test cancellation/timeout paths.

If you don't need to inject a race, you don't need hooks — most tests should drive the library through normal calls and assert on observable behavior.

## Hooks API

`@openclaw/fs-safe/test-hooks` exposes injection points for downstream tests,
not a supported runtime API. Production code must not import it; enforce that
with your linter. New optional fields may appear between minor versions.

```ts
import {
  getFsSafeTestHooks,
  __setFsSafeTestHooksForTest,
  type FsSafeTestHooks,
} from "@openclaw/fs-safe/test-hooks";
```

```ts
function __setFsSafeTestHooksForTest(hooks?: FsSafeTestHooks): void;
function getFsSafeTestHooks(): FsSafeTestHooks | undefined;
```

Registering any truthy hook set (including `{}`) requires
`process.env.NODE_ENV === "test"` or `process.env.VITEST === "true"`; otherwise
the setter throws. Clearing with `undefined` is allowed in any environment.
The getter returns the registered set, or `undefined` when none is registered;
changing the environment does not erase registered hooks.

All fields are optional. Callbacks return `Promise<void> | void` and are awaited
unless marked **sync**, which requires `void` and must not return a promise.
Path arguments are strings, `flags` is a number, `withFileTypes` is a boolean,
and `handle` is a Node `FileHandle`. Publication `method` is `"hardlink"`,
`"exclusive-copy"`, or `"rename-noreplace"`; `identity` carries `dev` and `ino`
as numbers or bigints.

| Hook | Callback arguments | Timing |
|---|---|---|
| `beforeWatchRegistration` | `path` | Before a scanned directory's registration step, including when its existing registration is reused. |
| `afterWatchRegistration` | `path` | After that registration step, before recording a newly acquired registration. |
| `afterWatchBackendOverflow` (**sync**) | `root, phase` (`"received"` or `"reconciled"`) | On an overflow hint, and after a noninitial reconciliation produces an overflow invalidation. |
| `afterWatchBackendCreated` (**sync**) | `root, emit, nativeEvent?` | After creating/configuring the backend, before scanning. `emit(batch)` injects a native watch batch; `nativeEvent(path, flags)` injects a decoder event. |
| `afterPreOpenLstat` | `filePath` | After pre-open `lstat`, before opening the file. |
| `beforeOpen` | `filePath, flags` | Immediately before the guarded file open. |
| `afterOpen` | `filePath, handle` | After open, before the post-open identity check. |
| `afterOpenedPathIdentityCheck` | `filePath, handle` | A standalone local-file or absolute copy-source descriptor matches its pathname, before the generic opened-path resolver. Root reads use final admission hooks instead. |
| `afterRootReadPathResolution` | `filePath` | After Root read path resolution, before local-file open admission. |
| `beforeRootReadFinalFence` | `filePath, handle` | After descriptor identity and hardlink checks, before the final root/path/canonical-path/root admission fence. |
| `afterRootReadFinalPathIdentityCheck` (**sync**) | `filePath, handle` | After the final pathname-to-descriptor comparison, before the second root check. |
| `beforeArchiveOutputMutation` | `operation` (`"mkdir"` or `"chmod"`), `targetPath` | Before archive staging creates a directory or applies a mode. |
| `beforeFileStorePruneDescend` | `dirPath` | Before file-store pruning descends into a directory. |
| `beforeFileStoreSyncPrivateWrite` (**sync**) | `filePath` | Before a synchronous private-store write mutates its target. |
| `beforeRootFallbackMutation` | `operation` (`"mkdir"`, `"move"`, or `"remove"`), `targetPath` | Before a guarded JavaScript Root fallback mutation. |
| `beforePinnedWriteParentAdmission` | `targetPath` | After pinned-write policy preflight, before parent admission; also before refreshing retained JavaScript write authority and parent checks. |
| `beforeRootStatObservation` | `targetPath` | After `Root.stat()` admits the target and parent, before collecting returned metadata. |
| `beforeRootStatInitialObservation` | `targetPath` | After `Root.stat()` admits the parent, before its first target inspection. |
| `beforeRootListObservation` | `directoryPath, withFileTypes` | After `Root.list()` admits the selected directory, before collecting names and optional metadata. |
| `afterPinnedWriteFallbackRename` | `targetPath` | After fallback rename commits, before post-commit identity checks. |
| `beforeSiblingTempWrite` | `tempPath` | Before the `writeViaSiblingTempPath` producer runs, with its selected output pathname still absent. |
| `beforeSidecarLockSnapshotOpen` | `lockPath` | After sidecar inspection, before opening it for a bounded snapshot read. |
| `beforeRegularFileAppendOpen` | `filePath` | After append preflight and the initial size-budget check, before async open. |
| `beforeRegularFileAppendOpenSync` (**sync**) | `filePath` | The corresponding sync append point, before `openSync`. |
| `beforeTempWorkspaceNativeRemoval` | `quarantinePath` | After workspace quarantine admission, immediately before native owned-tree removal. |
| `beforeTempWorkspaceNativeRemovalSync` (**sync**) | `quarantinePath` | The corresponding sync native-removal point. |
| `beforeTrashMove` (**sync**) | `targetPath, destPath` | Before trash handling moves the target. |
| `afterPublishTargetCreated` | `method, targetPath, identity` | After exclusive publication creates the target, before final fences. |
| `beforePublishDirectorySync` | `method, targetPath, identity` | After publication verifies the target, immediately before strict parent sync. |

The watch `emit` callback accepts `{ hints, overflow, error? }`: `overflow` is
boolean, `error` is a string, and each hint has string `directory` and `name`
fields plus an `event` of `"rename"`, `"change"`, or `"children"`.

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

Use `__setFsSafeTestHooksForTest(undefined)` as in the TOCTOU example above.
A global hook clear in your test setup file is a good safety net; the
[Hooks API](#hooks-api) lists every optional hook.

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

On macOS, after building the native addon, run the native watch cleanup allocation
regression with `MallocStackLogging=1 node --expose-gc scripts/watch-cleanup-leak-proof.mjs`.
It compares `leaks` results before and after 100 and 1,000 subscription cycles,
requiring zero growth in leaked allocations. Allocation stacks are saved under
`.artifacts/watch-cleanup-leaks`. The native macOS CI lane runs this short proof;
the full stress qualification remains manual, with the smaller nightly
campaign above.

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
value; it is no longer the soak pass criterion. V8 capacity expansion and
allocator retention can raise RSS while collected live memory stays flat.
The normal harness keeps Node's default nursery sizing and separates warm-up
from later RSS growth with the [current stress gates](#watch-stress-campaign).
Native allocation leaks still need independent accounting/profiling, even when
registrations, pending sets, and thread-safe function counters retire.

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
