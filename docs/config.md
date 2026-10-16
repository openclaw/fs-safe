---
title: Config
description: "Process-global defaults for optional fs-safe helpers."
---

# `@openclaw/fs-safe/config`

Process-global configuration knobs for optional fs-safe helpers. The native helper policy is described in the [native helper policy](native-helper.md); this page is the API reference.

```ts
import {
  configureFsSafeNative,
  configureFsSafeLocks,
  getFsSafeNativeConfig,
  getFsSafeNativeStatus,
  getFsSafeLockConfig,
  type FsSafeLockConfig,
  type FsSafeNativeConfig,
  type FsSafeNativeMode,
  type FsSafeNativeStatus,
  type FsSafeNativeStatusReason,
} from "@openclaw/fs-safe/config";
```

These functions are also re-exported from the main entry point. Prefer the subpath when you only need helper configuration and want the smallest import surface.

## `configureFsSafeNative(config)`

```ts
function configureFsSafeNative(config: Partial<FsSafeNativeConfig>): void;

type FsSafeNativeConfig = {
  mode: FsSafeNativeMode;
};

type FsSafeNativeMode = "auto" | "off" | "require";
```

Set the process-global loading policy. Configure once at startup, before the first filesystem operation. The binding is loaded lazily and the result is cached.

| Mode | Behavior |
|---|---|
| `auto` | Default. Prefer the platform binding and use supported fallbacks when it is unavailable. |
| `off` | Do not load the binding; use supported fallbacks and reject native-only operations. |
| `require` | Operations that need the binding raise `FsSafeError("helper-unavailable")` when it cannot load. |

