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

  async function withOpenedFile(
    prefix: string,
    name: string,
    run: (fixture: {
      directory: string;
      filePath: string;
      handle: Awaited<ReturnType<typeof fs.open>>;
    }) => Promise<void>,
  ): Promise<void> {
    const directory = await tempRoot(prefix);
    const filePath = path.join(directory, name);
    await fs.writeFile(filePath, name, "utf8");
    const handle = await fs.open(filePath, "r");
    try {
      await run({ directory, filePath, handle });
    } finally {
      await handle.close();
    }
  }

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
    await withOpenedFile("fs-safe-opened-realpath-", "current.txt", async ({ filePath, handle }) => {
      blockDescriptorPathLookups(handle.fd);
      await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).resolves.toBe(
        await fs.realpath(filePath),
      );
    });
  });

  it("preserves non-not-found errors from the supplied path", async () => {
    await withOpenedFile("fs-safe-opened-realpath-error-", "denied.txt", async ({ filePath, handle }) => {
      blockDescriptorPathLookups(handle.fd, { path: filePath, code: "EACCES" });
      await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).rejects.toMatchObject({
        code: "EACCES",
      });
    });
  });

  itPosix("finds a renamed open file by identity in its original parent", async () => {
    await withOpenedFile("fs-safe-opened-realpath-renamed-", "before.txt", async ({
      directory,
      filePath,
      handle,
    }) => {
      const renamedPath = path.join(directory, "after.txt");
      await fs.rename(filePath, renamedPath);
      blockDescriptorPathLookups(handle.fd);
      await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).resolves.toBe(
        await fs.realpath(renamedPath),
      );
    });
  });

  itPosix("rejects an unlinked open file when no path with its identity remains", async () => {
    await withOpenedFile("fs-safe-opened-realpath-unlinked-", "unlinked.txt", async ({ filePath, handle }) => {
      await fs.unlink(filePath);
      blockDescriptorPathLookups(handle.fd);
      await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).rejects.toMatchObject({
        code: "path-mismatch",
      });
    });
  });

  itPosix("rejects cleanly when an opened file and its parent are both removed", async () => {
    await withOpenedFile("fs-safe-opened-realpath-removed-parent-", "removed.txt", async ({
      directory,
      filePath,
      handle,
    }) => {
      await fs.unlink(filePath);
      await fs.rmdir(directory);
      blockDescriptorPathLookups(handle.fd);
      await expect(resolveOpenedFileRealPathForHandle(handle, filePath)).rejects.toMatchObject({
        code: "path-mismatch",
      });
    });
  });
});
