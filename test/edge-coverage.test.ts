import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { FsSafeError } from "../src/errors.js";
import {
  assertSyncDirectoryGuard,
  ensureParentSync,
  writeStreamToTempSource,
} from "../src/file-store-boundary.js";
import {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
  safePathSegmentHashed,
} from "../src/install-path.js";
import { replaceDirectoryAtomic } from "../src/replace-directory.js";
import { root as openRoot } from "../src/root.js";
import {
  isAlreadyExistsError,
  normalizePinnedPathError,
  normalizePinnedWriteError,
  normalizeRemoveGuardError,
  normalizeRemovePathError,
} from "../src/root-errors.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { movePathToTrash } from "../src/trash.js";

const { tempRoot } = useTempDirs();


afterEach(async () => {
  vi.restoreAllMocks();
});

describe("root error helpers", () => {
  it("normalizes existing and unknown low-level errors", () => {
    const existsError = Object.assign(new Error("File exists"), { code: "EEXIST" });
    expect(isAlreadyExistsError(existsError)).toBe(true);
    expect(isAlreadyExistsError("EEXIST: File exists")).toBe(true);
    expect(isAlreadyExistsError(new Error("different"))).toBe(false);

    const fsSafe = new FsSafeError("not-file", "already normalized");
    expect(normalizePinnedWriteError(fsSafe)).toBe(fsSafe);
    expect(normalizePinnedPathError(fsSafe)).toBe(fsSafe);
    expect(normalizePinnedWriteError(new Error("raw"))).toMatchObject({
      code: "invalid-path",
      message: "path is not a regular file under root",
    });
    expect(normalizePinnedWriteError("raw string")).toMatchObject({ code: "invalid-path" });
    expect(normalizePinnedPathError(new Error("raw"))).toMatchObject({
      code: "path-alias",
      message: "path is not under root",
    });
    expect(normalizePinnedPathError("raw string")).toMatchObject({ code: "path-alias" });
  });

  it("maps remove syscall failures without swallowing boundary errors", () => {
    const drift = new FsSafeError("path-mismatch", "directory changed during operation");
    expect(normalizeRemovePathError(drift)).toBe(drift);

    const mappings = [
      ["ENOENT", "not-found"],
      ["ENOTDIR", "not-found"],
      ["ENOTEMPTY", "not-empty"],
      ["EEXIST", "not-empty"],
      ["EACCES", "not-removable"],
      ["EBUSY", "not-removable"],
    ] as const;
    for (const [errno, code] of mappings) {
      const error = Object.assign(new Error(errno), { code: errno });
      expect(normalizeRemovePathError(error)).toMatchObject({ code });
    }

    expect(normalizeRemovePathError(new Error("raw"))).toMatchObject({ code: "path-alias" });
    expect(normalizeRemovePathError("raw string")).toMatchObject({ code: "path-alias" });
  });

  it("keeps guard-stage failures fail-closed instead of reporting a removal outcome", () => {
    const drift = new FsSafeError("path-mismatch", "directory changed during operation");
    expect(normalizeRemoveGuardError(drift)).toBe(drift);

    for (const errno of ["ENOENT", "ENOTDIR"]) {
      const error = Object.assign(new Error(errno), { code: errno });
      expect(normalizeRemoveGuardError(error), errno).toMatchObject({ code: "not-found" });
    }
    for (const errno of ["ELOOP", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"]) {
      const error = Object.assign(new Error(errno), { code: errno });
      expect(normalizeRemoveGuardError(error), errno).toMatchObject({ code: "path-alias" });
    }
    expect(normalizeRemoveGuardError(new Error("raw"))).toMatchObject({ code: "path-alias" });
  });

  it("does not map a guard-stage filesystem failure to a removal code", async () => {
    const rootPath = await tempRoot("fs-safe-remove-guard-");
    const scoped = await openRoot(rootPath);
    await scoped.write("target.txt", "keep");

    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation() {
        throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
      },
    });
    try {
      await expect(scoped.remove("target.txt")).rejects.toMatchObject({ code: "path-alias" });
    } finally {
      __setFsSafeTestHooksForTest(undefined);
    }
    await expect(fs.readFile(path.join(rootPath, "target.txt"), "utf8")).resolves.toBe("keep");
  });
});

