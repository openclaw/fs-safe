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
  getFsSafeLockConfig,
  type FsSafeLockConfig,
  type FsSafeNativeConfig,
  type FsSafeNativeMode,
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
| `auto` | Default. Prefer the platform binding and use guarded JavaScript when it is unavailable. |
| `off` | Do not load the binding; use guarded JavaScript deterministically. |
| `require` | Operations that need the binding raise `FsSafeError("helper-unavailable")` when it cannot load. |

## `getFsSafeNativeConfig()`

```ts
function getFsSafeNativeConfig(): FsSafeNativeConfig;
```

Return the effective configuration: programmatic overrides win, then env vars, then the package default (`auto`).

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

### Python-helper migration bridge

Version 0.5 detects the former `FS_SAFE_PYTHON_MODE`, `FS_SAFE_PYTHON`,
`OPENCLAW_FS_SAFE_PYTHON_MODE`, `OPENCLAW_FS_SAFE_PYTHON`,
`OPENCLAW_PINNED_PYTHON`, and `OPENCLAW_PINNED_WRITE_PYTHON` names. It emits one
`FS_SAFE_PYTHON_DEPRECATED` warning and maps `auto`, `off`, or `require` to the
same native mode; interpreter paths are ignored. The deprecated
`configureFsSafePython()` export behaves the same way.

Replace these inputs with `configureFsSafeNative()` or
`FS_SAFE_NATIVE_MODE` during the 0.5 upgrade. The bridge exists only so shipped
0.4 configuration fails loudly and maps predictably; it is not a supported
Python execution path. Follow the [0.5 migration checklist](migrating-to-0.5.md)
for the full upgrade.

## Related pages

- [Native helper policy](native-helper.md) — when to pick `auto`, `off`, or `require`, and what each mode protects.
- [File lock](sidecar-lock.md) — the per-resource lock API that consumes lock defaults.
- [Root API](root.md) — the API whose POSIX hardening the helper backs.
- [Errors](errors.md) — `helper-unavailable` and `helper-failed`.
- [Migrating to 0.5](migrating-to-0.5.md) — ordered consumer upgrade checklist.
