import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fileStoreSync } from "../src/file-store.js";
import * as realpath from "../src/realpath.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { force: true, recursive: true })));
});

it.runIf(process.platform !== "win32").each(
  [false, true].flatMap((privateMode) => ["root", "component"].map((swapAt) => ({
    privateMode,
    swapAt,
  }))),
)(
  "rejects a $swapAt store swap without changing outside modes (private=$privateMode)",
  async ({ privateMode, swapAt }) => {
      const container = await fsp.mkdtemp(
        path.join(os.tmpdir(), `fs-safe-sync-${swapAt}-swap-${privateMode}-`),
      );
      tempDirs.push(container);
      const storeRoot = path.join(container, "store");
      const originalRoot = path.join(container, "store-original");
      const outside = path.join(container, "outside");
      const firstDir = path.join(storeRoot, "first");
      const originalFirst = path.join(storeRoot, "first-original");
      const outsideFirst = path.join(outside, "first");
      await fsp.mkdir(firstDir, { recursive: true });
      await fsp.mkdir(outsideFirst, { recursive: true });
      await Promise.all([
        fsp.chmod(storeRoot, 0o755),
        fsp.chmod(firstDir, 0o755),
        fsp.chmod(outside, 0o755),
        fsp.chmod(outsideFirst, 0o755),
      ]);

      const originalRealpathSync = realpath.realpathSync;
      let swapped = false;
      const realpathSpy = vi.spyOn(realpath, "realpathSync").mockImplementation((...args) => {
        const realPath = originalRealpathSync(...args);
        const trigger = swapAt === "root" ? storeRoot : firstDir;
        if (!swapped && String(args[0]) === trigger) {
          swapped = true;
          if (swapAt === "root") {
            fs.renameSync(storeRoot, originalRoot);
            fs.symlinkSync(outside, storeRoot, "dir");
          } else {
            fs.renameSync(firstDir, originalFirst);
            fs.symlinkSync(outsideFirst, firstDir, "dir");
          }
        }
        return realPath;
      });

      try {
        const store = fileStoreSync({
          rootDir: storeRoot,
          private: privateMode,
          dirMode: 0o700,
          durable: false,
        });
        expect(() => store.writeText("first/second/value.txt", "secret")).toThrow(
          expect.objectContaining({ code: "outside-workspace" }),
        );
        expect(fs.existsSync(path.join(outside, "first", "second", "value.txt"))).toBe(false);
        const outsideTarget = swapAt === "root" ? outside : outsideFirst;
        expect(fs.statSync(outsideTarget).mode & 0o777).toBe(0o755);
      } finally {
        realpathSpy.mockRestore();
      }
  },
);
