import type { FileHandle } from "node:fs/promises";
import {
  parseSidecarLockSnapshot,
  readSidecarLockRawSnapshot,
  type SidecarLockSnapshot,
} from "../../src/sidecar-lock-reclaim.js";
import { __setFsSafeTestHooksForTest } from "../../src/test-hooks.js";

export async function readSidecarLockSnapshot(
  lockPath: string,
  options: Parameters<typeof readSidecarLockRawSnapshot>[1] & { parsePayload?: (raw: string) => unknown } = {},
): Promise<SidecarLockSnapshot | null> {
  return parseSidecarLockSnapshot(await readSidecarLockRawSnapshot(lockPath, options), options.parsePayload);
}

export function pauseSidecarSnapshotOpen(lockPath: string, afterIdentityCheck: boolean) {
  const opened = Promise.withResolvers<FileHandle>();
  const resumed = Promise.withResolvers<void>();
  const pause = async (candidate: string, handle: FileHandle) => {
    if (candidate !== lockPath) return;
    opened.resolve(handle);
    await resumed.promise;
  };
  __setFsSafeTestHooksForTest(afterIdentityCheck
    ? { beforeRootReadFinalFence: pause }
    : { afterOpen: pause });
  return { opened: opened.promise, resume: resumed.resolve };
}
