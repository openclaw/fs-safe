import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movePathWithCopyFallback } from "../src/move-path.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("movePathWithCopyFallback regressions", () => {
  it.runIf(process.platform !== "win32")(
    "does not delete source entries replaced after an EXDEV copy",
    async () => {
      const base = await tempRoot("fs-safe-move-exdev-replaced-source-");
      const source = path.join(base, "source-dir");
      const dest = path.join(base, "dest-dir");
      await fsp.mkdir(source);
      await fsp.writeFile(path.join(source, "copied.txt"), "copied");
      const realRename = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (from === source && to === dest) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await realRename(from, to);
        if (to === dest && String(from).includes(".fs-safe-move-")) {
          await fsp.rm(path.join(source, "copied.txt"));
          await fsp.writeFile(path.join(source, "copied.txt"), "replacement");
          await fsp.writeFile(path.join(source, "late.txt"), "late");
        }
      });

      await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
        code: "ESTALE",
      });

      await expect(fsp.readFile(path.join(dest, "copied.txt"), "utf8")).resolves.toBe("copied");
      await expect(fsp.readFile(path.join(source, "copied.txt"), "utf8")).resolves.toBe(
        "replacement",
      );
      await expect(fsp.readFile(path.join(source, "late.txt"), "utf8")).resolves.toBe("late");
    },
  );

  it.runIf(process.platform !== "win32")(
    "can reject hardlinked files during EXDEV move fallback",
    async () => {
      const base = await tempRoot("fs-safe-move-exdev-hardlink-");
      const source = path.join(base, "source.txt");
      const hardlink = path.join(base, "hardlink.txt");
      const dest = path.join(base, "dest.txt");
      await fsp.writeFile(source, "source");
      await fsp.link(source, hardlink);
      const realRename = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (from === source && to === dest) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        return await realRename(from, to);
      });

      await expect(
        movePathWithCopyFallback({ from: source, sourceHardlinks: "reject", to: dest }),
      ).rejects.toThrow("Refusing to move hardlinked file");

      await expect(fsp.readFile(source, "utf8")).resolves.toBe("source");
      await expect(fsp.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("falls back to copy/remove when rename is denied with EPERM", async () => {
    const base = await tempRoot("fs-safe-move-eperm-");
    const source = path.join(base, "source.txt");
    const dest = path.join(base, "dest.txt");
    await fsp.writeFile(source, "windows lock fallback");

    const realRename = fsp.rename;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("rename denied"), { code: "EPERM" });
      }
      return await realRename(from, to);
    });

    await movePathWithCopyFallback({ from: source, to: dest });

    await expect(fsp.readFile(dest, "utf8")).resolves.toBe("windows lock fallback");
    await expect(fsp.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "preserves directory modes during EXDEV move fallback",
    async () => {
      const base = await tempRoot("fs-safe-move-exdev-dir-mode-");
      const source = path.join(base, "source-dir");
      const dest = path.join(base, "dest-dir");
      await fsp.mkdir(source);
      await fsp.writeFile(path.join(source, "copied.txt"), "copied");
      await fsp.chmod(source, 0o777);
      const realRename = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (from === source && to === dest) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        return await realRename(from, to);
      });
      const realMkdir = fsp.mkdir;
      vi.spyOn(fsp, "mkdir").mockImplementation(async (target, options) => {
        const result = await realMkdir(target, options as never);
        if (String(target).includes(".fs-safe-move-")) {
          await fsp.chmod(target, 0o700);
        }
        return result;
      });

      await movePathWithCopyFallback({ from: source, to: dest });

      expect((await fsp.stat(dest)).mode & 0o777).toBe(0o777);
      await expect(fsp.readFile(path.join(dest, "copied.txt"), "utf8")).resolves.toBe("copied");
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes unchanged copied children when source directory gains a late child",
    async () => {
      const base = await tempRoot("fs-safe-move-exdev-added-source-");
      const source = path.join(base, "source-dir");
      const dest = path.join(base, "dest-dir");
      await fsp.mkdir(source);
      await fsp.writeFile(path.join(source, "copied.txt"), "copied");
      const realRename = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (from === source && to === dest) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await realRename(from, to);
        if (to === dest && String(from).includes(".fs-safe-move-")) {
          await fsp.writeFile(path.join(source, "late.txt"), "late");
        }
      });

      await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
        code: "ESTALE",
      });

      await expect(fsp.readFile(path.join(dest, "copied.txt"), "utf8")).resolves.toBe("copied");
      await expect(fsp.stat(path.join(source, "copied.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fsp.readFile(path.join(source, "late.txt"), "utf8")).resolves.toBe("late");
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not commit bytes from a source swapped after validation",
    async () => {
      const base = await tempRoot("fs-safe-move-exdev-source-swap-");
      const outside = await tempRoot("fs-safe-move-exdev-source-swap-outside-");
      const source = path.join(base, "source.txt");
      const dest = path.join(base, "dest.txt");
      const outsideFile = path.join(outside, "secret.txt");
      await fsp.writeFile(source, "inside");
      await fsp.writeFile(outsideFile, "secret");

      const realRename = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (from === source && to === dest) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        return await realRename(from, to);
      });
      const realLstat = fsp.lstat;
      let swapped = false;
      vi.spyOn(fsp, "lstat").mockImplementation(async (candidate, options) => {
        const stat = await realLstat(candidate, options as never);
        if (!swapped && candidate === source) {
          swapped = true;
          await fsp.rm(source);
          await fsp.symlink(outsideFile, source, "file");
        }
        return stat;
      });

      await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
        code: "ESTALE",
      });
      await expect(fsp.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
