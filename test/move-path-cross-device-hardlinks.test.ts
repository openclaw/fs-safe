import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { movePathWithCopyFallback } from "../src/move-path.js";

const hasLinuxSharedMemory = process.platform === "linux" && fsSync.existsSync("/dev/shm");

describe.runIf(hasLinuxSharedMemory)("real cross-device hardlink retirement", () => {
  it.each([
    ["default", undefined],
    ["allow", "allow"],
  ] as const)("retires every in-tree alias with sourceHardlinks=%s", async (_label, policy) => {
    const sourceRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-hardlink-source-")),
    );
    const targetRoot = await fs.realpath(
      await fs.mkdtemp(path.join("/dev/shm", "fs-safe-hardlink-target-")),
    );
    try {
      expect((await fs.stat(sourceRoot)).dev).not.toBe((await fs.stat(targetRoot)).dev);
      const source = path.join(sourceRoot, "source");
      const target = path.join(targetRoot, "target");
      const first = path.join(source, "a.txt");
      const second = path.join(source, "b.txt");
      const nested = path.join(source, "nested");
      const third = path.join(nested, "c.txt");
      const external = path.join(sourceRoot, "external.txt");
      await fs.mkdir(source);
      await fs.mkdir(nested);
      await fs.writeFile(first, "shared");
      await fs.link(first, second);
      await fs.link(first, third);
      await fs.link(first, external);

      await movePathWithCopyFallback({
        from: source,
        ...(policy ? { sourceHardlinks: policy } : {}),
        to: target,
      });

      await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(target, "a.txt"), "utf8")).resolves.toBe(
        "shared",
      );
      await expect(fs.readFile(path.join(target, "b.txt"), "utf8")).resolves.toBe(
        "shared",
      );
      await expect(
        fs.readFile(path.join(target, "nested", "c.txt"), "utf8"),
      ).resolves.toBe("shared");
      await expect(fs.readFile(external, "utf8")).resolves.toBe("shared");
      expect((await fs.stat(external)).nlink).toBe(1);
    } finally {
      await Promise.all([
        fs.rm(sourceRoot, { force: true, recursive: true }),
        fs.rm(targetRoot, { force: true, recursive: true }),
      ]);
    }
  });
});
