import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isPathRelativeEscape } from "./path.js";
import { directoryComponentNotDirectoryError } from "./root-errors.js";
import { realpathSync } from "./realpath.js";

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const parentPrefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return candidate === parent || candidate.startsWith(parentPrefix);
}

async function realpathOrThrowNotFile(target: string): Promise<string> {
  try {
    return path.resolve(realpathSync.native(target));
  } catch (error) {
    if (isNotFoundPathError(error)) {
      // A dangling symlink (or a component removed between lstat and
      // realpath) is not a usable directory component.
      throw directoryComponentNotDirectoryError(error instanceof Error ? error : undefined);
    }
    throw error;
  }
}

/**
 * Creates each missing path component from `rootReal` down to `targetPath`,
 * guarding every step. Returns the real (symlink-resolved) path of the final
 * component so callers can guard/use that path directly instead of
 * re-deriving it from the original, possibly-symlinked, lexical path.
 */
export async function mkdirPathComponentsWithGuards(params: {
  rootReal: string;
  targetPath: string;
  beforeComponent?: (componentPath: string) => Promise<void> | void;
  beforeCreateComponent?: (
    componentPath: string,
    prospectiveTargetPath: string,
  ) => Promise<void> | void;
  beforeUseComponent?: (
    componentPath: string,
    prospectiveTargetPath: string,
  ) => Promise<void> | void;
  assertBeforeMutation?: () => void;
  mode?: number;
  rejectSymlinks?: boolean;
  revalidateParentAfterBeforeComponent?: boolean;
}): Promise<string> {
  const root = path.resolve(params.rootReal);
  const rootCanonical = path.resolve(realpathSync.native(root));
  const target = path.resolve(params.targetPath);
  const relative = path.relative(root, target);
  if (isPathRelativeEscape(relative)) {
    throw new FsSafeError("outside-workspace", "directory is outside workspace root");
  }
  let current = root;
  const parts = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const next = path.join(current, part);
    const parentGuard = await createAsyncDirectoryGuard(current);
    await assertAsyncDirectoryGuard(parentGuard);
    await params.beforeComponent?.(next);
    if (params.revalidateParentAfterBeforeComponent) {
      await assertAsyncDirectoryGuard(parentGuard);
    }
    if (params.beforeCreateComponent) {
      let missing = false;
      try {
        fsSync.lstatSync(next);
      } catch (error) {
        if (!isNotFoundPathError(error)) throw error;
        missing = true;
      }
      if (missing) {
        await params.beforeCreateComponent(
          next,
          path.join(next, ...parts.slice(index + 1)),
        );
        await assertAsyncDirectoryGuard(parentGuard);
        params.assertBeforeMutation?.();
        try {
          await fs.mkdir(next, { mode: params.mode });
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
            throw error;
          }
        }
      }
    } else {
      params.assertBeforeMutation?.();
      try {
        await fs.mkdir(next, { mode: params.mode });
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    }
    const stat = fsSync.lstatSync(next);
    await params.beforeUseComponent?.(
      next,
      path.join(next, ...parts.slice(index + 1)),
    );
    if (params.beforeUseComponent) {
      await assertAsyncDirectoryGuard(parentGuard);
    }
    if ((params.rejectSymlinks && stat.isSymbolicLink()) || (!stat.isSymbolicLink() && !stat.isDirectory())) {
      throw directoryComponentNotDirectoryError();
    }
    // Node's recursive mkdir follows symlinks in missing components. Build one
    // segment at a time and realpath-check each segment before descending.
    const nextReal = await realpathOrThrowNotFile(next);
    if (!isSameOrChildPath(nextReal, rootCanonical)) {
      throw new FsSafeError("outside-workspace", "directory escaped workspace root");
    }
    if (stat.isSymbolicLink()) {
      // An existing path component may legitimately be a symlink to a real
      // directory inside the root (e.g. a skill-bank layout). We already
      // verified above that it resolves inside the root, so treat the
      // resolved real path as the directory for the rest of this walk
      // instead of rejecting it outright. Guard checks from here on operate
      // on the real (non-symlink) path, preserving TOCTOU protection for
      // every subsequent segment. Callers that need the final directory
      // (e.g. to guard it themselves after this function returns) must use
      // the returned resolved path, not their own lexical parent path.
      const targetStat = fsSync.statSync(nextReal);
      if (!targetStat.isDirectory()) {
        throw directoryComponentNotDirectoryError();
      }
      await createAsyncDirectoryGuard(nextReal);
      await assertAsyncDirectoryGuard(parentGuard);
      current = nextReal;
      continue;
    }
    await createAsyncDirectoryGuard(next);
    await assertAsyncDirectoryGuard(parentGuard);
    current = next;
  }
  return current;
}
