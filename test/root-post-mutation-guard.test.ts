import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

it.each(["remove", "move-source", "move-target"].flatMap(operation =>
  [false, true].map(missing => ({ operation, missing }))))(
  "$operation reports a changed parent after the mutation (missing=$missing)",
  async ({ operation, missing }) => {
    const dir = await tempRoot("fs-safe-post-mutation-");
    const sourceDir = path.join(dir, "source");
    const targetDir = path.join(dir, "target");
    await fs.mkdir(sourceDir);
    await fs.mkdir(targetDir);
    await fs.writeFile(path.join(sourceDir, "value"), "original");
    configureFsSafeNative({ mode: "off" });
    const scoped = await root(dir);
    const rename = fs.rename.bind(fs);
    const movedParent = path.join(dir, "moved-parent");
    const replaceParent = async (parent: string) => {
      await rename(parent, movedParent);
      if (!missing) await fs.mkdir(parent);
    };
    if (operation === "remove") {
      const remove = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementationOnce(async (file, options) => {
        await remove(file, options);
        await replaceParent(sourceDir);
      });
      await expect(scoped.remove("source/value")).rejects.toMatchObject({
        code: missing ? "not-found" : "path-mismatch",
        message: expect.not.stringContaining(dir),
      });
      await expect(fs.stat(path.join(movedParent, "value"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
        await rename(from, to);
        await replaceParent(operation === "move-source" ? sourceDir : targetDir);
      });
      await expect(scoped.move("source/value", "target/value")).rejects.toMatchObject({
        code: missing ? "path-alias" : "path-mismatch",
        message: expect.not.stringContaining(dir),
      });
      expect(await fs.readFile(path.join(operation === "move-target" ? movedParent : targetDir, "value"), "utf8"))
        .toBe("original");
    }
  },
);
