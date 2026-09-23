import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !nativeAvailable)(`literal walk paths, native ${mode}`, () => {
    beforeEach(() => configureFsSafeNative({ mode }));

    for (const order of ["sorted", "filesystem"] as const) {
      it(`walks literal tilde descendants without changing entry paths (${order})`, async () => {
        const directory = await tempRoot("fs-safe-walk-literal-");
        await fs.mkdir(path.join(directory, "~", "nested"), { recursive: true });
        await fs.writeFile(path.join(directory, "~", "extra.txt"), "extra");
        await fs.writeFile(path.join(directory, "~", "nested", "value.txt"), "nested");
        const scoped = await root(directory);
        await using opened = await scoped.open("./~/extra.txt");
        expect(await opened.handle.readFile("utf8")).toBe("extra");

        const entries = await Array.fromAsync(scoped.walk("", { order, symlinkPolicy: "skip" }));
        expect(entries.map(({ relativePath }) => relativePath).sort()).toEqual([
          "~", "~/extra.txt", "~/nested", "~/nested/value.txt",
        ]);
        expect(entries.filter(({ kind }) => kind === "file")
          .sort((a, b) => a.relativePath.localeCompare(b.relativePath))).toEqual([
          { relativePath: "~/extra.txt", kind: "file", size: 5 },
          { relativePath: "~/nested/value.txt", kind: "file", size: 6 },
        ]);
      });

      it(`follows in-root file and directory links to literal tilde paths (${order})`, async () => {
        const directory = await tempRoot("fs-safe-walk-literal-links-");
        const target = path.join(directory, "~");
        await fs.mkdir(target);
        await fs.mkdir(path.join(directory, "links"));
        await fs.writeFile(path.join(target, "extra.txt"), "extra");
        await fs.symlink(target, path.join(directory, "links", "directory"),
          process.platform === "win32" ? "junction" : "dir");
        if (process.platform !== "win32") {
          await fs.symlink(path.join(target, "extra.txt"), path.join(directory, "links", "file"));
        }
        const scoped = await root(directory);

        const entries = await Array.fromAsync(scoped.walk("links", {
          order, symlinkPolicy: "follow-within-root",
        }));
        expect(entries).toContainEqual({
          relativePath: "links/directory/extra.txt", kind: "file", size: 5,
        });
        expect(entries.map(({ relativePath }) => relativePath).sort()).toEqual([
          "links/directory", "links/directory/extra.txt",
          ...(process.platform === "win32" ? [] : ["links/file"]),
        ]);
        if (process.platform !== "win32") {
          expect(entries).toContainEqual({ relativePath: "links/file", kind: "file", size: 5 });
        }
      });

      it(`keeps traversal and outside-link rejection around literal names (${order})`, async () => {
        const directory = await tempRoot("fs-safe-walk-literal-boundary-");
        const inside = path.join(directory, "inside");
        const outside = path.join(directory, "outside");
        await fs.mkdir(path.join(inside, "~"), { recursive: true });
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, "secret.txt"), "outside");
        await fs.symlink(outside, path.join(inside, "~", "escape"),
          process.platform === "win32" ? "junction" : "dir");
        const scoped = await root(inside);
        const options = { order, symlinkPolicy: "follow-within-root" } as const;

        await expect(Array.fromAsync(scoped.walk("../outside", options)))
          .rejects.toThrow(/^Path escapes root walk/);
        await expect(Array.fromAsync(scoped.walk("", options)))
          .rejects.toThrow(/^Symlink escapes root walk/);
        expect(await Array.fromAsync(scoped.walk("", { order, symlinkPolicy: "skip" })))
          .toEqual([{ relativePath: "~", kind: "directory", size: expect.any(Number) }]);
        expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside");
      });
    }
  });
}
