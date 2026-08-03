import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenedFileRealPathForHandle } from "../src/opened-realpath.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

describe("opened file realpath resolution", () => {
  const { tempRoot } = useTempDirs();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function blockDescriptorPathLookups(
    fd: number,
    pathError?: { path: string; code: string },
  ): void {
    const realpath = fs.realpath.bind(fs);
    const descriptorPaths = new Set([`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]);

    vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
      if (descriptorPaths.has(String(target))) {
        throw Object.assign(new Error("descriptor path unavailable"), { code: "ENOENT" });
      }
      if (String(target) === pathError?.path) {
        throw Object.assign(new Error("path lookup failed"), { code: pathError.code });
      }
      return await realpath(target);
    });
  }

  it("falls back to the supplied path when descriptor paths are unavailable", async () => {
    const directory = await tempRoot("fs-safe-opened-realpath-");
    const filePath = path.join(directory, "current.txt");
    await fs.writeFile(filePath, "current", "utf8");
    const handle = await fs.open(filePath, "r");

    try {
      blockDescriptorPathLookups(handle.fd);

      await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).resolves.toBe(
        await fs.realpath(filePath),
      );
    } finally {
      await handle.close();
    }
  });

  it("preserves non-not-found errors from the supplied path", async () => {
    const directory = await tempRoot("fs-safe-opened-realpath-error-");
    const filePath = path.join(directory, "denied.txt");
    await fs.writeFile(filePath, "denied", "utf8");
    const handle = await fs.open(filePath, "r");

    try {
      blockDescriptorPathLookups(handle.fd, { path: filePath, code: "EACCES" });

      await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      await handle.close();
    }
  });

  itPosix("finds a renamed open file by identity in its original parent", async () => {
    const directory = await tempRoot("fs-safe-opened-realpath-renamed-");
    const originalPath = path.join(directory, "before.txt");
    const renamedPath = path.join(directory, "after.txt");
    await fs.writeFile(originalPath, "renamed", "utf8");
    const handle = await fs.open(originalPath, "r");

    try {
      await fs.rename(originalPath, renamedPath);
      blockDescriptorPathLookups(handle.fd);

      await expect(resolveOpenedFileRealPathForHandle(handle, originalPath)).resolves.toBe(
        await fs.realpath(renamedPath),
      );
    } finally {
      await handle.close();
    }
  });

  itPosix("rejects an unlinked open file when no path with its identity remains", async () => {
    const directory = await tempRoot("fs-safe-opened-realpath-unlinked-");
    const filePath = path.join(directory, "unlinked.txt");
    await fs.writeFile(filePath, "unlinked", "utf8");
    const handle = await fs.open(filePath, "r");

    try {
      await fs.unlink(filePath);
      blockDescriptorPathLookups(handle.fd);

      await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).rejects.toMatchObject({
        code: "path-mismatch",
      });
    } finally {
      await handle.close();
    }
  });

  itPosix("rejects cleanly when an opened file and its parent are both removed", async () => {
    const directory = await tempRoot("fs-safe-opened-realpath-removed-parent-");
    const filePath = path.join(directory, "removed.txt");
    await fs.writeFile(filePath, "removed", "utf8");
    const handle = await fs.open(filePath, "r");

    try {
      await fs.unlink(filePath);
      await fs.rmdir(directory);
      blockDescriptorPathLookups(handle.fd);

      await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).rejects.toMatchObject({
        code: "path-mismatch",
      });
    } finally {
      await handle.close();
    }
  });
});
