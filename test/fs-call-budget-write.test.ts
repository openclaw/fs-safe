import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { root } from "../src/root.js";
import { loadTestNative, loadWindowsSimulationNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

const writeNativeAvailable = Boolean(loadTestNative("required-env"));
describe("write metadata budgets", () => {
  for (const mode of ["off", "require"] as const) {
  it.skipIf(mode === "require" && !writeNativeAvailable)(`preserves both Windows file flushes without redundant chmod in ${mode} mode`, async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const directory = await tempRoot("fs-safe-write-windows-mode-");
    if (mode === "require") {
      const binding = loadWindowsSimulationNative();
      __setNativeLoaderForTest(() => binding);
    }
    Object.defineProperty(process, "platform", { value: "win32" });
    configureFsSafeNative({ mode });
    const safe = await root(directory);
    const open = fs.open.bind(fs);
    const fstat = fsSync.fstatSync.bind(fsSync);
    const fsync = fsSync.fsyncSync.bind(fsSync);
    const chmod = vi.spyOn(fsSync, "fchmodSync");
    let flushes = 0;
    vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
      if (fstat(fd).isFile()) flushes++;
      fsync(fd);
    });
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if (fstat(handle.fd).isFile()) flushes++;
        await sync();
      });
      return handle;
    });
    try {
      await safe.write("value", "writable", { mode: 0o600 });
      expect(chmod).not.toHaveBeenCalled();
      expect(flushes).toBe(2);
      await safe.write("value", "read-only", { mode: 0o400 });
      expect(chmod).toHaveBeenCalledTimes(1);
      expect(flushes).toBe(4);
      expect(fsSync.statSync(path.join(directory, "value")).mode & 0o200).toBe(0);
    } finally {
      vi.restoreAllMocks();
      Object.defineProperty(process, "platform", platform);
      configureFsSafeNative({ mode: "auto" });
      __resetNativeLoaderForTest();
      await fs.chmod(path.join(directory, "value"), 0o600).catch(() => undefined);
    }
  });
  }
});
