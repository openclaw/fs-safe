import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import * as cleanup from "../src/temp-cleanup.js";
import { tempFile, withTempFile } from "../src/temp-target.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function cleanupBinding(rootDir: string) {
  const renameNoReplace = vi.fn<NonNullable<NativeBinding["renameNoReplace"]>>(
    (_sourceParentFd, sourceName, _destinationParentFd, destinationName) => {
      fsSync.renameSync(path.join(rootDir, sourceName), path.join(rootDir, destinationName));
    },
  );
  const removeOwnedTree = vi.fn<NonNullable<NativeBinding["removeOwnedTree"]>>(
    async (_parentFd, name) => {
      fsSync.rmSync(path.join(rootDir, name), { recursive: true, force: true });
      return { outcome: "removed" };
    },
  );
  const removeOwnedTreeSync = vi.fn<NonNullable<NativeBinding["removeOwnedTreeSync"]>>(
    (_parentFd, name) => {
      fsSync.rmSync(path.join(rootDir, name), { recursive: true, force: true });
      return { outcome: "removed" };
    },
  );
  const ownedTreeRemovalAvailable = vi.fn(() => true);
  return { closeOwnedFd: vi.fn(), renameNoReplace, removeOwnedTree, removeOwnedTreeSync, ownedTreeRemovalAvailable };
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe("temp file cleanup capability", () => {
  it.each([undefined, "compatible" as const])(
    "keeps %s cleanup on the legacy path without loading native support",
    async (cleanupSafety) => {
      const rootDir = await tempRoot("fs-safe-temp-file-compatible-");
      configureFsSafeNative({ mode: "require" });
      const loader = vi.fn(() => { throw new Error("must not load"); });
      __setNativeLoaderForTest(loader);
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      const target = await tempFile({ rootDir, prefix: "download", cleanupSafety });
      const registration = register.mock.calls[0];
      expect(registration?.[0]).toBe(target.dir);
      expect(registration?.[1]).toMatchObject({ recursive: true });
      expect(registration?.[1]).toHaveProperty("identity");
      expect(registration?.[1]).not.toHaveProperty("cleanupSync");
      expect(loader).not.toHaveBeenCalled();
      expect(await target.cleanup()).toBeUndefined();
    },
  );

  it.each(["tempFile", "withTempFile"] as const)(
    "rejects invalid cleanupSafety before filesystem mutation through %s",
    async (variant) => {
      const base = await tempRoot("fs-safe-temp-file-invalid-");
      const rootDir = path.join(base, "missing-root");
      const mkdtemp = vi.spyOn(fs, "mkdtemp");
      const run = vi.fn();
      const options = { rootDir, prefix: "download", cleanupSafety: "unexpected" as never };
      const operation = variant === "tempFile"
        ? tempFile(options)
        : withTempFile(options, async () => run());
      await expect(operation).rejects.toThrow("cleanupSafety must be compatible or require-bounded");
      expect(mkdtemp).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      await expect(fs.lstat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["tempFile", "withTempFile"] as const)(
    "rejects require-bounded before child creation through %s when cleanup is unavailable",
    async (variant) => {
      const rootDir = await tempRoot("fs-safe-temp-file-unavailable-");
      configureFsSafeNative({ mode: "auto" });
      const binding = {
        closeOwnedFd: vi.fn(),
        renameNoReplace: vi.fn(),
        removeOwnedTree: vi.fn(),
        removeOwnedTreeSync: vi.fn(),
        ownedTreeRemovalAvailable: vi.fn(() => false),
      };
      __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
      const mkdtemp = vi.spyOn(fs, "mkdtemp");
      const run = vi.fn();
      const options = { rootDir, prefix: "download", cleanupSafety: "require-bounded" as const };
      const operation = variant === "tempFile"
        ? tempFile(options)
        : withTempFile(options, async () => run());
      await expect(operation).rejects.toMatchObject({
        name: "FsSafeError",
        code: "helper-unavailable",
      });
      expect(mkdtemp).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(binding.ownedTreeRemovalAvailable).toHaveBeenCalledTimes(1);
      expect(await fs.readdir(rootDir)).toEqual([]);
    },
  );

  it.each([
    ["tempFile", "getter"],
    ["tempFile", "value"],
    ["withTempFile", "getter"],
    ["withTempFile", "value"],
  ] as const)(
    "%s rejects an invalid initial fileName %s before retaining resources",
    async (variant, failureKind) => {
      const rootDir = await tempRoot("fs-safe-temp-file-name-admission-");
      configureFsSafeNative({ mode: "auto" });
      __setNativeLoaderForTest(() => cleanupBinding(rootDir) as unknown as NativeBinding);
      const open = vi.spyOn(fsSync, "openSync");
      const mkdtemp = vi.spyOn(fs, "mkdtemp");
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      const run = vi.fn();
      const failure = new Error("initial filename getter failed");
      const options = {
        rootDir,
        prefix: "download",
        cleanupSafety: "require-bounded" as const,
        get fileName(): string {
          if (failureKind === "getter") throw failure;
          return 42 as unknown as string;
        },
      };
      const operation = variant === "tempFile"
        ? tempFile(options)
        : withTempFile(options, async () => run());
      if (failureKind === "getter") await expect(operation).rejects.toBe(failure);
      else await expect(operation).rejects.toBeInstanceOf(TypeError);
      expect(open).not.toHaveBeenCalled();
      expect(mkdtemp).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(await fs.readdir(rootDir)).toEqual([]);
    },
  );

  it("uses one bounded owner for async and process-exit cleanup", async () => {
    const rootDir = await tempRoot("fs-safe-temp-file-bounded-");
    configureFsSafeNative({ mode: "auto" });
    const binding = cleanupBinding(rootDir);
    __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    const target = await tempFile({
      rootDir,
      prefix: "download",
      cleanupSafety: "require-bounded",
    });
    expect(Object.keys(register.mock.calls[0]?.[1] ?? {})).toEqual(["cleanupSync"]);
    expect(target[Symbol.asyncDispose]).toBe(target.cleanup);
    await fs.mkdir(path.join(target.dir, "nested"));
    await fs.writeFile(path.join(target.dir, "nested", "owned.txt"), "owned");
    const pathnameRm = vi.spyOn(fs, "rm");
    expect(await target.cleanup()).toBeUndefined();
    expect(pathnameRm).not.toHaveBeenCalled();
    expect(binding.removeOwnedTree).toHaveBeenCalledTimes(1);
    expect(binding.removeOwnedTreeSync).not.toHaveBeenCalled();

    const exitTarget = await tempFile({
      rootDir,
      prefix: "exit",
      cleanupSafety: "require-bounded",
    });
    await fs.writeFile(exitTarget.path, "owned");
    cleanup.__cleanupRegisteredTempPathForTest(exitTarget.dir);
    expect(binding.removeOwnedTreeSync).toHaveBeenCalledTimes(1);
    expect(await exitTarget.cleanup()).toBeUndefined();
    expect(binding.removeOwnedTree).toHaveBeenCalledTimes(1);
  });

  it("uses bounded cleanup after a scoped callback", async () => {
    const rootDir = await tempRoot("fs-safe-temp-file-bounded-scoped-");
    configureFsSafeNative({ mode: "auto" });
    const binding = cleanupBinding(rootDir);
    __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
    let callbackPath = "";
    const result = await withTempFile({
      rootDir,
      prefix: "download",
      cleanupSafety: "require-bounded",
    }, async (tempPath) => {
      callbackPath = tempPath;
      await fs.writeFile(tempPath, "owned");
      return "done";
    });
    expect(result).toBe("done");
    expect(binding.removeOwnedTree).toHaveBeenCalledTimes(1);
    await expect(fs.lstat(path.dirname(callbackPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports bounded cleanup failures through onCleanupError and still resolves void", async () => {
    const rootDir = await tempRoot("fs-safe-temp-file-cleanup-error-");
    configureFsSafeNative({ mode: "auto" });
    const binding = cleanupBinding(rootDir);
    const failure = { errorCode: "EACCES", errorMessage: "injected removal denial" };
    binding.removeOwnedTree.mockResolvedValue(failure);
    __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
    const onCleanupError = vi.fn();
    const target = await tempFile({
      rootDir,
      prefix: "download",
      cleanupSafety: "require-bounded",
      onCleanupError,
    });
    expect(await target.cleanup()).toBeUndefined();
    expect(onCleanupError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "EACCES" }),
    );
    expect(await target.cleanup()).toBeUndefined();
    expect(onCleanupError).toHaveBeenCalledTimes(1);

    const callbackFailure = new Error("cleanup observer failed");
    const throwingTarget = await tempFile({
      rootDir,
      prefix: "throwing",
      cleanupSafety: "require-bounded",
      onCleanupError: () => { throw callbackFailure; },
    });
    await expect(throwingTarget.cleanup()).rejects.toBe(callbackFailure);
  });

  it("closes retained parent and child descriptors when final child admission fstat throws", async () => {
    const rootDir = await tempRoot("fs-safe-temp-file-owner-admission-");
    configureFsSafeNative({ mode: "auto" });
    const binding = cleanupBinding(rootDir);
    __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
    const actualOpen = fsSync.openSync.bind(fsSync);
    const actualFstat = fsSync.fstatSync.bind(fsSync);
    let childFd: number | undefined;
    const opened: number[] = [];
    vi.spyOn(fsSync, "openSync").mockImplementation((name, ...args) => {
      const fd = actualOpen(name, ...args);
      opened.push(fd);
      if (typeof name === "string" && path.dirname(name) === rootDir) childFd = fd;
      return fd;
    });
    const failure = Object.assign(new Error("injected owner fstat failure"), { code: "EIO" });
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, ...args) => {
      if (fd === childFd) throw failure;
      return actualFstat(fd, ...args);
    });
    await expect(tempFile({
      rootDir,
      prefix: "download",
      cleanupSafety: "require-bounded",
    })).rejects.toBe(failure);
    expect(opened.length).toBeGreaterThanOrEqual(2);
    for (const fd of opened) {
      expect(() => actualFstat(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
    }
  });
});
