import { syncFileBestEffort } from "./file-sync.js";
import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  type AsyncDirectoryGuard,
  assertAsyncDirectoryGuard,
  assertDirectoryIdentitySync,
  createAsyncDirectoryGuard,
} from "./directory-guard.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import {
  handoffPrivateProducerFile,
  type PrivateProducerHandoff,
} from "./private-producer-handoff.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { rootFromDirectoryGuard } from "./root-impl.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";
import { createOwnedTempFile } from "./temp-target.js";
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

async function inspectStage(inspect: () => BigIntStats, expected?: BigIntStats) {
  return await inspectFileIdentity(async () => {
    const stat = inspect();
    assertRegularFile(stat);
    return stat;
  }, expected);
}

type IsolatedProducerResult<T> = {
  cleanupWorkspace: () => Promise<void>;
  handoff?: PrivateProducerHandoff;
  result: T;
};

function aggregateErrors(errors: readonly unknown[], message: string): unknown {
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, message);
}

// Own the workspace before the producer can leave partial output. The finished
// file still enters the ordinary sibling admission and publication lifecycle.
async function writeIsolatedProducer<T>(params: {
  tempPath: string;
  write: (tempPath: string) => Promise<T>;
  parentGuard: AsyncDirectoryGuard<BigIntStats>;
  assertParent: () => void;
  syncTempFile: boolean;
}): Promise<IsolatedProducerResult<T>> {
  params.assertParent();
  const targetRoot = rootFromDirectoryGuard(params.parentGuard);
  // Select the handoff before invoking the producer. Missing required native
  // support must not leave producer output behind as a discovery side effect.
  const native = getNativeBinding();
  const cleanupErrors: unknown[] = [];
  const { target, identity } = await createOwnedTempFile({
    rootDir: targetRoot.rootReal,
    prefix: "fs-safe-output",
    fileName: path.basename(params.tempPath),
    onCleanupError: (error) => cleanupErrors.push(error),
  });
  let cleanupStarted = false;
  const cleanupWorkspace = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    try {
      await target.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw aggregateErrors(cleanupErrors, "isolated producer workspace cleanup failed");
    }
  };
  const assertWorkspace = () => {
    assertDirectoryIdentitySync(target.dir, { ...identity, realPath: target.dir });
  };
  const assertCurrent = () => {
    params.assertParent();
    assertWorkspace();
  };
  try {
    assertCurrent();
    const result = await params.write(target.path);
    assertCurrent();
    if (native) {
      await targetRoot.move(
        path.relative(targetRoot.rootReal, target.path),
        path.basename(params.tempPath),
        { assertBeforeMutation: assertCurrent },
      );
      return { cleanupWorkspace, result };
    }
    const handoff = await handoffPrivateProducerFile({
      sourcePath: target.path,
      targetPath: params.tempPath,
      assertSourceParent: assertWorkspace,
      assertTargetParent: params.assertParent,
      readWrite: params.syncTempFile,
    });
    return { cleanupWorkspace, handoff, result };
  } catch (error) {
    try {
      await cleanupWorkspace();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "isolated producer operation and workspace cleanup failed",
      );
    }
    throw error;
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
  const parent = path.dirname(params.tempPath);
  const guard = await createAsyncDirectoryGuard(parent, { bigint: true });
  const assertParent = () => assertAsyncDirectoryGuard(guard);
  let handle: FileHandle | undefined;
  let identity: BigIntStats | undefined;
  let unregister: TempPathRegistration | undefined;
  let cleanupWorkspace: (() => Promise<void>) | undefined;
  let renamed = false;
  let failure: { error: unknown } | undefined;
  const inspectPath = (pathname: string, expected?: BigIntStats) =>
    inspectStage(() => fsSync.lstatSync(pathname, { bigint: true }), expected);
  const assertCurrent = async (pathname: string) => {
    await assertParent();
    const opened = await inspectStage(() => fsSync.fstatSync(handle!.fd, { bigint: true }), identity);
    const current = await inspectPath(pathname, opened);
    if (
      params.maxBytes !== undefined &&
      (opened.size > params.maxBytes || current.size > params.maxBytes)
    ) {
      throw new FsSafeError("too-large", `sibling temp exceeds maxBytes (${params.maxBytes})`);
    }
  };

  try {
    let result: T;
    if (params.producerIsolation === "private-directory") {
      const isolated = await writeIsolatedProducer({
          tempPath: params.tempPath,
          write: params.write,
          parentGuard: guard,
          syncTempFile: params.syncTempFile,
          assertParent: () => assertDirectoryIdentitySync(parent, {
            dev: guard.stat.dev,
            ino: guard.stat.ino,
            realPath: guard.realPath,
          }),
        });
      result = isolated.result;
      cleanupWorkspace = isolated.cleanupWorkspace;
      if (isolated.handoff) {
        handle = isolated.handoff.handle;
        identity = isolated.handoff.identity;
        unregister = isolated.handoff.unregister;
      }
    } else {
      result = await params.write(params.tempPath);
    }
    await assertParent();
    if (handle) {
      const opened = await inspectStage(
        () => fsSync.fstatSync(handle!.fd, { bigint: true }),
        identity,
      );
      await inspectPath(params.tempPath, opened);
    } else {
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
      const opened = await inspectStage(() => fsSync.fstatSync(handle!.fd, { bigint: true }), before);
      await inspectPath(params.tempPath, opened);
      identity = opened;
      unregister = registerTempPathForExit(params.tempPath, { identity, singleLinkFile: true });
    }
    await assertParent();
    if (cleanupWorkspace) {
      const cleanup = cleanupWorkspace;
      cleanupWorkspace = undefined;
      await cleanup();
    }

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
        await syncFileBestEffort(handle!);
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
    const settlementErrors: unknown[] = [];
    if (cleanupWorkspace) {
      try {
        await cleanupWorkspace();
      } catch (error) {
        settlementErrors.push(error);
      }
    }
    try {
      if (!renamed && identity) {
        try {
          await assertParent();
          await inspectStage(() => fsSync.fstatSync(handle!.fd, { bigint: true }), identity);
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
        settlementErrors.push(error);
      }
      if (settlementErrors.length > 0) {
        if (failure) {
          throw new AggregateError(
            [failure.error, ...settlementErrors],
            "sibling publication and settlement failed",
          );
        }
        throw aggregateErrors(settlementErrors, "sibling publication settlement failed");
      }
    }
  }
}
