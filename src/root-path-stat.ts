import type { BigIntStats } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import {
  assertRootDirectoryObservationGuard,
  createRootDirectoryObservationGuard,
  pathStatFromStats,
} from "./root-directory-list.js";
import type { RootContext } from "./root-context.js";
import { fileNotFoundError } from "./root-errors.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import type { PathStat } from "./types.js";

export async function statResolvedPathInRoot(
  root: RootContext,
  resolvedPath: string,
): Promise<PathStat> {
  let admittedTarget = false;
  try {
    const guardPath = resolvedPath === root.rootReal ? root.rootReal : path.dirname(resolvedPath);
    const parentGuard = guardPath === root.rootReal && root.rootGuard
      ? root.rootGuard
      : await createRootDirectoryObservationGuard(root, guardPath);
    let expected: BigIntStats;
    try {
      await getFsSafeTestHooks()?.beforeRootStatInitialObservation?.(resolvedPath);
      expected = inspectFileIdentitySync(() => fsSync.lstatSync(resolvedPath, { bigint: true }));
      if (expected.isSymbolicLink()) {
        throw new FsSafeError("path-mismatch", "file changed during operation");
      }
    } catch (error) {
      // No initial target error is safe to expose until the admitted parent is
      // proven current; a redirect must win over an ordinary lookup failure.
      await assertRootDirectoryObservationGuard(root, parentGuard);
      throw error;
    }
    admittedTarget = true;
    await getFsSafeTestHooks()?.beforeRootStatObservation?.(resolvedPath);
    let observed: BigIntStats;
    try {
      observed = inspectFileIdentitySync(
        () => fsSync.lstatSync(resolvedPath, { bigint: true }),
        expected,
      );
    } catch (error) {
      if (isNotFoundPathError(error)) {
        throw new FsSafeError("path-mismatch", "file changed during operation", {
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw error;
    }
    if (observed.isSymbolicLink()) {
      throw new FsSafeError("path-mismatch", "file changed during operation");
    }
    await assertRootDirectoryObservationGuard(root, parentGuard);
    return pathStatFromStats(observed);
  } catch (error) {
    if (!admittedTarget && isNotFoundPathError(error)) {
      throw fileNotFoundError(error instanceof Error ? error : undefined);
    }
    throw error;
  }
}
