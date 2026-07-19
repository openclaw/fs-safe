---
title: Config
description: "Process-global defaults for optional fs-safe helpers."
---

# `@openclaw/fs-safe/config`

Process-global configuration knobs for optional fs-safe helpers. The Python helper policy is described in the [Python helper policy](python-helper.md); this page is the API reference.

```ts
import {
  configureFsSafePython,
  configureFsSafeLocks,
  getFsSafePythonConfig,
  getFsSafeLockConfig,
  type FsSafeLockConfig,
  type FsSafePythonConfig,
  type FsSafePythonMode,
} from "@openclaw/fs-safe/config";
```

These functions are also re-exported from the main entry point. Prefer the subpath when you only need helper configuration and want the smallest import surface.

## `configureFsSafePython(config)`

```ts
function configureFsSafePython(config: Partial<FsSafePythonConfig>): void;

type FsSafePythonConfig = {
  mode: FsSafePythonMode;
  pythonPath?: string;
};

type FsSafePythonMode = "auto" | "off" | "require";
```

Set the process-global policy. Calls merge into the existing override config, so passing `{ pythonPath: "/usr/bin/python3" }` keeps any previously set `mode`. Configure once at startup, before the first `root()` call — switching modes mid-process is supported but the helper may already be running.

| Mode | Behavior |
|---|---|
| `auto` | Default. Use the helper when it starts; fall back to Node-only behavior if Python is missing or fails to start. |
| `off` | Never spawn the helper. Read/write/move use Node fallbacks plus pre/post identity checks. |
| `require` | Fail closed if the helper cannot start. Operations that need the helper raise `FsSafeError("helper-unavailable")`. |

## `getFsSafePythonConfig()`

```ts
function getFsSafePythonConfig(): FsSafePythonConfig;
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

## `getFsSafeLockConfig()`

```ts
function getFsSafeLockConfig(): FsSafeLockConfig;
```

Return the current sidecar lock defaults.

## Environment variables

The same policy can be set without code:

```bash
FS_SAFE_PYTHON_MODE=auto      # auto | off | require | true | false | on | off | 1 | 0 | never | required
FS_SAFE_PYTHON=/usr/bin/python3
```

OpenClaw compatibility aliases are accepted: `OPENCLAW_FS_SAFE_PYTHON_MODE`, `OPENCLAW_FS_SAFE_PYTHON`, `OPENCLAW_PINNED_PYTHON`, and `OPENCLAW_PINNED_WRITE_PYTHON`. Programmatic overrides via `configureFsSafePython` always win.

## Related pages

- [Python helper policy](python-helper.md) — when to pick `auto`, `off`, or `require`, and what each mode protects.
- [File lock](sidecar-lock.md) — the per-resource lock API that consumes lock defaults.
- [Root API](root.md) — the API whose POSIX hardening the helper backs.
- [Errors](errors.md) — `helper-unavailable` and `helper-failed`.
