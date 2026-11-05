import fs from "node:fs";
import promises from "node:fs/promises";
import path from "node:path";
import { assertSyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { recordFileObservationFailure } from "./file-observation.js";
import { captureNativeFdClose } from "./native-binding.js";
import { nativeOpenFlags } from "./native-operations.js";
import type { NativeWriteParent, PinnedWriteParams } from "./pinned-write-types.js";
import { writePinnedInput } from "./pinned-write-input.js";
import { cleanupPinnedFilePath } from "./file-cleanup.js";
import { createSidecarFile } from "./sidecar-lock-publication.js";

/** The admitted Root parent stays owned by the caller until verification ends. */
export async function writeSidecarAtParent(
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
  const onConflict = (error: unknown) => recordFileObservationFailure(error, `exclusive-create:${target}`);
  const created = await createSidecarFile(target, raw, async pathname => {
    assertCurrent();
    try {
      if (!native) {
        const handle = await promises.open(pathname, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, params.mode);
        return {
          fd: handle.fd,
          close: () => handle.close(),
          writeFile: async (data: string, encoding: BufferEncoding) =>
            await writePinnedInput(handle, { kind: "buffer", data, encoding }),
        };
      }
      const close = captureNativeFdClose(native.binding);
      const fd = native.binding.createStagedFile && process.platform !== "win32"
        ? await native.binding.createStagedFile(native.fd, path.basename(pathname))
        : native.binding.openBeneath!(native.fd, path.basename(pathname),
          nativeOpenFlags(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL)).fd;
      return {
        fd,
        async close() { close(fd); },
        async writeFile(data: string, encoding: BufferEncoding) {
          await writePinnedInput(fd, { kind: "buffer", data, encoding });
        },
      };
    } catch (error) {
      if (pathname === target) onConflict(error);
      throw error;
    }
  }, { nativeParent: native, assertCurrent, onConflict, prepare: fd => fs.fchmodSync(fd, params.mode) });
  const handle = created.handle;
  try {
    if (!created.complete) {
      const identity = fs.fstatSync(handle.fd, { bigint: true });
      try {
        fs.fchmodSync(handle.fd, params.mode);
        await handle.writeFile(raw, "utf8");
        fs.fsyncSync(handle.fd);
      } catch (error) {
        if (native?.binding.removeStagedFile) {
          assertCurrent();
          native.binding.removeStagedFile(native.fd, params.basename, handle.fd);
        } else await cleanupPinnedFilePath({ pathname: target, handle, identity, parentGuard: parent });
        throw error;
      }
    }
    assertCurrent();
    const identity = fs.fstatSync(handle.fd, { bigint: true });
    await params.verifyPublished?.(handle.fd, identity, parent, native);
    return { dev: identity.dev, ino: identity.ino };
  } finally {
    await handle.close();
  }
}