Fallbacks include guarded JavaScript, the bundled TAR/gzip WASM parser, and the
[packaged Windows security helper](install.md#windows-security-fallback).
Windows command fallbacks remain subject to normal system execution policy.

## `getFsSafeNativeConfig()`

```ts
function getFsSafeNativeConfig(): FsSafeNativeConfig;
```

Return the effective configuration: programmatic overrides win, then env vars, then the package default (`auto`).
If only a removed Python-mode variable is configured, configuration reads and
native operations throw an actionable migration error instead of using the default.

## `getFsSafeNativeStatus(options?)`

```ts
function getFsSafeNativeStatus(options?: { probe?: boolean }): Promise<FsSafeNativeStatus>;

type FsSafeNativeStatusReason =
  | "not-probed" | "loaded" | "disabled" | "unsupported-target"
  | "package-missing" | "load-failed" | "capability-missing";

type FsSafeNativeStatus = {
  mode: FsSafeNativeMode;
  modeSource: "programmatic configuration" | "FS_SAFE_NATIVE_MODE" | "OPENCLAW_FS_SAFE_NATIVE_MODE" | "default";
  reason: FsSafeNativeStatusReason;
  loaded: boolean;
  target: string;
  packageName?: string;
  packageVersion?: string;
  loadErrorCode?: string;
  guidance?: string;
};
```

| Field | Meaning |
|---|---|
| `mode` | Effective `auto`, `off`, or `require` policy. |
| `modeSource` | The winning programmatic setting, environment variable **name**, or default. |
| `reason` | Cached loader outcome; `not-probed` until a load is attempted, unless the effective mode is `off` (`disabled`). |
| `loaded` | `true` exactly when `reason` is `loaded`. This confirms the loader's core capability check, not every operation's capabilities or kernel-atomic behavior. |
| `target` | Runtime platform/architecture/libc, such as `win32-x64-msvc` or `linux-x64-gnu`; also supplied for unsupported targets. |
| `packageName` | Expected native platform package; absent for unsupported targets. |
| `packageVersion` | Exact pinned version from fs-safe's manifest, when a platform package exists. |
| `loadErrorCode` | Present only for `load-failed`: an allowlisted loader code, or `UNKNOWN`. |
| `guidance` | Cause-specific next steps, shared with fallback warnings; absent for `not-probed` and `loaded`. |

The function returns a promise and loads its status module on the first call,
keeping the `config` import lightweight. The default, `{ probe: false }`, reads
the cached outcome without loading the addon. `{ probe: true }` attempts the same
lazy load as a native operation, unless
the mode is `off`. It never changes the configured mode or performs filesystem
mutations. Failed loads are reported even in `require` mode, without throwing.
`package-missing` identifies an unresolved platform package; a missing dependency
inside an installed package is `load-failed`. `capability-missing` means the
loader's core required capability is absent. Individual operations can still
lack capabilities when this API reports `loaded`.

For a doctor or startup health check:

```ts
import { getFsSafeNativeStatus } from "@openclaw/fs-safe/config";

const native = await getFsSafeNativeStatus({ probe: true });
if (native.loaded) {
  console.log(`Native filesystem support loaded for ${native.target}`);
} else {
  console.log(`Native filesystem support: ${native.reason}`);
  if (native.guidance) console.log(native.guidance);
}
```

Status is per module instance. A real Worker has its own configuration, loader
cache, and status; checking the main thread does not probe its Workers. Restart
the process or Worker after repairing an installation: successes and failures
are cached, and neither repeated probes nor mode changes retry a failed load.
No field contains filesystem paths, raw native error messages, or environment
variable values. See [fallback troubleshooting](native-helper.md#troubleshooting-fallback-warnings)
for the individual causes and next steps.

## `configureFsSafeLocks(config)`

```ts
function configureFsSafeLocks(config: Partial<FsSafeLockConfig>): void;

type FsSafeLockConfig = {
  staleRecovery: "fail-closed" | "remove-if-unchanged";
  staleMs?: number;
  timeoutMs?: number;
  retry?: FileLockRetryOptions;
};
```

Set process-wide defaults for sidecar lock options. This does **not** turn locking on globally; callers still need to pass `lock: true` or a lock options object for the specific JSON store/resource that needs cross-process coordination.

`staleRecovery` defaults to `"fail-closed"`. The opt-in `"remove-if-unchanged"` mode requires caller approval and serializes the final snapshot check and unlink with an exclusive `.reclaim` guard. A reclaim guard left by a killed reclaimer fails closed and requires externally coordinated cleanup.
`staleMs` must be non-negative and not `NaN`; `Infinity` disables age-based staleness.

For a daemon that should wait briefly for normal contention but never delete a
stale owner without per-lock approval:

```ts
configureFsSafeLocks({
  staleRecovery: "fail-closed",
  staleMs: 2 * 60_000,
  timeoutMs: 15_000,
  retry: { retries: 30, minTimeout: 50, maxTimeout: 1_000, randomize: true },
});
```

These defaults apply to both `acquireFileLock()` / `withFileLock()` and
`acquireFileLockSync()` / `withFileLockSync()`. Each acquisition resolves
`retry`, `staleMs`, `staleRecovery`, and `timeoutMs` from the per-call option
first, then the process configuration, then the package default. Explicit zero
values are preserved. A per-call `retry` object replaces the configured object
as a whole; omitted retry fields use package defaults, not configured fields.

Individual lock calls can override any default. Switching the global stale
recovery mode does not provide the application-owned liveness proof required
by `shouldRemoveStaleLock`.

## `getFsSafeLockConfig()`

```ts
function getFsSafeLockConfig(): FsSafeLockConfig;
```

Return the current sidecar lock defaults.

## Environment variables

The same policy can be set without code:

```bash
FS_SAFE_NATIVE_MODE=auto      # auto | off | require | true | false | on | 1 | 0 | never | required
```

`OPENCLAW_FS_SAFE_NATIVE_MODE` is accepted as an alias. Programmatic overrides via `configureFsSafeNative` always win.

### Removed Python-helper configuration

The deprecated Python configuration bridge and its environment variables have
been removed. Replace `FS_SAFE_PYTHON_MODE` with `FS_SAFE_NATIVE_MODE` and
`OPENCLAW_FS_SAFE_PYTHON_MODE` with `OPENCLAW_FS_SAFE_NATIVE_MODE`, preserving the
value. Without a valid native override, either legacy mode variable raises a
migration error. Explicit native settings still win over leftover legacy settings.
Use `configureFsSafeNative()` for a programmatic override. See the
[0.5 migration checklist](migrating-to-0.5.md#2-replace-python-helper-configuration)
for the migration path.

## Related pages

- [Native helper policy](native-helper.md) — when to pick `auto`, `off`, or `require`, and what each mode protects.
- [File lock](sidecar-lock.md) — the per-resource lock API that consumes lock defaults.
- [Root API](root.md) — the API whose POSIX hardening the helper backs.
- [Errors](errors.md) — `helper-unavailable` and `helper-failed`.
- [Migrating to 0.5](migrating-to-0.5.md) — ordered consumer upgrade checklist.
