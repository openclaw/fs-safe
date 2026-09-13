import { randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { syncDirectorySync } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import {
  assertSyncDirectoryGuard,
  ensureParentSync,
  ensureStoreDirectorySync,
  type SyncParentGuard,
} from "./file-store-boundary.js";
import { isPathInside } from "./path.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { writeTempFileSync } from "./replace-file-descriptor.js";
import { SyncAtomicTempOwner } from "./replace-file-temp-owner.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

function ensurePrivateDirectorySync(rootDir: string, targetDir: string, mode: number): SyncParentGuard {
  return ensureStoreDirectorySync({
    rootDir,
    targetDir,
    mode,
    messagePrefix: "private store",
  });
}

function verifyStoreFile(fd: number, expected: BigIntStats, filePath: string): void {
  const assertFile = (stat: BigIntStats, allowUnknown = false): boolean => {
    const unknown = allowUnknown && process.platform === "win32" && (stat.dev === 0n || stat.ino === 0n);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
      (stat.dev !== expected.dev && !(unknown && stat.dev === 0n)) ||
      (stat.ino !== expected.ino && !(unknown && stat.ino === 0n))) {
      throw new FsSafeError("path-mismatch", "store file changed during write");
    }
    return unknown;
  };
  const assertDescriptor = (descriptor: number) => {
    assertFile(inspectFileIdentitySync(() => fs.fstatSync(descriptor, { bigint: true }), expected));
  };
  assertDescriptor(fd);
  if (assertFile(fs.lstatSync(filePath, { bigint: true }), true)) {
    // A Windows pathname can have opaque metadata even while the retained writer is known.
    // Reopen for identity only; equal content cannot establish that publication kept its file.
    const reopened = fs.openSync(filePath, resolveReadOpenFlags());
    try {
      assertDescriptor(reopened);
      assertFile(fs.lstatSync(filePath, { bigint: true }), true);
      assertDescriptor(reopened);
    } finally {
      fs.closeSync(reopened);
    }
  }
  assertDescriptor(fd);
}

export function writeFileSyncAtomic(params: {
  rootDir: string;
  filePath: string;
  content: string | Uint8Array;
  privateMode: boolean;
  durable: boolean;
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
  const owner = new SyncAtomicTempOwner(tempPath);
  let originalError: unknown;
  try {
    getFsSafeTestHooks()?.beforeFileStoreSyncPrivateWrite?.(filePath);
    if (parentGuard) {
      assertSyncDirectoryGuard(parentGuard);
    }
    owner.start();
    const temp = writeTempFileSync({
      fsModule: fs, tempPath, content: params.content, mode: params.mode, sync: false,
      onIdentity: owner.onIdentity,
      fchmodSync: (descriptor, mode) => {
        try {
          fs.fchmodSync(descriptor, mode);
        } catch {
          // Best-effort on platforms that do not enforce POSIX modes.
        }
      },
    });
    owner.adopt(temp);
    // Preserve the store's strict fsync errors; the generic temp helper tolerates EPERM.
    if (params.durable) fs.fsyncSync(temp.fd);
    verifyStoreFile(temp.fd, owner.identity, tempPath);
    if (parentGuard) {
      assertSyncDirectoryGuard(parentGuard);
    }
    fs.renameSync(tempPath, filePath);
    owner.markRenamed();
    if (parentGuard) {
      assertSyncDirectoryGuard(parentGuard);
    }
    try {
      verifyStoreFile(temp.fd, owner.identity, filePath);
    } catch (error) {
      if (error instanceof FsSafeError) {
        throw error;
      }
      throw new FsSafeError("path-mismatch", "store target changed after write", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (parentGuard) {
      assertSyncDirectoryGuard(parentGuard);
      if (params.durable) {
        syncDirectorySync({
          path: parentGuard.dir,
          realPath: parentGuard.realPath,
          identity: parentGuard.stat,
        }, { label: "store parent" });
      }
      assertSyncDirectoryGuard(parentGuard);
    }
    return filePath;
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    owner.finish({ fsModule: fs, originalError, throwOnCleanupError: false });
  }
}
