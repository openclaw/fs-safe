import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  assertSyncDirectoryGuard,
  createAsyncDirectoryGuard,
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
  onSourceInspected?: (identity: Pick<BigIntStats, "dev" | "ino">) => void;
  onRenamed?: () => void;
  from: string;
  to: string;
}): Promise<void> {
  const sourceGuard = await createAsyncDirectoryGuard(path.dirname(params.from));
  const targetGuard = await createAsyncDirectoryGuard(path.dirname(params.to));
  await withAsyncDirectoryGuards(
    [sourceGuard, targetGuard],
    async () => {
      if (params.onSourceInspected) {
        params.onSourceInspected(fsSync.lstatSync(params.from, { bigint: true }));
      }
      // Authority must survive all awaited guards; do not yield before rename dispatch.
      params.assertBeforeRename?.();
      await fs.rename(params.from, params.to);
      params.onRenamed?.();
    },
  );
}

export function guardedRenameSync(params: {
  from: string;
  to: string;
}): void {
  const sourceGuard = createSyncDirectoryGuard(path.dirname(params.from));
  const targetGuard = createSyncDirectoryGuard(path.dirname(params.to));
  withSyncDirectoryGuards(
    [sourceGuard, targetGuard],
    () => fsSync.renameSync(params.from, params.to),
  );
}

export async function guardedRm(params: {
  target: string;
  assertBeforeMutation?: () => void;
  recursive?: boolean;
}): Promise<void> {
  const guard = await createAsyncDirectoryGuard(path.dirname(params.target));
  await withAsyncDirectoryGuards(
    [guard],
    async () => {
      params.assertBeforeMutation?.();
      await fs.rm(params.target, {
        ...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
      });
    },
  );
}

export function guardedRmSync(params: {
  target: string;
  assertBeforeMutation?: () => void;
  recursive?: boolean;
  force?: boolean;
  verifyAfter?: boolean;
}): void {
  const guard = createSyncDirectoryGuard(path.dirname(params.target));
  withSyncDirectoryGuards(
    [guard],
    () => {
      params.assertBeforeMutation?.();
      fsSync.rmSync(params.target, {
        ...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
        ...(params.force !== undefined ? { force: params.force } : {}),
      });
    },
    { verifyAfter: params.verifyAfter },
  );
}
