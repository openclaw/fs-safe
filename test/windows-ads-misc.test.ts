import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
  safePathSegmentHashed,
} from "../src/install-path.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import { inspectPathPermissions, inspectWindowsAcl, safeStat } from "../src/permissions.js";
import { createPrivateDirectory } from "../src/private-directory.js";
import { movePathToTrash } from "../src/trash.js";
import { assertNoHardlinkedFinalPath } from "../src/path-policy.js";
import { itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
});

describe("Windows namespace-alias admission for miscellaneous path APIs", () => {
  itWin32("rejects trash target and allowed-root aliases before moving anything", async () => {
    const root = await tempRoot("fs-safe-ads-trash-");
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const target = path.join(root, "target.txt");
    const stream = `${target}:payload`;
    await fs.writeFile(target, "base", "utf8");
    await fs.writeFile(stream, "hidden", "utf8");

    await expect(movePathToTrash(stream, { allowedRoots: [root] })).rejects.toThrow(
      "Windows filesystem namespace alias",
    );
    await expect(fs.readFile(target, "utf8")).resolves.toBe("base");
    await expect(fs.readFile(stream, "utf8")).resolves.toBe("hidden");
    await expect(fs.stat(path.join(root, ".Trash"))).rejects.toMatchObject({ code: "ENOENT" });

    const lstat = vi.spyOn(fsSync, "lstatSync");
    await expect(movePathToTrash(target, { allowedRoots: [`${root}:payload`] }))
      .rejects.toThrow("Windows filesystem namespace alias");
    expect(lstat).not.toHaveBeenCalled();
  });

  itWin32("rejects a transformed trash target before creating a destination", async () => {
    const root = await tempRoot("fs-safe-ads-trash-realpath-");
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const target = path.join(root, "target.txt");
    await fs.writeFile(target, "base", "utf8");
    const realpath = fsSync.realpathSync.native;
    vi.spyOn(fsSync.realpathSync, "native").mockImplementation((candidate, options) => {
      if (path.resolve(String(candidate)) === target) return `${target}:payload`;
      return realpath(candidate, options as never);
    });

    await expect(movePathToTrash(target, { allowedRoots: [root] })).rejects.toThrow(
      "Windows filesystem namespace alias",
    );
    await expect(fs.readFile(target, "utf8")).resolves.toBe("base");
    await expect(fs.stat(path.join(root, ".Trash"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itWin32("keeps install encoders intentional while rejecting path-like colon output", async () => {
    const root = await tempRoot("fs-safe-ads-install-");
    const invalidNameMessage = "invalid package";
    expect(resolveSafeInstallDir({
      baseDir: `${root}:payload`,
      id: "safe",
      invalidNameMessage,
    })).toEqual({ ok: false, error: invalidNameMessage });
    expect(resolveSafeInstallDir({
      baseDir: root,
      id: "package:payload",
      invalidNameMessage,
    })).toEqual({ ok: false, error: invalidNameMessage });

    const sanitized = resolveSafeInstallDir({
      baseDir: root,
      id: "package:payload",
      invalidNameMessage,
      nameEncoder: safePathSegmentHashed,
    });
    expect(sanitized).toMatchObject({ ok: true });
    if (!sanitized.ok) throw new Error("expected a sanitized install path");
    expect(path.basename(sanitized.path)).toMatch(/^package-payload-[a-f0-9]{10}$/u);

    const lstat = vi.spyOn(fsSync, "lstatSync");
    await expect(assertCanonicalPathWithinBase({
      baseDir: root,
      candidatePath: `${path.join(root, "candidate")}:payload`,
      boundaryLabel: "install directory",
    })).rejects.toThrow("Invalid path: must stay within install directory");
    expect(lstat).not.toHaveBeenCalled();
  });

  itWin32("rejects canonical install aliases returned by realpath", async () => {
    const root = await tempRoot("fs-safe-ads-install-realpath-");
    const candidate = path.join(root, "candidate");
    await fs.mkdir(candidate);
    vi.spyOn(fsSync.realpathSync, "native").mockReturnValueOnce(`${root}:payload`);

    await expect(assertCanonicalPathWithinBase({
      baseDir: root,
      candidatePath: candidate,
      boundaryLabel: "install directory",
    })).rejects.toThrow("Invalid path: must stay within install directory");
  });

  itWin32("returns permission failure results without stat, shell, or native calls", async () => {
    const root = await tempRoot("fs-safe-ads-permissions-");
    const target = `${path.join(root, "secret.txt")}:payload`;
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const exec = vi.fn();
    const readOwnerAndDaclNative = vi.fn();
    const createPrivateDirectoryNative = vi.fn();
    __setNativeLoaderForTest(() => ({
      readOwnerAndDacl: readOwnerAndDaclNative,
      createPrivateDirectory: createPrivateDirectoryNative,
    }) as unknown as NativeBinding);

    await expect(safeStat(target)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Windows filesystem namespace alias"),
    });
    await expect(inspectPathPermissions(target, { platform: "win32", exec })).resolves
      .toMatchObject({
        ok: false,
        source: "unknown",
        error: expect.stringContaining("Windows filesystem namespace alias"),
      });
    await expect(inspectWindowsAcl(target, { exec })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Windows filesystem namespace alias"),
    });
    await expect(createPrivateDirectory(target, { platform: "win32" })).rejects
      .toMatchObject({ code: "invalid-path" });
    expect(() => readOwnerAndDacl(target)).toThrow(expect.objectContaining({
      code: "invalid-path",
    }));
    expect(lstat).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(readOwnerAndDaclNative).not.toHaveBeenCalled();
    expect(createPrivateDirectoryNative).not.toHaveBeenCalled();
  });

  itWin32("rejects hardlink-guard aliases before stat while preserving unlink bypass", async () => {
    const alias = "C:\\root\\file:hidden";
    const stat = vi.spyOn(fsSync, "statSync");
    await expect(assertNoHardlinkedFinalPath({
      filePath: alias,
      root: "C:\\root",
      boundaryLabel: "root",
    })).rejects.toMatchObject({ code: "invalid-path" });
    expect(stat).not.toHaveBeenCalled();

    await expect(assertNoHardlinkedFinalPath({
      filePath: alias,
      root: "C:\\root",
      boundaryLabel: "root",
      allowFinalHardlinkForUnlink: true,
    })).resolves.toBeUndefined();
    expect(stat).not.toHaveBeenCalled();
  });

  it("preserves unsupported-platform precedence for native permission helpers", async () => {
    await expect(createPrivateDirectory("file:payload", { platform: "linux" })).rejects
      .toMatchObject({ code: "helper-unavailable" });
    if (process.platform !== "win32") {
      expect(readOwnerAndDacl("file:payload")).toEqual({
        status: "unsupported-platform",
        platform: process.platform,
      });
    }
  });
});

itPosix("preserves legal POSIX colon paths across install, trash, and permissions", async () => {
  const root = await tempRoot("fs-safe-posix-colon-misc-");
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const baseDir = path.join(root, "packages:stable");
  const target = path.join(baseDir, "package:payload");
  await fs.mkdir(baseDir);
  await fs.writeFile(target, "content", "utf8");

  expect(resolveSafeInstallDir({
    baseDir,
    id: "package:payload",
    invalidNameMessage: "invalid package",
  })).toEqual({ ok: true, path: target });
  await expect(assertCanonicalPathWithinBase({
    baseDir,
    candidatePath: target,
    boundaryLabel: "install directory",
  })).resolves.toBeUndefined();
  await expect(safeStat(target)).resolves.toMatchObject({ ok: true });
  await expect(inspectPathPermissions(target)).resolves.toMatchObject({
    ok: true,
    source: "posix",
  });

  const destination = await movePathToTrash(target, { allowedRoots: [root] });
  await expect(fs.readFile(destination, "utf8")).resolves.toBe("content");
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});
