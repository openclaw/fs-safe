import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { root } from "../src/root.js";
import { inheritWriteTargetMode } from "../src/root-write-mode.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

for (const nativeMode of ["auto", "off"] as const) {
  describe.skipIf(process.platform === "win32")(`write mode inheritance (${nativeMode})`, () => {
    it("inherits permissions, honors explicit modes, and defaults new files to 0600", async () => {
      configureFsSafeNative({ mode: nativeMode });
      const directory = await tempRoot("fs-safe-mode-inherit-");
      const safe = await root(directory);
      const target = path.join(directory, "target");
      await fs.writeFile(target, "previous");
      await fs.chmod(target, 0o640);
      await safe.write("target", "inherited");
      expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
      expect(await fs.readFile(target, "utf8")).toBe("inherited");
      await safe.write("target", "explicit", { mode: 0o600 });
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
      await safe.write("new", "default");
      expect((await fs.stat(path.join(directory, "new"))).mode & 0o777).toBe(0o600);
    });

    it.each(["symlink", "dangling symlink", "hardlink", "directory"])("preserves the existing error code for %s", async (kind) => {
      configureFsSafeNative({ mode: nativeMode });
      const directory = await tempRoot("fs-safe-mode-alias-");
      const source = path.join(directory, "source");
      const target = path.join(directory, "target");
      await fs.writeFile(source, "original");
      if (kind === "symlink") await fs.symlink(source, target);
      else if (kind === "dangling symlink") await fs.symlink(path.join(directory, "missing"), target);
      else if (kind === "hardlink") await fs.link(source, target);
      else await fs.mkdir(target);
      const safe = await root(directory);
      await expect(safe.write("target", "replacement")).rejects.toMatchObject({
        code: kind === "directory" ? "not-file" : "path-alias",
      });
      expect(await fs.readFile(source, "utf8")).toBe("original");
    });

    it.each([false, true])("rejects mode inheritance through a raced parent (restored: %s)", async (restoreParent) => {
      configureFsSafeNative({ mode: nativeMode });
      const directory = await tempRoot("fs-safe-inherit-parent-");
      const outside = await tempRoot("fs-safe-inherit-outside-");
      const safe = await root(directory);
      const parent = path.join(safe.rootReal, "parent");
      const saved = path.join(safe.rootReal, "saved");
      const target = path.join(parent, "target");
      await fs.mkdir(parent);
      await fs.writeFile(target, "original", { mode: 0o600 });
      await fs.writeFile(path.join(outside, "target"), "outside");
      await fs.chmod(path.join(outside, "target"), 0o666);
      const lstat = fs.lstat.bind(fs);
      let attacked = false;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (String(args[0]) === target && args[1]?.bigint && !attacked) {
          attacked = true;
          await fs.rename(parent, saved);
          await fs.symlink(outside, parent);
          const observed = await lstat(...args);
          if (restoreParent) {
            await fs.unlink(parent);
            await fs.rename(saved, parent);
          }
          return observed;
        }
        return await lstat(...args);
      });
      await expect(safe.write("parent/target", "sensitive")).rejects.toMatchObject({
        code: restoreParent ? "path-mismatch" : "outside-workspace",
      });
      expect(attacked).toBe(true);
      const original = path.join(restoreParent ? parent : saved, "target");
      expect((await fs.stat(original)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(original, "utf8")).toBe("original");
      expect(await fs.readFile(path.join(outside, "target"), "utf8")).toBe("outside");
    });
  });
}

it.each(["Windows ACL", "effective credentials"])("keeps read-open admission for %s", async (scenario) => {
  const directory = await tempRoot("fs-safe-inherit-access-");
  const safe = await root(directory);
  const targetPath = path.join(safe.rootReal, "target");
  await fs.writeFile(targetPath, "original");
  const denied = Object.assign(new Error("read denied"), { code: "EACCES" });
  const access = vi.spyOn(fs, "access").mockResolvedValue();
  const open = vi.spyOn(fs, "open").mockRejectedValue(denied);
  if (scenario === "Windows ACL" || !process.geteuid) {
    Object.defineProperty(process, "platform", { value: "win32" });
  } else {
    vi.spyOn(process, "geteuid").mockReturnValue(process.getuid!() + 1);
  }
  await expect(inheritWriteTargetMode({ targetPath, rootWithSep: safe.rootReal + path.sep })).rejects.toBe(denied);
  expect(open).toHaveBeenCalledTimes(1);
  expect(access).not.toHaveBeenCalled();
});
