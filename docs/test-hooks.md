---
title: Test hooks
description: "Internal-only injection hooks used by the fs-safe test suite. Active only when NODE_ENV=test or VITEST=true."
---

# `@openclaw/fs-safe/test-hooks`

Internal injection points the `fs-safe` test suite uses to deterministically reproduce open/lstat races. They are exposed as a public subpath so downstream test suites can reuse the same harness, but they are **not** part of the supported runtime API.

```ts
import {
  getFsSafeTestHooks,
  __setFsSafeTestHooksForTest,
  type FsSafeTestHooks,
} from "@openclaw/fs-safe/test-hooks";
```

## When the hooks are active

Hooks are only honored when one of the following is true:

- `process.env.NODE_ENV === "test"`
- `process.env.VITEST === "true"`

Calling `__setFsSafeTestHooksForTest(hooks)` outside of those environments throws. `getFsSafeTestHooks()` returns `undefined` when no hooks are registered, regardless of the environment.

## Shape

```ts
type FsSafeTestHooks = {
  afterPreOpenLstat?: (filePath: string) => Promise<void> | void;
  beforeOpen?: (filePath: string, flags: number) => Promise<void> | void;
  afterOpen?: (filePath: string, handle: FileHandle) => Promise<void> | void;
  beforeArchiveOutputMutation?: (operation: "mkdir" | "chmod", targetPath: string) => Promise<void> | void;
  beforeFileStorePruneDescend?: (dirPath: string) => Promise<void> | void;
  beforeFileStoreSyncPrivateWrite?: (filePath: string) => void;
  beforeRootFallbackMutation?: (operation: "mkdir" | "move" | "remove", targetPath: string) => Promise<void> | void;
  afterPinnedWriteFallbackRename?: (targetPath: string) => Promise<void> | void;
  beforeSiblingTempWrite?: (tempPath: string) => Promise<void> | void;
  beforeSidecarLockSnapshotOpen?: (lockPath: string) => Promise<void> | void;
  beforeTrashMove?: (targetPath: string, destPath: string) => void;
  afterPublishTargetCreated?: (method, targetPath, identity) => Promise<void> | void;
  beforePublishDirectorySync?: (method, targetPath, identity) => Promise<void> | void;
};
```

| Hook | Fires when |
|---|---|
| `afterPreOpenLstat` | A pre-open `lstat` has just resolved. Use this to swap a path between validation and open. |
| `beforeOpen` | The library is about to call `open(path, flags)`. Use this to inject a TOCTOU window. |
| `afterOpen` | An open just succeeded. Use this to mutate state before the post-open identity check runs. |
| `beforeArchiveOutputMutation` | Archive staging is about to create a directory or apply a mode. |
| `beforeFileStorePruneDescend` | File-store pruning is about to descend into a directory. |
| `beforeFileStoreSyncPrivateWrite` | A synchronous private-store write is about to mutate its target. |
| `beforeRootFallbackMutation` | A guarded JS root fallback is about to mkdir, move, or remove. |
| `afterPinnedWriteFallbackRename` | A fallback rename committed and post-commit identity checks have not run yet. |
| `beforeSiblingTempWrite` | A sibling temp file exists and its writer is about to run. |
| `beforeSidecarLockSnapshotOpen` | A sidecar lock was inspected and is about to be opened for a bounded snapshot read. |
| `beforeTrashMove` | Trash handling is about to move the target. |
| `afterPublishTargetCreated` | Exclusive publication created its target and final fences have not run yet. |
| `beforePublishDirectorySync` | Publication verified the target and is about to sync its parent directory. |

Hooks typed `Promise<void> | void` may be sync or async and are awaited.
Hooks used by synchronous code paths are typed `void` and must not return a
promise.

## Usage

```ts
import { afterEach, beforeEach } from "vitest";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";

beforeEach(() => {
  __setFsSafeTestHooksForTest({
    beforeOpen: async (filePath) => {
      // swap a victim file with a symlink right before fs-safe opens it
      await replaceWithSymlink(filePath);
    },
  });
});

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});
```

Always clear the hooks in `afterEach` so a stuck hook does not leak across tests.

## Stability

The shape can grow new optional fields between minor versions. Treat the surface as test-only and do not rely on it from production code.

## Related pages

- [Testing](testing.md) — broader notes on testing against `fs-safe`.
- [Security model](security-model.md) — the races these hooks help reproduce.
