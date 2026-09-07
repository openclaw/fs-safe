import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const writers = [
  { operation: "write", write: writeSecretFileAtomic },
  { operation: "create", write: createSecretFileAtomic },
] as const;
afterEach(() => vi.restoreAllMocks());

describe("secret directory admission receipts", () => {
  for (const phase of ["final parent", "ancestor"] as const) {
    itPosix.each(writers)(`$operation retains the admitted ${phase} instead of adopting a replacement`, async ({ write }) => {
      const rootDir = await tempRoot("fs-safe-secret-directory-receipt-");
      const parent = path.join(rootDir, "parent");
      const moved = path.join(rootDir, "admitted");
      await fs.mkdir(parent, { mode: 0o700 });
      const filePath = path.join(parent, phase === "ancestor" ? "inner/token" : "token");
      const lstat = fsSync.lstatSync.bind(fsSync);
      const realpath = fsSync.realpathSync.native;
      let inspections = 0;
      let admitted = false;
      let swapped = false;
      const swap = () => {
        swapped = true;
        fsSync.renameSync(parent, moved);
        fsSync.mkdirSync(parent, { mode: 0o750 });
        fsSync.chmodSync(parent, 0o750);
      };
      vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
        const isParent = String(target) === parent;
        if (phase === "ancestor" && admitted && isParent && !swapped) swap();
        const value = lstat(target, options);
        // Initial inspection, guard capture, then the permission-admission inspection.
        if (isParent && options?.bigint && ++inspections >= 3) admitted = true;
        return value;
      });
      vi.spyOn(fsSync.realpathSync, "native").mockImplementation((target, options) => {
        if (phase === "final parent" && admitted && String(target) === parent && !swapped) swap();
        return realpath(target, options);
      });

      const failure = await write({ rootDir, filePath, content: "synthetic" }).catch((error: unknown) => error);

      expect(swapped).toBe(true);
      expect(failure).toMatchObject({ code: "path-mismatch" });
      expect((await fs.lstat(parent)).mode & 0o7777).toBe(0o750);
      expect((await fs.lstat(moved)).mode & 0o7777).toBe(0o700);
      expect(await fs.readdir(parent)).toEqual([]);
      expect(await fs.readdir(moved)).toEqual([]);
    });
  }
});
