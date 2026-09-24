import type { BigIntStats, Stats } from "node:fs";
import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { recordFileOpenFailure, recordPreOpenFileChange } from "./opened-file-failure.js";
import {
  assertNoUnsafeDeviceReadPath,
  hasNodeErrorCode,
  isNotFoundPathError,
  isSymlinkOpenError,
} from "./path.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { fileNotFoundError, hardlinkedPathNotAllowedError } from "./root-errors.js";
import type { RootReadOptions } from "./root-options.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

const OPEN_READ_FLAGS = resolveReadOpenFlags();
const OPEN_READ_FOLLOW_FLAGS = resolveReadOpenFlags({ followSymlinks: true });

type OwnedLocalFile = {
  handle: FileHandle;
  stat: Stats;
  identity: BigIntStats;
  preOpenStat: BigIntStats | undefined;
};

// Ownership transfers only after descriptor verification. Each admission caller
// must close on rejection and construct an OpenResult only after admission.
export async function openLocalFileDescriptor(
  filePath: string,
  options?: Pick<RootReadOptions, "hardlinks" | "symlinks"> & { readWrite?: true },
): Promise<OwnedLocalFile> {
  assertNoUnsafeDeviceReadPath(filePath);
  const fsSafeTestHooks = getFsSafeTestHooks();
  let preOpenStat: BigIntStats | undefined;
  let observedBeforeOpen = false;
  // Reject directories before opening so we never surface EISDIR to callers (e.g. tool
  // results that get sent to messaging channels). See openclaw/openclaw#31186.
  try {
    preOpenStat = await inspectFileIdentity(() => {
      const stat = fsSync.lstatSync(filePath, { bigint: true });
      observedBeforeOpen = true;
      if (stat.isSymbolicLink() && options?.symlinks !== "follow-within-root") {
        throw new FsSafeError("symlink", "symlink not allowed");
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new FsSafeError("not-file", "not a file");
      }
      return stat;
    });
  } catch (err) {
    if (err instanceof FsSafeError || observedBeforeOpen) {
      throw err;
    }
    // Only an initial lookup failure falls through; a failed re-inspection aborts.
  }
  if (preOpenStat) {
    await fsSafeTestHooks?.afterPreOpenLstat?.(filePath);
  }

  const openFlags = (options?.symlinks === "follow-within-root"
    ? OPEN_READ_FOLLOW_FLAGS
    : OPEN_READ_FLAGS) | (options?.readWrite ? fsSync.constants.O_RDWR : 0);
  await fsSafeTestHooks?.beforeOpen?.(filePath, openFlags);
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, openFlags).catch((error: unknown) =>
      recordFileOpenFailure(isNotFoundPathError(error) ? fileNotFoundError() : error, filePath));
  } catch (err) {
    if (isSymlinkOpenError(err)) {
      throw new FsSafeError("symlink", "symlink open blocked", { cause: err });
    }
    // Defensive: if open still throws EISDIR (e.g. race), sanitize so it never leaks.
    if (hasNodeErrorCode(err, "EISDIR")) {
      throw new FsSafeError("not-file", "not a file");
    }
    throw err;
  }

  try {
    await fsSafeTestHooks?.afterOpen?.(filePath, handle);
    const stat = fsSync.fstatSync(handle.fd);
    if (!stat.isFile()) {
      throw new FsSafeError("not-file", "not a file");
    }
    // Keep numeric Stats for the public receipt, never for identity verification.
    let openedIdentity: BigIntStats | undefined;
    const identity = await inspectFileIdentity(
      () => (openedIdentity = fsSync.fstatSync(handle.fd, { bigint: true })),
      preOpenStat && !preOpenStat.isSymbolicLink() ? preOpenStat : undefined,
    ).catch(async (error: unknown) => {
      if ([0, 1].includes(stat.nlink)) {
        await recordPreOpenFileChange(error, handle, filePath, preOpenStat, openedIdentity);
      }
      throw error;
    });
    if (options?.hardlinks === "reject" && stat.nlink > 1) {
      throw hardlinkedPathNotAllowedError();
    }

    return { handle, stat, identity, preOpenStat };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}
