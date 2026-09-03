import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movePathWithCopyFallback } from "../src/move-path.js";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectMovedDanglingLink(source: string, target: string): Promise<void> {
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readlink(target)).resolves.toBe("absent-referent");
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("dangling symlink move fallback", () => {
  itPosix("moves the link itself through the forced staged route", async () => {
    const root = await tempRoot("fs-safe-move-dangling-staged-");
    const source = path.join(root, "source-link");
    const target = path.join(root, "target-link");
    await fs.symlink("absent-referent", source, "file");

    await movePathWithCopyFallback({
      from: source,
      sourceHardlinks: "reject",
      to: target,
    });

    await expectMovedDanglingLink(source, target);
  });

  itPosix("moves the link itself after an EXDEV rename failure", async () => {
    const root = await tempRoot("fs-safe-move-dangling-exdev-");
    const source = path.join(root, "source-link");
    const target = path.join(root, "target-link");
    await fs.symlink("absent-referent", source, "file");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === source && to === target) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      await rename(from, to);
    });

    await movePathWithCopyFallback({ from: source, to: target });

    await expectMovedDanglingLink(source, target);
  });

  itPosix("still rejects the same entry through an aliased parent", async () => {
    const root = await tempRoot("fs-safe-move-dangling-same-entry-");
    const realParent = path.join(root, "real");
    const aliasParent = path.join(root, "alias");
    const realPath = path.join(realParent, "source-link");
    await fs.mkdir(realParent);
    await fs.symlink(realParent, aliasParent, "dir");
    await fs.symlink("absent-referent", realPath, "file");

    await expectFsSafeError(
      movePathWithCopyFallback({
        from: path.join(aliasParent, "source-link"),
        sourceHardlinks: "reject",
        to: realPath,
      }),
      "invalid-path",
    );
    await expect(fs.readlink(realPath)).resolves.toBe("absent-referent");
  });
});

const hasLinuxSharedMemory = process.platform === "linux" && fsSync.existsSync("/dev/shm");

describe.runIf(hasLinuxSharedMemory)("real cross-device dangling symlink move", () => {
  it("moves the link without dereferencing its absent referent", async () => {
    const sourceRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-dangling-source-")),
    );
    const targetRoot = await fs.realpath(
      await fs.mkdtemp(path.join("/dev/shm", "fs-safe-dangling-target-")),
    );
    try {
      expect((await fs.stat(sourceRoot)).dev).not.toBe((await fs.stat(targetRoot)).dev);
      const source = path.join(sourceRoot, "source-link");
      const target = path.join(targetRoot, "target-link");
      await fs.symlink("absent-referent", source, "file");

      await movePathWithCopyFallback({ from: source, to: target });

      await expectMovedDanglingLink(source, target);
    } finally {
      await Promise.all([
        fs.rm(sourceRoot, { force: true, recursive: true }),
        fs.rm(targetRoot, { force: true, recursive: true }),
      ]);
    }
  });
});
