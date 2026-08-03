import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import {
  assertSyncDirectoryGuard,
  ensureParentSync,
  ensureStoreDirectorySync,
  type SyncParentGuard,
} from "./file-store-boundary.js";
import { isPathInside } from "./path.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

function ensurePrivateDirectorySync(rootDir: string, targetDir: string, mode: number): SyncParentGuard {
  return ensureStoreDirectorySync({
    rootDir,
    targetDir,
    mode,
    messagePrefix: "private store",
  });
}

export function writeFileSyncAtomic(params: {
  rootDir: string;
  filePath: string;
  content: string | Uint8Array;
  privateMode: boolean;
  dirMode: number;
  mode: number;
}): string {
  const filePath = path.resolve(params.filePath);
  if (!isPathInside(params.rootDir, filePath)) {
    throw new FsSafeError("outside-workspace", "file path escapes store root");
  }
  let parentGuard: SyncParentGuard | undefined;
  if (params.privateMode) {
    parentGuard = ensurePrivateDirectorySync(params.rootDir, path.dirname(filePath), params.dirMode);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new FsSafeError("not-file", `private store target must be a regular file: ${filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  } else {
    parentGuard = ensureParentSync({
      rootDir: params.rootDir,
      filePath,
      mode: params.dirMode,
    });
  }
  const tempPath = path.join(
    parentGuard?.dir ?? path.dirname(filePath),
    `.fs-safe-${process.pid}-${randomUUID()}.tmp`,
  );
  let tempExists = false;
  try {
    getFsSafeTestHooks()?.beforeFileStoreSyncPrivateWrite?.(filePath);
    if (parentGuard) {
      assertSyncDirectoryGuard(parentGuard);
    }
    fs.writeFileSync(tempPath, params.content, { flag: "wx", mode: params.mode });
    tempExists = true;
    try {
      fs.chmodSync(tempPath, params.mode);
    } catch {
      // Best-effort on platforms that do not enforce POSIX modes.
    }
    const tempStat = fs.lstatSync(tempPath);
    if (parentGuard) {
      assertSyncDirectoryGuard(parentGuard);
    }
    fs.renameSync(tempPath, filePath);
    tempExists = false;
    if (parentGuard) {
      assertSyncDirectoryGuard(parentGuard);
    }
    try {
      const publishedStat = fs.lstatSync(filePath);
      if (
        publishedStat.isSymbolicLink() ||
        !publishedStat.isFile() ||
        publishedStat.nlink > 1 ||
        !sameFileIdentity(tempStat, publishedStat)
      ) {
        throw new FsSafeError("path-mismatch", "store target changed after write");
      }
    } catch (error) {
      if (error instanceof FsSafeError) {
        throw error;
      }
      throw new FsSafeError("path-mismatch", "store target changed after write", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    return filePath;
  } finally {
    if (tempExists) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup after write failure.
      }
    }
  }
}
