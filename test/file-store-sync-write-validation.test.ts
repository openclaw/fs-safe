import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeErrorSync } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { fileStoreSync } from "../src/file-store.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sync file-store write validation", () => {
  itPosix.each([false, true])(
    "rejects a post-rename symlink swap without chmodding its target (private=%s)",
    async (privateMode) => {
      const root = await tempRoot("fs-safe-sync-store-write-swap-");
      const outside = await tempRoot("fs-safe-sync-store-write-outside-");
      const filePath = path.join(root, "value.txt");
      const outsidePath = path.join(outside, "outside.txt");
      await fs.writeFile(outsidePath, "outside", { mode: 0o644 });
      await fs.chmod(outsidePath, 0o644);

      const realRenameSync = fsSync.renameSync;
      vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
        realRenameSync(from, to);
        if (to !== filePath) return;
        fsSync.rmSync(filePath);
        fsSync.symlinkSync(outsidePath, filePath, "file");
      });

      const store = fileStoreSync({ rootDir: root, private: privateMode, mode: 0o600 });
      expectFsSafeErrorSync(() => store.writeText("value.txt", "inside"), "path-mismatch");
      expect((await fs.stat(outsidePath)).mode & 0o777).toBe(0o644);
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
    },
  );
});
