import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  movePathWithCopyFallback,
  replaceDirectoryAtomic,
  replaceFileAtomic,
  replaceFileAtomicSync,
} from "../src/atomic.js";
import { writeExternalFileWithinRoot } from "../src/output.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
});

describe("atomic publication stress regressions", () => {
  it("keeps an async copy-fallback temp registered when immediate cleanup fails", async () => {
    const root = await tempRoot("fs-safe-atomic-cleanup-async-");
    const target = path.join(root, "target.txt");
    let tempPath = "";
    let cleanupAttempts = 0;

    const result = await replaceFileAtomic({
      filePath: target,
      content: "replacement",
      copyFallbackOnPermissionError: true,
      beforeRename: async ({ tempPath: candidate }) => {
        tempPath = candidate;
      },
      fileSystem: {
        promises: {
          ...fs,
          rename: async () => {
            throw Object.assign(new Error("rename denied"), { code: "EPERM" });
          },
          unlink: async (candidate) => {
            if (candidate === tempPath) {
              throw Object.assign(new Error("temp busy"), { code: "EBUSY" });
            }
            await fs.unlink(candidate);
          },
          rm: async (candidate, options) => {
            if (candidate === tempPath && cleanupAttempts++ === 0) {
              throw Object.assign(new Error("temp busy"), { code: "EBUSY" });
            }
            await fs.rm(candidate, options);
          },
        },
      },
    });

    expect(result).toEqual({ method: "copy-fallback" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    await expect(fs.stat(tempPath)).resolves.toBeTruthy();

    __cleanupRegisteredTempPathsForTest();

    await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a synchronous copy-fallback temp registered when immediate cleanup fails", async () => {
    const root = await tempRoot("fs-safe-atomic-cleanup-sync-");
    const target = path.join(root, "target.txt");
    let tempPath = "";
    let cleanupAttempts = 0;

    const result = replaceFileAtomicSync({
      filePath: target,
      content: "replacement",
      copyFallbackOnPermissionError: true,
      beforeRename: ({ tempPath: candidate }) => {
        tempPath = candidate;
      },
      fileSystem: {
        ...fsSync,
        renameSync: () => {
          throw Object.assign(new Error("rename denied"), { code: "EPERM" });
        },
        unlinkSync: (candidate) => {
          if (candidate === tempPath) {
            throw Object.assign(new Error("temp busy"), { code: "EBUSY" });
          }
          fsSync.unlinkSync(candidate);
        },
        rmSync: (candidate, options) => {
          if (candidate === tempPath && cleanupAttempts++ === 0) {
            throw Object.assign(new Error("temp busy"), { code: "EBUSY" });
          }
          fsSync.rmSync(candidate, options);
        },
      },
    });

    expect(result).toEqual({ method: "copy-fallback" });
    expect(fsSync.readFileSync(target, "utf8")).toBe("replacement");
    expect(fsSync.statSync(tempPath).isFile()).toBe(true);

    __cleanupRegisteredTempPathsForTest();

    expect(() => fsSync.statSync(tempPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("serializes concurrent directory replacements for one target", async () => {
    const root = await tempRoot("fs-safe-atomic-directory-queue-");
    const target = path.join(root, "target");
    const stagedA = path.join(root, "staged-a");
    const stagedB = path.join(root, "staged-b");
    await Promise.all([target, stagedA, stagedB].map((directory) => fs.mkdir(directory)));
    await fs.writeFile(path.join(target, "value.txt"), "original");
    await fs.writeFile(path.join(stagedA, "value.txt"), "a");
    await fs.writeFile(path.join(stagedB, "value.txt"), "b");

    const realRename = fs.rename.bind(fs);
    let firstBackupMoved!: () => void;
    const firstMoved = new Promise<void>((resolve) => {
      firstBackupMoved = resolve;
    });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (from === target && String(to).includes("backup-a")) {
        firstBackupMoved();
        await firstRelease;
      }
    });

    const first = replaceDirectoryAtomic({
      stagedDir: stagedA,
      targetDir: target,
      backupPrefix: "backup-a-",
    });
    await firstMoved;
    const second = replaceDirectoryAtomic({
      stagedDir: stagedB,
      targetDir: target,
      backupPrefix: "backup-b-",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(fs.readFile(path.join(target, "value.txt"), "utf8")).resolves.toBe("b");
    expect((await fs.readdir(root)).filter((entry) => entry.includes("backup"))).toEqual([]);
  });

  it("rejects directory backup prefixes that can escape the target parent", async () => {
    const root = await tempRoot("fs-safe-atomic-directory-prefix-");
    const parent = path.join(root, "parent");
    const target = path.join(parent, "target");
    const staged = path.join(parent, "staged");
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(staged);
    await fs.writeFile(path.join(target, "value.txt"), "original");
    await fs.writeFile(path.join(staged, "value.txt"), "replacement");

    await expect(replaceDirectoryAtomic({
      stagedDir: staged,
      targetDir: target,
      backupPrefix: "../escaped-",
    })).rejects.toMatchObject({ code: "invalid-path" });

    await expect(fs.readFile(path.join(target, "value.txt"), "utf8")).resolves.toBe("original");
    await expect(fs.readFile(path.join(staged, "value.txt"), "utf8")).resolves.toBe("replacement");
  });

  it("keeps a failed sibling output temp registered when immediate cleanup fails", async () => {
    const root = await tempRoot("fs-safe-output-cleanup-");
    let tempPath = "";
    let cleanupAttempts = 0;
    const realRename = fs.rename.bind(fs);
    const realRm = fs.rm.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === tempPath) {
        throw Object.assign(new Error("publish denied"), { code: "EACCES" });
      }
      await realRename(from, to);
    });
    vi.spyOn(fs, "rm").mockImplementation(async (candidate, options) => {
      if (candidate === tempPath && cleanupAttempts++ === 0) {
        throw Object.assign(new Error("temp busy"), { code: "EBUSY" });
      }
      await realRm(candidate, options);
    });

    await expect(writeExternalFileWithinRoot({
      rootDir: root,
      path: "output.txt",
      staging: "sibling",
      write: async (candidate) => {
        tempPath = candidate;
        await fs.writeFile(candidate, "partial");
      },
    })).rejects.toMatchObject({ code: "EACCES" });
    await expect(fs.stat(tempPath)).resolves.toBeTruthy();

    __cleanupRegisteredTempPathsForTest();

    await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a failed EXDEV move stage registered when immediate cleanup fails", async () => {
    const root = await tempRoot("fs-safe-move-cleanup-");
    const source = path.join(root, "source.txt");
    const target = path.join(root, "target.txt");
    await fs.writeFile(source, "source");
    let stagedPath = "";
    let cleanupAttempts = 0;
    const realRename = fs.rename.bind(fs);
    const realRm = fs.rm.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === source && to === target) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      if (String(from).includes(".fs-safe-move-") && to === target) {
        stagedPath = String(from);
        throw Object.assign(new Error("publish denied"), { code: "EACCES" });
      }
      await realRename(from, to);
    });
    vi.spyOn(fs, "rm").mockImplementation(async (candidate, options) => {
      if (candidate === stagedPath && cleanupAttempts++ === 0) {
        throw Object.assign(new Error("stage busy"), { code: "EBUSY" });
      }
      await realRm(candidate, options);
    });

    await expect(movePathWithCopyFallback({ from: source, to: target }))
      .rejects.toMatchObject({ code: "EACCES" });
    await expect(fs.readFile(source, "utf8")).resolves.toBe("source");
    await expect(fs.stat(stagedPath)).resolves.toBeTruthy();

    __cleanupRegisteredTempPathsForTest();

    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("does not publish an EXDEV file stage whose descriptor mode application failed", async () => {
    const root = await tempRoot("fs-safe-move-mode-failure-");
    const source = path.join(root, "source.txt");
    const target = path.join(root, "target.txt");
    await fs.writeFile(source, "source");
    await fs.chmod(source, 0o640);
    const probe = await fs.open(path.join(root, "probe.txt"), "w");
    const handlePrototype = Object.getPrototypeOf(probe) as {
      chmod(mode: number): Promise<void>;
    };
    await probe.close();
    await fs.rm(path.join(root, "probe.txt"));
    vi.spyOn(handlePrototype, "chmod").mockRejectedValue(
      Object.assign(new Error("mode denied"), { code: "EIO" }),
    );

    await expect(movePathWithCopyFallback({
      from: source,
      sourceHardlinks: "reject",
      to: target,
    })).rejects.toMatchObject({ code: "EIO" });

    await expect(fs.readFile(source, "utf8")).resolves.toBe("source");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(root)).filter((entry) => entry.startsWith(".fs-safe-move-")))
      .toEqual([]);
  });
});
