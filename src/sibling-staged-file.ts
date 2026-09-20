import { syncFileBestEffort } from "./file-sync.js";
import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  type AsyncDirectoryGuard,
  assertDirectoryIdentitySync,
  createAsyncDirectoryGuard,
} from "./directory-guard.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { isWindowsReservedDeviceName } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import {
  handoffPrivateProducerFile,
  type PrivateProducerHandoff,
} from "./private-producer-handoff.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { rootFromDirectoryGuard } from "./root-impl.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";
import { createOwnedTempFile } from "./temp-target.js";
import { serializePathWrite } from "./write-queue.js";
import {
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

const INVALID_CALLBACK_COMPONENT_CHARACTERS = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/u;

function resolveCallbackTempDirectory(workspaceDir: string): string {
  assertNoWindowsPathAlias(workspaceDir, "filesystem", "sibling temp parent uses a Windows filesystem namespace alias");
  const dir = resolvePathPreservingWindowsRoot(workspaceDir);
  assertNoWindowsPathAlias(dir, "filesystem", "sibling temp parent uses a Windows filesystem namespace alias");
  return dir;
}

export function resolveCallbackTempPath(workspaceDir: string, component: string): string {
  const dir = resolveCallbackTempDirectory(workspaceDir);
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
  assertNoWindowsPathAlias(joined, "filesystem", "sibling temp path uses a Windows filesystem namespace alias");
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

function inspectStage(inspect: () => BigIntStats, expected?: BigIntStats) {
  return inspectFileIdentitySync(() => {
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
  writeReceiver: unknown;
  parentGuard: AsyncDirectoryGuard<BigIntStats>;
  assertParent: () => void;
  syncTempFile: boolean;
}): Promise<IsolatedProducerResult<T>> {
  const { tempPath, write, writeReceiver, parentGuard, assertParent, syncTempFile } = params;
  assertParent();
  const targetRoot = rootFromDirectoryGuard(parentGuard);
  // Select the handoff before invoking the producer. Missing required native
  // support must not leave producer output behind as a discovery side effect.
  const native = getNativeBinding();
  const cleanupErrors: unknown[] = [];
  const { target, identity } = await createOwnedTempFile({
    rootDir: targetRoot.rootReal,
    prefix: "fs-safe-output",
    fileName: path.basename(tempPath),
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
    assertParent();
    assertWorkspace();
  };
  try {
    const producerPath = resolveCallbackTempPath(target.dir, path.basename(target.path));
    assertCurrent();
    const result = await Reflect.apply(write, writeReceiver, [producerPath]);
    assertCurrent();
    if (native) {
      await targetRoot.move(
        path.relative(targetRoot.rootReal, producerPath),
        path.basename(tempPath),
        { assertBeforeMutation: assertCurrent },
      );
      return { cleanupWorkspace, result };
    }
    const handoff = await handoffPrivateProducerFile({
      sourcePath: producerPath,
      targetPath: tempPath,
      assertSourceParent: assertWorkspace,
      assertTargetParent: assertParent,
      readWrite: syncTempFile,
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
  const parent = resolveCallbackTempDirectory(params.tempDir);
  const tempPath = resolveCallbackTempPath(parent, params.tempName);
  const write = params.write;
  const producerIsolation = params.producerIsolation;
  const resolveFinalPath = params.resolveFinalPath;
  const mode = params.mode;
  const ignoreModeError = params.ignoreModeError;
  const maxBytes = params.maxBytes;
  const syncTempFile = params.syncTempFile;
  const syncParentDir = params.syncParentDir;
  const guard = await createAsyncDirectoryGuard(parent, { bigint: true });
  const assertParent = () => assertDirectoryIdentitySync(parent, {
    dev: guard.stat.dev, ino: guard.stat.ino, realPath: guard.realPath,
  });
  let handle: FileHandle | undefined;
  let identity: BigIntStats | undefined;
  let unregister: TempPathRegistration | undefined;
  let cleanupWorkspace: (() => Promise<void>) | undefined;
  let renamed = false;
  let failure: { error: unknown } | undefined;
  const inspectPath = (pathname: string, expected?: BigIntStats) =>
    inspectStage(() => fsSync.lstatSync(pathname, { bigint: true }), expected);
  const assertCurrent = (pathname: string) => {
    assertParent();
    const opened = inspectStage(() => fsSync.fstatSync(handle!.fd, { bigint: true }), identity);
    const current = inspectPath(pathname, opened);
    if (
      maxBytes !== undefined &&
      (opened.size > maxBytes || current.size > maxBytes)
    ) {
      throw new FsSafeError("too-large", `sibling temp exceeds maxBytes (${maxBytes})`);
    }
  };

  try {
    let result: T;
    if (producerIsolation === "private-directory") {
      const isolated = await writeIsolatedProducer({
          tempPath: tempPath,
          write,
          writeReceiver: params,
          parentGuard: guard,
          syncTempFile: syncTempFile,
          assertParent,
        });
      result = isolated.result;
      cleanupWorkspace = isolated.cleanupWorkspace;
      if (isolated.handoff) {
        handle = isolated.handoff.handle;
        identity = isolated.handoff.identity;
        unregister = isolated.handoff.unregister;
      }
    } else {
      result = await Reflect.apply(write, params, [tempPath]);
    }
    assertParent();
    let expected = identity;
    if (!handle) {
      expected = inspectPath(tempPath);
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
    }
    const opened = inspectStage(() => fsSync.fstatSync(handle!.fd, { bigint: true }), expected);
    inspectPath(tempPath, opened);
    if (!identity) {
      identity = opened;
      unregister = registerTempPathForExit(tempPath, { identity, singleLinkFile: true });
    }
    assertParent();
    if (cleanupWorkspace) {
      const cleanup = cleanupWorkspace;
      cleanupWorkspace = undefined;
      await cleanup();
    }

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
      assertCurrent(tempPath);
      if (mode !== undefined) {
        try {
          await handle!.chmod(mode);
        } catch (error) {
          if (!ignoreModeError) throw error;
        }
        assertCurrent(tempPath);
      }
      if (syncTempFile) {
        await syncFileBestEffort(handle!);
        assertCurrent(tempPath);
      }
      await fs.rename(tempPath, filePath);
      // A later verification failure never authorizes rollback of the final name.
      renamed = true;
      unregister!();
      assertCurrent(filePath);
      if (syncParentDir) {
        await syncDirectoryBestEffort(parent);
        assertCurrent(filePath);
      }
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
          assertParent();
          inspectStage(() => fsSync.fstatSync(handle!.fd, { bigint: true }), identity);
          inspectPath(tempPath, identity);
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
