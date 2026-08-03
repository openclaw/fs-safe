import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { ensureAbsoluteDirectory } from "../src/absolute-path.js";

const { tempRoot } = useTempDirs();


afterEach(async () => {
  vi.restoreAllMocks();
});

describe("ensureAbsoluteDirectory", () => {
  it("safely creates missing absolute directory parents from a real ancestor", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-dir-"));
    const targetDir = path.join(root, "nested", "deeper");

    await expect(
      ensureAbsoluteDirectory(targetDir, { scopeLabel: "output directory", mode: 0o700 }),
    ).resolves.toEqual({ ok: true, path: targetDir });
    expect((await fs.stat(targetDir)).isDirectory()).toBe(true);
  });

  it("rejects relative absolute-directory inputs", async () => {
    await expect(
      ensureAbsoluteDirectory(path.join("..", "..", "..", "escape"), {
        scopeLabel: "output directory",
      }),
    ).resolves.toMatchObject({ ok: false, code: "invalid-path" });
  });

  it("rejects absolute directory creation when the existing target is not a directory", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-dir-file-"));
    const targetPath = path.join(root, "file.txt");
    await fs.writeFile(targetPath, "file", "utf8");

    await expect(
      ensureAbsoluteDirectory(targetPath, { scopeLabel: "output directory" }),
    ).resolves.toMatchObject({ ok: false, code: "not-file" });
  });

  itPosix("rejects absolute directory creation through symlinked existing segments", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-dir-link-"));
    const outside = await fs.realpath(await tempRoot("fs-safe-absolute-dir-outside-"));
    const linkDir = path.join(root, "link");
    await fs.symlink(outside, linkDir);

    await expect(
      ensureAbsoluteDirectory(path.join(linkDir, "nested"), {
        scopeLabel: "output directory",
      }),
    ).resolves.toMatchObject({ ok: false, code: "symlink" });
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  itPosix("rejects symlinked parents even when the requested suffix already exists", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-dir-link-existing-"));
    const outside = await fs.realpath(
      await tempRoot("fs-safe-absolute-dir-link-existing-outside-"),
    );
    const existing = path.join(outside, "existing");
    const linkDir = path.join(root, "link");
    await fs.mkdir(existing);
    await fs.symlink(outside, linkDir);

    await expect(
      ensureAbsoluteDirectory(path.join(linkDir, "existing", "new"), {
        scopeLabel: "output directory",
      }),
    ).resolves.toMatchObject({ ok: false, code: "symlink" });
    await expect(fs.stat(path.join(existing, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a policy failure when an intermediate component is a file", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-dir-file-component-"));
    const filePath = path.join(root, "file");
    await fs.writeFile(filePath, "file", "utf8");

    await expect(
      ensureAbsoluteDirectory(path.join(filePath, "child"), {
        scopeLabel: "output directory",
      }),
    ).resolves.toMatchObject({ ok: false, code: "not-file" });
  });

  itPosix("rejects absolute directory creation when an existing parent is swapped before mkdir", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-dir-race-"));
    const outside = await fs.realpath(await tempRoot("fs-safe-absolute-dir-race-outside-"));
    const parentDir = path.join(root, "parent");
    const targetDir = path.join(parentDir, "child");
    await fs.mkdir(parentDir);

    const realLstat = fs.lstat.bind(fs);
    let swapped = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const candidate = String(args[0]);
      if (!swapped && candidate === targetDir) {
        swapped = true;
        await fs.rename(parentDir, `${parentDir}-real`);
        await fs.symlink(outside, parentDir, "dir");
      }
      return await realLstat(...args);
    });

    try {
      await expect(
        ensureAbsoluteDirectory(targetDir, { scopeLabel: "output directory" }),
      ).resolves.toMatchObject({ ok: false, code: "symlink" });
    } finally {
      lstatSpy.mockRestore();
    }

    await expect(fs.stat(path.join(outside, "child"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("rejects absolute directory creation when the existing target changes before return", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-dir-target-race-"));
    const outside = await fs.realpath(
      await tempRoot("fs-safe-absolute-dir-target-race-outside-"),
    );
    const targetDir = path.join(root, "target");
    await fs.mkdir(targetDir);

    const realRealpath = fs.realpath.bind(fs);
    let swapped = false;
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      const candidate = String(args[0]);
      if (!swapped && candidate === targetDir) {
        swapped = true;
        const resolved = await realRealpath(...args);
        await fs.rename(targetDir, `${targetDir}-real`);
        await fs.symlink(outside, targetDir, "dir");
        return resolved;
      }
      return await realRealpath(...args);
    });

    try {
      await expect(
        ensureAbsoluteDirectory(targetDir, { scopeLabel: "output directory" }),
      ).resolves.toMatchObject({ ok: false, code: "symlink" });
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("rethrows operational absolute directory creation failures", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-dir-io-"));
    const targetDir = path.join(root, "nested");
    const realMkdir = fs.mkdir.bind(fs);
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      if (String(args[0]) === targetDir) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return await realMkdir(...args);
    });

    try {
      await expect(
        ensureAbsoluteDirectory(targetDir, { scopeLabel: "output directory" }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});
