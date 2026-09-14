import { syncFileBestEffort } from "./file-sync.js";
import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  assertDirectoryIdentitySync,
  createAsyncDirectoryGuard,
} from "./directory-guard.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { root } from "./root.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";
import { createOwnedTempFile } from "./temp-target.js";
import { serializePathWrite } from "./write-queue.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

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

async function inspectStage(inspect: () => BigIntStats, expected?: BigIntStats) {
  return await inspectFileIdentity(async () => {
    const stat = inspect();
    assertRegularFile(stat);
    return stat;
  }, expected);
}

// Own the workspace before the producer can leave partial output. The finished
// file still enters the ordinary sibling admission and publication lifecycle.
async function writeIsolatedProducer<T>(params: {
  tempPath: string;
  write: (tempPath: string) => Promise<T>;
  writeReceiver: unknown;
  assertParent: () => void;
}): Promise<T> {
  const tempPath = params.tempPath;
  const write = params.write;
  const writeReceiver = params.writeReceiver;
  const assertParent = params.assertParent;
  const targetRoot = await root(path.dirname(tempPath));
  const { target, identity } = await createOwnedTempFile({
    rootDir: targetRoot.rootReal,
    prefix: "fs-safe-output",
    fileName: path.basename(tempPath),
  });
  const assertCurrent = () => {
    assertParent();
    assertDirectoryIdentitySync(target.dir, { ...identity, realPath: target.dir });
  };
  try {
    assertCurrent();
    const result = await Reflect.apply(write, writeReceiver, [target.path]);
    assertCurrent();
    await targetRoot.move(path.relative(targetRoot.rootReal, target.path), path.basename(tempPath), {
      assertBeforeMutation: assertCurrent,
    });
    return result;
  } finally {
    await target.cleanup();
  }
}

// Callback paths are not owned until all three admission observations agree.
// Keep one descriptor and one exact identity through mode, sync, rename and cleanup.
// Read/write access is needed only when the caller requests file synchronization.
export async function writeCallbackSibling<T>(params: {
  tempPath: string;
  write: (tempPath: string) => Promise<T>;
  producerIsolation?: "private-directory";
  resolveFinalPath: (result: T) => string;
  mode?: number;
  /** Preserve the caller's historical best-effort mode behavior. */
  ignoreModeError?: boolean;
  maxBytes?: number;
  syncTempFile: boolean;
  syncParentDir: boolean;
}): Promise<{ filePath: string; result: T }> {
  const tempPath = params.tempPath;
  assertNoWindowsPathAlias(tempPath, "filesystem", "sibling temp path uses a Windows filesystem namespace alias");
  const parent = path.dirname(tempPath);
  assertNoWindowsPathAlias(parent, "filesystem", "sibling temp parent uses a Windows filesystem namespace alias");
  const write = params.write;
  const producerIsolation = params.producerIsolation;
  const resolveFinalPath = params.resolveFinalPath;
  const mode = params.mode;
  const ignoreModeError = params.ignoreModeError;
  const maxBytes = params.maxBytes;
  const syncTempFile = params.syncTempFile;
  const syncParentDir = params.syncParentDir;
  const guard = await createAsyncDirectoryGuard(parent, { bigint: true });
  const assertParent = () => assertAsyncDirectoryGuard(guard);
  let handle: FileHandle | undefined;
  let identity: BigIntStats | undefined;
  let unregister: TempPathRegistration | undefined;
  let renamed = false;
  let failure: { error: unknown } | undefined;
  const inspectPath = (pathname: string, expected?: BigIntStats) =>
    inspectStage(() => fsSync.lstatSync(pathname, { bigint: true }), expected);
  const assertCurrent = async (pathname: string) => {
    await assertParent();
    const opened = await inspectStage(() => fsSync.fstatSync(handle!.fd, { bigint: true }), identity);
    const current = await inspectPath(pathname, opened);
    if (
      maxBytes !== undefined &&
      (opened.size > maxBytes || current.size > maxBytes)
    ) {
      throw new FsSafeError("too-large", `sibling temp exceeds maxBytes (${maxBytes})`);
    }
  };

  try {
    const result = producerIsolation === "private-directory"
      ? await writeIsolatedProducer({
          tempPath,
          write,
          writeReceiver: params,
          assertParent: () => assertDirectoryIdentitySync(parent, {
            dev: guard.stat.dev,
            ino: guard.stat.ino,
            realPath: guard.realPath,
          }),
        })
      : await Reflect.apply(write, params, [tempPath]);
    await assertParent();
    const before = await inspectPath(tempPath);
    try {
      // No create/truncate flags; O_NONBLOCK also bounds a FIFO swap during open.
      const access = syncTempFile ? fsSync.constants.O_RDWR : fsSync.constants.O_RDONLY;
      handle = await fs.open(tempPath, access | resolveReadOpenFlags());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
        throw new FsSafeError("symlink", "symlink sibling temp not allowed", { cause: error });
      }
      throw error;
    }
    const opened = await inspectStage(() => fsSync.fstatSync(handle!.fd, { bigint: true }), before);
    await inspectPath(tempPath, opened);
    await assertParent();
    identity = opened;
    unregister = registerTempPathForExit(tempPath, { identity, singleLinkFile: true });

    const rawFilePath = Reflect.apply(resolveFinalPath, params, [result]);
    assertNoWindowsPathAlias(rawFilePath, "filesystem", "final path uses a Windows filesystem namespace alias");
    const filePath = path.resolve(rawFilePath);
    assertNoWindowsPathAlias(filePath, "filesystem", "final path uses a Windows filesystem namespace alias");
    if (path.dirname(filePath) !== parent) {
      throw new Error("Final path must be in the sibling temp directory.");
    }
    if (filePath === tempPath) {
      throw new FsSafeError("invalid-path", "final path must differ from the sibling temp path");
    }
    await serializePathWrite(filePath, async () => {
      await assertCurrent(tempPath);
      if (mode !== undefined) {
        try {
          await handle!.chmod(mode);
        } catch (error) {
          if (!ignoreModeError) throw error;
        }
      }
      if (syncTempFile) {
        await assertCurrent(tempPath);
        await syncFileBestEffort(handle!);
      }
      await assertCurrent(tempPath);
      await fs.rename(tempPath, filePath);
      // A later verification failure never authorizes rollback of the final name.
      renamed = true;
      unregister!();
      await assertCurrent(filePath);
      if (syncParentDir) await syncDirectoryBestEffort(parent);
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
          await inspectStage(() => fsSync.fstatSync(handle!.fd, { bigint: true }), identity);
          await inspectPath(tempPath, identity);
          await fs.unlink(tempPath);
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
