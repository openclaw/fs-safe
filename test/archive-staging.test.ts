import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { itPosix } from "./helpers/vitest.js";
import {
  ArchiveSecurityError,
  createArchiveSymlinkTraversalError,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  withStagedArchiveDestination,
} from "../src/archive-staging.js";
import { isPathInside } from "../src/path.js";

const directorySymlinkType = process.platform === "win32" ? "junction" : undefined;
const tempDirs = new Set<string>();

async function withTempDir<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(root);
  try {
    return await run(root);
  } finally {
    tempDirs.delete(root);
    await fs.rm(root, { recursive: true, force: true });
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("archive-staging helpers", () => {
  it("accepts real destination directories and returns their real path", async () => {
    await withTempDir("fs-safe-archive-staging-", async (rootDir) => {
      const destDir = path.join(rootDir, "dest");
      await fs.mkdir(destDir, { recursive: true });

      await expect(prepareArchiveDestinationDir(destDir)).resolves.toBe(await fs.realpath(destDir));
    });
  });

  itPosix("rejects symlink and non-directory archive destinations", async () => {
    await withTempDir("fs-safe-archive-staging-", async (rootDir) => {
      const realDestDir = path.join(rootDir, "real-dest");
      const symlinkDestDir = path.join(rootDir, "dest-link");
      const fileDest = path.join(rootDir, "dest.txt");
      await fs.mkdir(realDestDir, { recursive: true });
      await fs.symlink(realDestDir, symlinkDestDir, directorySymlinkType);
      await fs.writeFile(fileDest, "nope", "utf8");

      await expect(prepareArchiveDestinationDir(symlinkDestDir)).rejects.toMatchObject({
        code: "destination-symlink",
      } satisfies Partial<ArchiveSecurityError>);
      await expect(prepareArchiveDestinationDir(fileDest)).rejects.toMatchObject({
        code: "destination-not-directory",
      } satisfies Partial<ArchiveSecurityError>);
    });
  });

  it("creates in-destination parent directories for file outputs", async () => {
    await withTempDir("fs-safe-archive-staging-", async (rootDir) => {
      const destDir = path.join(rootDir, "dest");
      await fs.mkdir(destDir, { recursive: true });
      const destinationRealDir = await prepareArchiveDestinationDir(destDir);
      const outPath = path.join(destDir, "nested", "payload.txt");

      await expect(
        prepareArchiveOutputPath({
          destinationDir: destDir,
          destinationRealDir,
          relPath: "nested/payload.txt",
          outPath,
          originalPath: "nested/payload.txt",
          isDirectory: false,
        }),
      ).resolves.toBeUndefined();

      await expect(fs.stat(path.dirname(outPath))).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    });
  });

  itPosix("rejects output paths that traverse a destination symlink", async () => {
    await withTempDir("fs-safe-archive-staging-", async (rootDir) => {
      const destDir = path.join(rootDir, "dest");
      const outsideDir = path.join(rootDir, "outside");
      const linkDir = path.join(destDir, "escape");
      await fs.mkdir(destDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, linkDir, directorySymlinkType);
      const destinationRealDir = await prepareArchiveDestinationDir(destDir);

      await expect(
        prepareArchiveOutputPath({
          destinationDir: destDir,
          destinationRealDir,
          relPath: "escape/payload.txt",
          outPath: path.join(linkDir, "payload.txt"),
          originalPath: "escape/payload.txt",
          isDirectory: false,
        }),
      ).rejects.toMatchObject({
        code: "destination-symlink-traversal",
      } satisfies Partial<ArchiveSecurityError>);
    });
  });

  it("cleans up staged archive directories after success and failure", async () => {
    await withTempDir("fs-safe-archive-staging-", async (rootDir) => {
      const destDir = path.join(rootDir, "dest");
      await fs.mkdir(destDir, { recursive: true });
      const destinationRealDir = await prepareArchiveDestinationDir(destDir);
      let successStage = "";

      await withStagedArchiveDestination({
        destinationRealDir,
        run: async (stagingDir) => {
          successStage = stagingDir;
          expect(isPathInside(destinationRealDir, stagingDir)).toBe(false);
          await fs.writeFile(path.join(stagingDir, "payload.txt"), "ok", "utf8");
        },
      });
      await expect(fs.stat(successStage)).rejects.toMatchObject({ code: "ENOENT" });

      let failureStage = "";
      await expect(
        withStagedArchiveDestination({
          destinationRealDir,
          run: async (stagingDir) => {
            failureStage = stagingDir;
            expect(isPathInside(destinationRealDir, stagingDir)).toBe(false);
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow("boom");
      await expect(fs.stat(failureStage)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects archive staging prefixes that escape the temp root", async () => {
    await withTempDir("fs-safe-archive-staging-prefix-", async (rootDir) => {
      const destDir = path.join(rootDir, "dest");
      await fs.mkdir(destDir, { recursive: true });
      const destinationRealDir = await prepareArchiveDestinationDir(destDir);
      let called = false;

      await expect(
        withStagedArchiveDestination({
          destinationRealDir,
          stagingDirPrefix: "../escape-",
          run: async () => {
            called = true;
          },
        }),
      ).rejects.toThrow("archive staging prefix must be a single path segment");

      expect(called).toBe(false);
    });
  });

  itPosix("merges staged trees and rejects symlink entries from the source", async () => {
    await withTempDir("fs-safe-archive-staging-", async (rootDir) => {
      const sourceDir = path.join(rootDir, "source");
      const sourceNestedDir = path.join(sourceDir, "nested");
      const destDir = path.join(rootDir, "dest");
      const outsideDir = path.join(rootDir, "outside");
      await fs.mkdir(sourceNestedDir, { recursive: true });
      await fs.mkdir(destDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(sourceNestedDir, "payload.txt"), "hi", "utf8");

      const destinationRealDir = await prepareArchiveDestinationDir(destDir);
      await mergeExtractedTreeIntoDestination({
        sourceDir,
        destinationDir: destDir,
        destinationRealDir,
      });
      await expect(
        fs.readFile(path.join(destDir, "nested", "payload.txt"), "utf8"),
      ).resolves.toBe("hi");

      await fs.symlink(outsideDir, path.join(sourceDir, "escape"), directorySymlinkType);
      await expect(
        mergeExtractedTreeIntoDestination({
          sourceDir,
          destinationDir: destDir,
          destinationRealDir,
        }),
      ).rejects.toMatchObject({
        code: "destination-symlink-traversal",
      } satisfies Partial<ArchiveSecurityError>);
    });
  });

  itPosix("reports dangling staged symlinks as archive security errors", async () => {
    await withTempDir("fs-safe-archive-staging-dangling-", async (rootDir) => {
      const sourceDir = path.join(rootDir, "source");
      const destDir = path.join(rootDir, "dest");
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.mkdir(destDir, { recursive: true });
      await fs.symlink(path.join(rootDir, "missing"), path.join(sourceDir, "dangling"));

      await expect(
        mergeExtractedTreeIntoDestination({
          sourceDir,
          destinationDir: destDir,
          destinationRealDir: await prepareArchiveDestinationDir(destDir),
        }),
      ).rejects.toMatchObject({
        code: "destination-symlink-traversal",
      } satisfies Partial<ArchiveSecurityError>);
    });
  });

  it("builds a typed archive symlink traversal error", () => {
    const error = createArchiveSymlinkTraversalError("nested/payload.txt");
    expect(error).toBeInstanceOf(ArchiveSecurityError);
    expect(error.code).toBe("destination-symlink-traversal");
    expect(error.message).toContain("nested/payload.txt");
  });
});
