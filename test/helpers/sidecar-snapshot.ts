import fs, { type FileHandle } from "node:fs/promises";
import { vi } from "vitest";
import { __setFsSafeTestHooksForTest } from "../../src/test-hooks.js";

export function pauseSidecarSnapshotOpen(lockPath: string, afterIdentityCheck: boolean) {
  const opened = Promise.withResolvers<FileHandle>();
  const resumed = Promise.withResolvers<void>();
  __setFsSafeTestHooksForTest({
    async afterOpen(candidate, handle) {
      if (candidate !== lockPath) return;
      if (!afterIdentityCheck) {
        opened.resolve(handle);
        await resumed.promise;
        return;
      }
      // Hold the successful pathname observation so unlink lands before
      // opened-realpath resolution, rather than the earlier not-found path.
      const lstat = fs.lstat.bind(fs);
      const inspection = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (String(args[0]) === lockPath && args[1]?.bigint) {
          inspection.mockRestore();
          opened.resolve(handle);
          await resumed.promise;
        }
        return stat;
      });
    },
  });
  return { opened: opened.promise, resume: resumed.resolve };
}
