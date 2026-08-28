import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { runPinnedWriteWindows } from "./native-pinned-write-windows.js";
import { assertNativeStaging, createNativeStage } from "./native-staged-file.js";
import type { NativeBinding } from "./native.js";
import type { PinnedWriteParams } from "./pinned-write.js";
import { describeStagedDirectory, exactIdentityMatches } from "./staged-directory.js";

export async function runPinnedWriteNative(binding: NativeBinding, params: PinnedWriteParams): Promise<FileIdentityStat> {
  // Windows retains its handle/reparse and publication-mode behavior. Only the
  // POSIX writer has the direct-child retained cleanup mechanism.
  if (process.platform === "win32") {
    return await runPinnedWriteWindows(binding, params);
  }
  assertNativeStaging(binding);
  const root = await fs.open(params.rootPath, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY);
  let parentFd: number | undefined;
  let primaryError: unknown;
  try {
    const rootIdentity = fsSync.fstatSync(root.fd, { bigint: true });
    if (params.rootIdentity && !exactIdentityMatches(params.rootIdentity, rootIdentity)) {
      throw new FsSafeError("path-mismatch", "root path changed during native write");
    }
    if (params.mkdir) {
      binding.mkdirBeneath(root.fd, params.relativeParentPath, 0o777);
    }
    parentFd = binding.openBeneath(
      root.fd,
      params.relativeParentPath,
      fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY,
    ).fd;
    const parentPath = await fs.realpath(
      params.relativeParentPath
        ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
        : params.rootPath,
    );
    const directory = describeStagedDirectory(parentFd, parentPath);
    if (params.overwrite === false) {
      try {
        await fs.lstat(path.join(parentPath, params.basename));
        throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    const ownedParent = parentFd;
    parentFd = undefined;
    const staged = await createNativeStage(
      binding, ownedParent, directory, params.input, params.mode, params.maxBytes, false,
    );
    try {
      const published = await staged.publish(params.basename, { overwrite: params.overwrite !== false });
      return { dev: published.staged.identity.dev, ino: published.staged.identity.ino };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await staged[Symbol.asyncDispose]();
      } catch (cleanupError) {
        if (primaryError) {
          throw new AggregateError([primaryError, cleanupError], "native write and cleanup failed");
        }
        throw cleanupError;
      }
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const closeErrors: unknown[] = [];
    if (parentFd !== undefined) {
      try {
        fsSync.closeSync(parentFd);
      } catch (error) {
        closeErrors.push(error);
      }
    }
    try {
      await root.close();
    } catch (error) {
      closeErrors.push(error);
    }
    if (closeErrors.length) {
      throw new AggregateError(
        primaryError ? [primaryError, ...closeErrors] : closeErrors,
        "native write close failed",
      );
    }
  }
}
