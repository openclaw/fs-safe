import { syncFileBestEffort } from "./file-sync.js";
import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  assertDirectoryIdentitySync,
  createAsyncDirectoryGuard,
} from "./directory-guard.js";
import { isWindowsReservedDeviceName } from "./device-path.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { root } from "./root.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";
import { createOwnedTempFile } from "./temp-target.js";
import { serializePathWrite } from "./write-queue.js";

const INVALID_CALLBACK_COMPONENT_CHARACTERS = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/u;

export function resolveCallbackTempPath(workspaceDir: string, component: string): string {
  const dir = path.resolve(workspaceDir);
  if (
    typeof component !== "string" ||
    component === "" ||
    component === "." ||
    component === ".." ||
    INVALID_CALLBACK_COMPONENT_CHARACTERS.test(component) ||
    component.endsWith(".") ||
    component.endsWith(" ") ||
    isWindowsReservedDeviceName(component)
  ) {
    throw new FsSafeError("invalid-path", "callback temp name must be one path component");
  }
  const joined = path.join(dir, component);
  if (path.dirname(joined) !== dir) {
    throw new FsSafeError("invalid-path", "callback temp path must be a direct workspace child");
  }
  return joined;
}

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
  assertParent: () => void;
}): Promise<T> {
  const targetRoot = await root(path.dirname(params.tempPath));
  const { target, identity } = await createOwnedTempFile({
    rootDir: targetRoot.rootReal,
    prefix: "fs-safe-output",
    fileName: path.basename(params.tempPath),
  });
  const assertCurrent = () => {
    params.assertParent();
    assertDirectoryIdentitySync(target.dir, { ...identity, realPath: target.dir });
  };
  try {
    const producerPath = resolveCallbackTempPath(target.dir, path.basename(target.path));
    assertCurrent();
    const result = await params.write(producerPath);
    assertCurrent();
    await targetRoot.move(path.relative(targetRoot.rootReal, producerPath), path.basename(params.tempPath), {
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
  tempDir: string;
  tempName: string;
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
  const parent = path.resolve(params.tempDir);
  const tempPath = resolveCallbackTempPath(parent, params.tempName);
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
      params.maxBytes !== undefined &&
      (opened.size > params.maxBytes || current.size > params.maxBytes)
    ) {
      throw new FsSafeError("too-large", `sibling temp exceeds maxBytes (${params.maxBytes})`);
    }
  };

  try {
    const result = params.producerIsolation === "private-directory"
      ? await writeIsolatedProducer({
          tempPath,
          write: params.write,
          assertParent: () => assertDirectoryIdentitySync(parent, {
            dev: guard.stat.dev,
            ino: guard.stat.ino,
            realPath: guard.realPath,
          }),
        })
      : await params.write(tempPath);
    await assertParent();
    const before = await inspectPath(tempPath);
    try {
      // No create/truncate flags; O_NONBLOCK also bounds a FIFO swap during open.
      const access = params.syncTempFile ? fsSync.constants.O_RDWR : fsSync.constants.O_RDONLY;
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

    const filePath = path.resolve(params.resolveFinalPath(result));
    if (path.dirname(filePath) !== parent) {
      throw new Error("Final path must be in the sibling temp directory.");
    }
    if (filePath === tempPath) {
      throw new FsSafeError("invalid-path", "final path must differ from the sibling temp path");
    }
    await serializePathWrite(filePath, async () => {
      await assertCurrent(tempPath);
      if (params.mode !== undefined) {
        try {
          await handle!.chmod(params.mode);
        } catch (error) {
          if (!params.ignoreModeError) throw error;
        }
      }
      if (params.syncTempFile) {
        await assertCurrent(tempPath);
        await syncFileBestEffort(handle!);
      }
      await assertCurrent(tempPath);
      await fs.rename(tempPath, filePath);
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
