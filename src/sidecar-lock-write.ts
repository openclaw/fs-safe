import fs from "node:fs";
import promises from "node:fs/promises";
import path from "node:path";
import { assertSyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { createSuppressedError } from "./suppressed-error.js";
import { FsSafeError } from "./errors.js";
import { annotateReadOnlyOpenError } from "./file-open-error.js";
import { recordFileObservationFailure } from "./file-observation.js";
import { captureNativeFdClose } from "./native-binding.js";
import { nativeOpenFlags } from "./native-operations.js";
import type { NativeWriteParent, PinnedWriteParams } from "./pinned-write-types.js";
import { writePinnedInput } from "./pinned-write-input.js";
import { cleanupPinnedFilePath } from "./file-cleanup.js";
import { createSidecarFile } from "./sidecar-lock-publication.js";
import { isTransientLockFileDenial } from "./sidecar-lock-policy.js";

export class SidecarFallbackWriteError extends Error {
  constructor(readonly failure: unknown) { super("sidecar fallback failed"); }
}

export async function writeSidecarAtParent(
  params: PinnedWriteParams, parent: AnyAsyncDirectoryGuard, native?: NativeWriteParent,
) {
  try { return await writeAtParent(params, parent, native); }
  catch (error) {
    if (!native) throw new SidecarFallbackWriteError(error);
    throw error;
  }
}

/** The admitted Root parent stays owned by the caller until verification ends. */
async function writeAtParent(
  params: PinnedWriteParams,
  parent: AnyAsyncDirectoryGuard,
  native?: NativeWriteParent,
) {
  if (params.input.kind !== "buffer") throw new TypeError("sidecar payload must be buffered");
  const target = path.join(parent.realPath, params.basename);
  const raw = Buffer.isBuffer(params.input.data)
    ? params.input.data.toString(params.input.encoding ?? "utf8") : params.input.data;
  const assertCurrent = () => {
    params.assertBeforeMutation?.();
    assertSyncDirectoryGuard(parent);
  };
  const onConflict = (error: unknown) => {
    recordFileObservationFailure(error, `exclusive-create:${target}`);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FsSafeError("already-exists", "file already exists", { cause: error });
    }
  };
  const created = await createSidecarFile(target, raw, async pathname => {
    assertCurrent();
    const failedOpen = (error: unknown): never => {
      if (native) annotateReadOnlyOpenError(error, pathname);
      if (isTransientLockFileDenial(error, pathname)) recordFileObservationFailure(error, `sidecar-create-denial:${target}`);
      if (pathname === target) onConflict(error);
      throw error;
    };
    if (!native) {
      let handle: Awaited<ReturnType<typeof promises.open>>;
      try { handle = await promises.open(pathname, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (process.platform !== "win32" ? fs.constants.O_NOFOLLOW ?? 0 : 0), params.mode); }
      catch (error) { return failedOpen(error); }
      return {
        fd: handle.fd,
        close: () => handle.close(),
        writeFile: async (data: string, encoding: BufferEncoding) =>
          await writePinnedInput(handle, { kind: "buffer", data, encoding }),
      };
    }
    const close = captureNativeFdClose(native.binding);
    let open = true;
    let fd: number;
    try {
      fd = native.binding.createStagedFile && process.platform !== "win32"
        ? await native.binding.createStagedFile(native.fd, path.basename(pathname))
        : native.binding.openBeneath!(native.fd, path.basename(pathname),
          nativeOpenFlags(fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL)).fd;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (process.platform === "win32" && failure?.code === "EPERM" && failure.path === undefined) {
        try { failure.path = pathname; } catch { /* Keep immutable native diagnostics. */ }
      }
      return failedOpen(error);
    }
    return {
      fd,
      async close() { if (open) { open = false; close(fd); } },
      async writeFile(data: string, encoding: BufferEncoding) {
        await writePinnedInput(fd, { kind: "buffer", data, encoding });
      },
    };
  }, {
    nativeParent: native, assertCurrent, assertCleanupCandidate: params.assertSidecarCleanupCandidate,
    onConflict, prepare: fd => fs.fchmodSync(fd, params.mode), requireExactIdentity: true,
  });
  const handle = created.handle;
  let failure: { error: unknown } | undefined;
  try {
    const identity = created.identity;
    try {
      assertCurrent();
      await params.verifyPublished?.(handle.fd, identity, parent, native);
    } catch (error) {
      if (!native) {
        try {
          assertCurrent();
          await cleanupPinnedFilePath({ pathname: target, handle, identity, parentGuard: parent, throwOnCleanupError: true });
        } catch (cleanupError) {
          throw createSuppressedError(cleanupError, error, "sidecar verification and cleanup both failed");
        }
      }
      throw error;
    }
    return { dev: identity.dev, ino: identity.ino };
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try { await handle.close(); }
    catch (closeError) {
      if (failure) throw createSuppressedError(closeError, failure.error, "sidecar write and close both failed");
      throw closeError;
    }
  }
}
