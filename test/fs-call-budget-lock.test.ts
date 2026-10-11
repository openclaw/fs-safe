import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe("uncontended raw sidecar acquisition budgets", () => {
  it.each([false, true])("avoids missing-guard exceptions and redundant parent work (sync=%s)", async (sync) => {
    const { acquireFileLock, acquireFileLockSync } = await import("../src/file-lock.js");
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-lock-budget-");
    const originalLstat = fsSync.lstatSync;
    let guardObservations = 0, guardErrors = 0;
    const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const isGuard = String(args[0]).endsWith(".reclaim");
      if (isGuard) guardObservations++;
      try { return Reflect.apply(originalLstat, fsSync, args); }
      catch (error) { if (isGuard) guardErrors++; throw error; }
    }) as typeof fsSync.lstatSync);
    const mkdir = vi.spyOn(fsSync, "mkdirSync");
    const open = vi.spyOn(fs, "open");
    const syncFile = vi.spyOn(fsSync, "fsyncSync");
    const options = { payload: () => ({ pid: process.pid }), timeoutMs: 1000 };
    let held: Awaited<ReturnType<typeof acquireFileLock>> | ReturnType<typeof acquireFileLockSync> | undefined;
    try {
      held = sync ? acquireFileLockSync(path.join(directory, "state"), options)
        : await acquireFileLock(path.join(directory, "state"), options);
      expect(guardObservations).toBe(1);
      expect(guardErrors).toBe(0);
      expect(mkdir).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(sync ? 0 : 1);
      expect(syncFile).toHaveBeenCalledTimes(sync ? 1 : 0);
    } finally {
      lstat.mockRestore(); mkdir.mockRestore(); open.mockRestore(); syncFile.mockRestore();
      await held?.release();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});
