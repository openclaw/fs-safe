import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
});

for (const kind of ["sync", "async"] as const) {
  for (const contention of ["existing sidecar", "Windows open denial"] as const) {
    it.each([null, undefined])(`preserves a ${kind} retry getter throwing %s after ${contention}`, async rejection => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-lock-retry-error-");
      const targetPath = path.join(directory, "state"), lockPath = `${targetPath}.lock`;
      let denials = 0, getterCalls = 0;
      if (contention === "existing sidecar") {
        await fsp.writeFile(lockPath, JSON.stringify({ owner: "other", createdAt: new Date().toISOString() }));
      } else {
        // Simulate Windows denial classification on every host, retaining real local I/O elsewhere.
        Object.defineProperty(process, "platform", { value: "win32" });
        const denial = Object.assign(new Error("lock-file open denied"), { code: "EPERM", path: lockPath, syscall: "open" });
        if (kind === "sync") {
          const open = fs.openSync.bind(fs);
          vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
            if (file === lockPath && typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0) {
              denials += 1;
              throw denial;
            }
            return open(file, flags, mode);
          });
        } else {
          const open = fsp.open.bind(fsp);
          vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
            if (args[0] === lockPath && args[1] === "wx") {
              denials += 1;
              throw denial;
            }
            return await open(...args);
          });
        }
      }
      const payload = vi.fn(() => ({ owner: "new" }));
      const options = {
        managerKey: directory, payload, staleMs: 60_000, timeoutMs: 1000,
        retry: {
          retries: 1, minTimeout: 0, maxTimeout: 0,
          get randomize(): boolean { getterCalls += 1; throw rejection; },
        },
      };
      await expect(Promise.resolve().then(() => kind === "sync"
        ? acquireFileLockSync(targetPath, options)
        : acquireFileLock(targetPath, options))).rejects.toBe(rejection);
      expect(getterCalls).toBe(1);
      expect(payload).toHaveBeenCalledOnce();
      expect(denials).toBe(contention === "Windows open denial" ? 1 : 0);
      expect(await fsp.readdir(directory)).toEqual(contention === "existing sidecar" ? ["state.lock"] : []);
    });
  }
}
