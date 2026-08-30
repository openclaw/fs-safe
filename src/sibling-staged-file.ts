import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";
import { serializePathWrite } from "./write-queue.js";

function assertRegularFile(stat: BigIntStats): void {
  if (stat.isSymbolicLink()) {
    throw new FsSafeError("symlink", "symlink sibling temp not allowed");
  }
  if (!stat.isFile()) {
    throw new FsSafeError("not-file", "sibling temp must be a regular file");
  }
  if (stat.nlink !== 1n) {
    throw new FsSafeError("hardlink", "sibling temp must have exactly one link");
  }
}

async function inspectStage(inspect: () => Promise<BigIntStats>, expected?: BigIntStats) {
  return await inspectFileIdentity(async () => {
    const stat = await inspect();
    assertRegularFile(stat);
    return stat;
  }, expected);
}

// Callback paths are not owned until all three admission observations agree.
// Keep one descriptor and one exact identity through mode, sync, rename and cleanup.
// Read/write access is needed only when the caller requests file synchronization.
export async function writeCallbackSibling<T>(params: {
  tempPath: string;
  write: (tempPath: string) => Promise<T>;
  resolveFinalPath: (result: T) => string;
  mode?: number;
  /** Preserve the caller's historical best-effort mode behavior. */
  ignoreModeError?: boolean;
  maxBytes?: number;
  syncTempFile: boolean;
  syncParentDir: boolean;
}): Promise<{ filePath: string; result: T }> {
  const parent = path.dirname(params.tempPath);
  const guard = await createAsyncDirectoryGuard(parent);
  const parentIdentity = await inspectFileIdentity(() => fs.lstat(parent, { bigint: true }));
  const assertParent = async () => {
    await assertAsyncDirectoryGuard(guard);
    await inspectFileIdentity(() => fs.lstat(parent, { bigint: true }), parentIdentity);
  };
  let handle: FileHandle | undefined;
  let identity: BigIntStats | undefined;
  let unregister: TempPathRegistration | undefined;
  let renamed = false;
  let failure: { error: unknown } | undefined;
  const inspectPath = (pathname: string, expected?: BigIntStats) =>
    inspectStage(() => fs.lstat(pathname, { bigint: true }), expected);
  const assertCurrent = async (pathname: string) => {
    await assertParent();
    const opened = await inspectStage(() => handle!.stat({ bigint: true }), identity);
    const current = await inspectPath(pathname, opened);
    if (
      params.maxBytes !== undefined &&
      (opened.size > params.maxBytes || current.size > params.maxBytes)
    ) {
      throw new FsSafeError("too-large", `sibling temp exceeds maxBytes (${params.maxBytes})`);
    }
  };

  try {
    const result = await params.write(params.tempPath);
    await assertParent();
    const before = await inspectPath(params.tempPath);
    try {
      // No create/truncate flags; O_NONBLOCK also bounds a FIFO swap during open.
      const access = params.syncTempFile ? fsSync.constants.O_RDWR : fsSync.constants.O_RDONLY;
      handle = await fs.open(params.tempPath, access | resolveReadOpenFlags());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
        throw new FsSafeError("symlink", "symlink sibling temp not allowed", { cause: error });
      }
      throw error;
    }
    const opened = await inspectStage(() => handle!.stat({ bigint: true }), before);
    await inspectPath(params.tempPath, opened);
    await assertParent();
    identity = opened;
    unregister = registerTempPathForExit(params.tempPath, { identity, singleLinkFile: true });

    const filePath = path.resolve(params.resolveFinalPath(result));
    if (path.dirname(filePath) !== parent) {
      throw new Error("Final path must be in the sibling temp directory.");
    }
    if (filePath === params.tempPath) {
      throw new FsSafeError("invalid-path", "final path must differ from the sibling temp path");
    }
    await serializePathWrite(filePath, async () => {
      await assertCurrent(params.tempPath);
      if (params.mode !== undefined) {
        try {
          await handle!.chmod(params.mode);
        } catch (error) {
          if (!params.ignoreModeError) throw error;
        }
      }
      if (params.syncTempFile) {
        await assertCurrent(params.tempPath);
        try {
          await handle!.sync();
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "EPERM") throw error;
        }
      }
      await assertCurrent(params.tempPath);
      await fs.rename(params.tempPath, filePath);
      // A later verification failure never authorizes rollback of the final name.
      renamed = true;
      unregister!();
      await assertCurrent(filePath);
      if (params.syncParentDir) await syncDirectoryBestEffort(parent);
      await assertCurrent(filePath);
    });
    return { filePath, result };
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      if (!renamed && identity) {
        try {
          await assertParent();
          await inspectStage(() => handle!.stat({ bigint: true }), identity);
          await inspectPath(params.tempPath, identity);
          await fs.unlink(params.tempPath);
          unregister?.();
        } catch (error) {
          // Preserve observed substitutes; retry only operational cleanup failures.
          if (error instanceof FsSafeError || (error as NodeJS.ErrnoException)?.code === "ENOENT") {
            unregister?.();
          }
        }
      }
    } finally {
      try {
        await handle?.close();
      } catch (error) {
        if (failure) throw new AggregateError([failure.error, error], "sibling publication and close failed");
        throw error;
      }
    }
  }
}
