import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fileStoreSync } from "../src/file-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { force: true, recursive: true })));
});

it.runIf(process.platform !== "win32")(
  "rejects store-root swaps during private and non-private parent walks",
  async () => {
    for (const privateMode of [false, true]) {
      const container = await fsp.mkdtemp(
        path.join(os.tmpdir(), `fs-safe-sync-root-swap-${privateMode}-`),
      );
      tempDirs.push(container);
      const storeRoot = path.join(container, "store");
      const originalRoot = path.join(container, "store-original");
      const outside = path.join(container, "outside");
      const firstDir = path.join(storeRoot, "first");
      await fsp.mkdir(storeRoot);
      await fsp.mkdir(path.join(outside, "first"), { recursive: true });

      const originalRealpathSync = fs.realpathSync.bind(fs);
      let swapped = false;
      const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation((...args) => {
        const realPath = originalRealpathSync(...args);
        if (!swapped && String(args[0]) === firstDir) {
          swapped = true;
          fs.renameSync(storeRoot, originalRoot);
          fs.symlinkSync(outside, storeRoot, "dir");
        }
        return realPath;
      });

      try {
        const store = fileStoreSync({ rootDir: storeRoot, private: privateMode });
        expect(() => store.writeText("first/second/value.txt", "secret")).toThrow(
          expect.objectContaining({ code: "outside-workspace" }),
        );
        expect(fs.existsSync(path.join(outside, "first", "second", "value.txt"))).toBe(false);
      } finally {
        realpathSpy.mockRestore();
      }
    }
  },
);
