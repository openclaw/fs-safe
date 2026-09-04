import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  assertSyncDirectoryGuard,
  createAsyncDirectoryGuard,
  createNearestExistingDirectoryGuard,
  createNearestExistingSyncDirectoryGuard,
  createSyncDirectoryGuard,
  type AnyAsyncDirectoryGuard,
  type SyncDirectoryGuard,
} from "./directory-guard.js";

export async function withAsyncDirectoryGuards<T>(
  guards: readonly AnyAsyncDirectoryGuard[],
  mutate: () => Promise<T>,
  options: {
    verifyAfter?: boolean;
    onPostGuardFailure?: (result: T, error: unknown) => Promise<void> | void;
  } = {},
): Promise<T> {
  for (const guard of guards) {
    await assertAsyncDirectoryGuard(guard);
  }
  const result = await mutate();
  if (options.verifyAfter !== false) {
    try {
      for (const guard of guards) {
        await assertAsyncDirectoryGuard(guard);
      }
    } catch (error) {
      if (options.onPostGuardFailure) {
        try {
          // The mutation may have returned an owned resource before the post-guard
          // check detected a swapped directory. Give callers one chance to close
          // handles without letting cleanup hide the boundary failure.
          await options.onPostGuardFailure(result, error);
        } catch {
          // Preserve the boundary failure. Cleanup is best-effort.
        }
      }
      throw error;
    }
  }
  return result;
}

export function withSyncDirectoryGuards<T>(
  guards: readonly SyncDirectoryGuard[],
  mutate: () => T,
  options: { verifyAfter?: boolean } = {},
): T {
  for (const guard of guards) {
    assertSyncDirectoryGuard(guard);
  }
  const result = mutate();
  if (options.verifyAfter !== false) {
    for (const guard of guards) {
      assertSyncDirectoryGuard(guard);
    }
  }
  return result;
}

export async function guardedRename(params: {
  assertBeforeRename?: () => void;
  from: string;
  to: string;
  targetRoot?: string;
  verifyAfter?: boolean;
}): Promise<void> {
  const sourceGuard = await createAsyncDirectoryGuard(path.dirname(params.from));
  const targetGuard = params.targetRoot
    ? await createNearestExistingDirectoryGuard(params.targetRoot, path.dirname(params.to))
    : await createAsyncDirectoryGuard(path.dirname(params.to));
  await withAsyncDirectoryGuards(
    [sourceGuard, targetGuard],
    async () => {
      // Authority must survive all awaited guards; do not yield before rename dispatch.
      params.assertBeforeRename?.();
      await fs.rename(params.from, params.to);
    },
    { verifyAfter: params.verifyAfter },
  );
}

export function guardedRenameSync(params: {
  from: string;
  to: string;
  targetRoot?: string;
  verifyAfter?: boolean;
}): void {
  const sourceGuard = createSyncDirectoryGuard(path.dirname(params.from));
  const targetGuard = params.targetRoot
    ? createNearestExistingSyncDirectoryGuard(params.targetRoot, path.dirname(params.to))
    : createSyncDirectoryGuard(path.dirname(params.to));
  withSyncDirectoryGuards(
    [sourceGuard, targetGuard],
    () => fsSync.renameSync(params.from, params.to),
    { verifyAfter: params.verifyAfter },
  );
}

export async function guardedRm(params: {
  target: string;
  recursive?: boolean;
  force?: boolean;
  verifyAfter?: boolean;
}): Promise<void> {
  const guard = await createAsyncDirectoryGuard(path.dirname(params.target));
  await withAsyncDirectoryGuards(
    [guard],
    async () => {
      await fs.rm(params.target, {
        ...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
        ...(params.force !== undefined ? { force: params.force } : {}),
      });
    },
    { verifyAfter: params.verifyAfter },
  );
}

export function guardedRmSync(params: {
  target: string;
  recursive?: boolean;
  force?: boolean;
  verifyAfter?: boolean;
}): void {
  const guard = createSyncDirectoryGuard(path.dirname(params.target));
  withSyncDirectoryGuards(
    [guard],
    () =>
      fsSync.rmSync(params.target, {
        ...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
        ...(params.force !== undefined ? { force: params.force } : {}),
      }),
    { verifyAfter: params.verifyAfter },
  );
}
