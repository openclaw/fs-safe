import type { FileHandle } from "node:fs/promises";
import { __setFsSafeTestHooksForTest } from "../../src/test-hooks.js";

export function pauseSidecarSnapshotOpen(lockPath: string, afterIdentityCheck: boolean) {
  const opened = Promise.withResolvers<FileHandle>();
  const resumed = Promise.withResolvers<void>();
  const pause = async (candidate: string, handle: FileHandle) => {
    if (candidate !== lockPath) return;
    opened.resolve(handle);
    await resumed.promise;
  };
  __setFsSafeTestHooksForTest(afterIdentityCheck
    ? { afterOpenedPathIdentityCheck: pause }
    : { afterOpen: pause });
  return { opened: opened.promise, resume: resumed.resolve };
}