describe("directory replacement and file store boundary helpers", () => {
  it("rolls back directory replacement when the staged rename fails", async () => {
    const root = await tempRoot("fs-safe-replace-dir-");
    const target = path.join(root, "target");
    const staged = path.join(root, "staged");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "old.txt"), "old", "utf8");
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, "new.txt"), "new", "utf8");

    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === staged && to === target) {
        throw Object.assign(new Error("boom"), { code: "EACCES" });
      }
      return await realRename(from, to);
    });

    await expect(replaceDirectoryAtomic({ stagedDir: staged, targetDir: target })).rejects
      .toMatchObject({ code: "EACCES" });
    await expect(fs.readFile(path.join(target, "old.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.readFile(path.join(staged, "new.txt"), "utf8")).resolves.toBe("new");
  });

  it("guards sync parents and rejects escapes or swapped directories", async () => {
    const root = await tempRoot("fs-safe-store-boundary-");
    const guard = ensureParentSync({
      rootDir: root,
      filePath: path.join(root, "nested", "file.txt"),
      mode: 0o700,
    });
    expect(path.basename(guard.dir)).toBe("nested");
    expect(() => assertSyncDirectoryGuard(guard)).not.toThrow();
    expect(() => assertSyncDirectoryGuard({ ...guard, realPath: path.join(root, "other") }))
      .toThrow("changed during write");
    expect(() =>
      ensureParentSync({
        rootDir: root,
        filePath: path.join(path.dirname(root), "outside.txt"),
        mode: 0o700,
      }),
    ).toThrow("escapes store root");

    const badRoot = await tempRoot("fs-safe-store-boundary-bad-");
    await fs.writeFile(path.join(badRoot, "file-parent"), "not a dir", "utf8");
    expect(() =>
      ensureParentSync({
        rootDir: badRoot,
        filePath: path.join(badRoot, "file-parent", "child.txt"),
        mode: 0o700,
      }),
    ).toThrow("must be a directory");
  });

  it("stages streams and cleans failed temp sources", async () => {
    const staged = await writeStreamToTempSource({
      stream: Readable.from(["hello"]),
      mode: 0o600,
    });
    try {
      await expect(fs.readFile(staged.path, "utf8")).resolves.toBe("hello");
    } finally {
      await staged.cleanup();
    }
    await expect(fs.stat(path.dirname(staged.path))).rejects.toMatchObject({ code: "ENOENT" });

    await expectFsSafeError(writeStreamToTempSource({
        stream: Readable.from(["123", "456"]),
        maxBytes: 4,
        mode: 0o600,
      }), "too-large");
  });
});

describe("install path edge paths", () => {
  it("covers hashed segment fallbacks and canonical base failures", async () => {
    expect(safePathSegmentHashed(".")).toMatch(/^skill-[a-f0-9]{10}$/);
    expect(safePathSegmentHashed("!!!")).toMatch(/^skill-[a-f0-9]{10}$/);
    expect(safePathSegmentHashed("ok-name")).toBe("ok-name");
    expect(
      resolveSafeInstallDir({
        baseDir: "/tmp/plugins",
        id: "same",
        invalidNameMessage: "bad",
        nameEncoder: () => "",
      }),
    ).toEqual({ ok: false, error: "bad" });

    const root = await tempRoot("fs-safe-install-edge-");
    const realBase = path.join(root, "real-base");
    const linkBase = path.join(root, "link-base");
    await fs.mkdir(realBase);
    await fs.symlink(realBase, linkBase, "dir");
    await expect(
      assertCanonicalPathWithinBase({
        baseDir: linkBase,
        candidatePath: path.join(linkBase, "future.txt"),
        boundaryLabel: "install root",
      }),
    ).resolves.toBeUndefined();

    const baseFile = path.join(root, "base-file");
    await fs.writeFile(baseFile, "not a directory", "utf8");
    await expect(
      assertCanonicalPathWithinBase({
        baseDir: baseFile,
        candidatePath: path.join(baseFile, "future.txt"),
        boundaryLabel: "install root",
      }),
    ).rejects.toThrow("base directory");

    const outside = await tempRoot("fs-safe-install-edge-outside-");
    await fs.symlink(outside, path.join(realBase, "outside-link"), "dir");
    await expect(
      assertCanonicalPathWithinBase({
        baseDir: realBase,
        candidatePath: path.join(realBase, "outside-link", "future.txt"),
        boundaryLabel: "install root",
      }),
    ).rejects.toThrow("within");
  });
});

describe("trash edge paths", () => {
  it("refuses root paths, retries name collisions, and falls back across devices", async () => {
    const root = await tempRoot("fs-safe-trash-extra-");
    const filePath = path.join(root, "retry.txt");
    await fs.writeFile(filePath, "trash", "utf8");
    await expect(movePathToTrash(path.parse(root).root, { allowedRoots: [root] }))
      .rejects
      .toThrow("Refusing to trash root path");

    const realRename = fsSync.renameSync.bind(fsSync);
    let collision = true;
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (from === filePath && collision) {
        collision = false;
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      return realRename(from, to);
    });
    const retriedDest = await movePathToTrash(filePath, { allowedRoots: [root] });
    try {
      expect(path.basename(retriedDest)).toBe("retry.txt");
    } finally {
      await fs.rm(path.dirname(retriedDest), { recursive: true, force: true });
    }

    vi.restoreAllMocks();
    const crossDevice = path.join(root, "cross-device.txt");
    await fs.writeFile(crossDevice, "copy fallback", "utf8");
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (from === crossDevice) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      return realRename(from, to);
    });
    const copiedDest = await movePathToTrash(crossDevice, { allowedRoots: [root] });
    try {
      expect(fsSync.readFileSync(copiedDest, "utf8")).toBe("copy fallback");
      expect(fsSync.existsSync(crossDevice)).toBe(false);
    } finally {
      await fs.rm(path.dirname(copiedDest), { recursive: true, force: true });
    }
  });

  itPosix("moves broken symlinks to trash", async () => {
    const root = await tempRoot("fs-safe-trash-broken-link-");
    const linkPath = path.join(root, "broken-link");
    const missingTarget = path.join(root, "missing-target");
    await fs.symlink(missingTarget, linkPath);

    const dest = await movePathToTrash(linkPath, { allowedRoots: [root] });
    try {
      // Broken links cannot be realpathed; the guard keeps lstat identity and
      // renames the link itself instead of requiring the target to exist.
      await expect(fs.readlink(dest)).resolves.toBe(missingTarget);
      await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(path.dirname(dest), { recursive: true, force: true });
    }
  });
});
