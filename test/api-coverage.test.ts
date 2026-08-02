import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive } from "../src/archive.js";
import { loadZipArchiveWithPreflight, readZipCentralDirectoryEntryCount } from "../src/archive-zip-preflight.js";
import { createAsyncLock } from "../src/async-lock.js";
import { writeTextAtomic } from "../src/atomic.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
} from "../src/install-path.js";
import {
  readJson,
  readJsonIfExists,
  readJsonSync,
  tryReadJson,
  tryReadJsonSync,
  writeJson,
  writeJsonSync,
} from "../src/json.js";
import { jsonStore } from "../src/json-store.js";
import {
  assertNoWindowsNetworkPath,
  basenameFromMediaSource,
  hasEncodedFileUrlSeparator,
  isWindowsDriveLetterPath,
  safeFileURLToPath,
  trySafeFileURLToPath,
} from "../src/local-file-access.js";
import { resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import { movePathWithCopyFallback } from "../src/move-path.js";
import {
  assertNoNulPathInput,
  hasNodeErrorCode,
  isNotFoundPathError,
  isPathInside,
  isPathInsideWithRealpath,
  isSymlinkOpenError,
  normalizeWindowsPathForComparison,
  resolveSafeBaseDir,
  resolveSafeRelativePath,
  safeRealpathSync,
  safeStatSync,
  splitSafeRelativePath,
} from "../src/path.js";
import { assertNoHardlinkedFinalPath, assertNoPathAliasEscape } from "../src/path-policy.js";
import { ROOT_PATH_ALIAS_POLICIES, resolveRootPath, resolveRootPathSync } from "../src/root-path.js";
import {
  ensureDirectoryWithinRoot,
  pathScope,
  resolveExistingPathsWithinRoot,
  resolvePathsWithinRoot,
  resolvePathWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
} from "../src/root-paths.js";
import { replaceDirectoryAtomic } from "../src/replace-directory.js";
import { openLocalFileSafely, readLocalFileSafely, root as openRoot } from "../src/root.js";
import {
  readSecretFileSync,
  tryReadSecretFileSync,
  writeSecretFileAtomic,
} from "../src/secret-file.js";
import { resolveSecureTempRoot } from "../src/secure-temp-dir.js";
import { assertNoSymlinkParents, assertNoSymlinkParentsSync } from "../src/symlink-parents.js";
import {
  appendRegularFile,
  appendRegularFileSync,
  readRegularFile,
  readRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFile,
  statRegularFileSync,
} from "../src/regular-file.js";
import {
  buildRandomTempFilePath,
  sanitizeTempFileName,
  tempFile,
  withTempFile,
} from "../src/temp-target.js";
import {
  tempWorkspace,
  tempWorkspaceSync,
  withTempWorkspace,
  withTempWorkspaceSync,
} from "../src/private-temp-workspace.js";
import { withTimeout } from "../src/timing.js";

const tempDirs = new Set<string>();

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("root handle coverage", () => {
  it("covers root reads, absolute reads, append newline logic, and writable handles", async () => {
    const rootDir = await tempRoot("fs-safe-root-api-");
    const scoped = await openRoot(rootDir, { mkdir: true, mode: 0o640 });

    await expect(scoped.resolve("nested/file.txt")).resolves.toBe(
      path.join(await fs.realpath(rootDir), "nested/file.txt"),
    );
    await scoped.ensureRoot();
    await scoped.write("nested/file.txt", "alpha");
    await scoped.append("nested/file.txt", "beta", { prependNewlineIfNeeded: true });
    await scoped.append("nested/file.txt", Buffer.from("gamma"), { prependNewlineIfNeeded: true });
    await expect(fs.readFile(path.join(rootDir, "nested/file.txt"), "utf8")).resolves.toBe(
      "alpha\nbeta\ngamma",
    );

    const absolute = path.join(rootDir, "nested/file.txt");
    await expect(scoped.readAbsolute(absolute)).resolves.toMatchObject({
      realPath: await fs.realpath(absolute),
    });
    await expect(scoped.reader()(absolute)).resolves.toEqual(Buffer.from("alpha\nbeta\ngamma"));
    await expect(scoped.readText("nested/file.txt", { encoding: "utf8" })).resolves.toBe(
      "alpha\nbeta\ngamma",
    );

    const writable = await scoped.openWritable("nested/file.txt", { writeMode: "update" });
    try {
      expect(writable.createdForWrite).toBe(false);
      await writable.handle.appendFile("!");
    } finally {
      await writable.handle.close();
    }
    const appended = await scoped.openWritable("nested/file.txt", { writeMode: "append" });
    try {
      await appended.handle.appendFile("?");
    } finally {
      await appended[Symbol.asyncDispose]();
    }
    const truncated = await scoped.openWritable("nested/file.txt");
    try {
      await truncated.handle.writeFile("reset");
    } finally {
      await truncated.handle.close();
    }
    await expect(scoped.readText("nested/file.txt", { encoding: "utf8" })).resolves.toBe("reset");
  });

  it("covers root copy, create, JSON, missing, and type rejection paths", async () => {
    const rootDir = await tempRoot("fs-safe-root-copy-");
    const sourceDir = await tempRoot("fs-safe-root-source-");
    const source = path.join(sourceDir, "source.txt");
    await fs.writeFile(source, "copy me", "utf8");
    const scoped = await openRoot(rootDir);

    await scoped.copyIn("copied/source.txt", source, { maxBytes: 16, mode: 0o600 });
    await expect(scoped.readText("copied/source.txt")).resolves.toBe("copy me");
    await expect(scoped.copyIn("too-large.txt", source, { maxBytes: 3 })).rejects.toMatchObject({
      code: "too-large",
    });
    await expect(scoped.copyIn("bad.txt", sourceDir)).rejects.toMatchObject({ code: "not-file" });

    await scoped.writeJson("json/state.json", { ok: true }, { trailingNewline: false });
    await expect(scoped.readJson("json/state.json")).resolves.toEqual({ ok: true });
    await scoped.createJson("json/new.json", { value: 1 }, { space: 0 });
    await expect(scoped.create("json/new.json", "again")).rejects.toMatchObject({
      code: "already-exists",
    });
    await expect(scoped.read("missing.txt")).rejects.toMatchObject({ code: "not-found" });
    await expect(scoped.open("json")).rejects.toMatchObject({ code: "not-file" });
    await expect(scoped.mkdir(".")).rejects.toMatchObject({ code: "outside-workspace" });
  });

  it.runIf(process.platform !== "win32")("covers root symlink, hardlink, local read, and writable rejection paths", async () => {
    const rootDir = await tempRoot("fs-safe-root-errors-");
    const outside = await tempRoot("fs-safe-root-errors-outside-");
    const scoped = await openRoot(rootDir);
    const inside = path.join(rootDir, "inside.txt");
    const linkInside = path.join(rootDir, "inside-link.txt");
    const hardlink = path.join(rootDir, "inside-hardlink.txt");
    await fs.writeFile(inside, "inside", "utf8");
    await fs.symlink(inside, linkInside);

    await expect(scoped.readText("inside-link.txt", { symlinks: "follow-within-root" })).resolves
      .toBe("inside");
    await fs.link(inside, hardlink);
    await expect(scoped.open("inside-hardlink.txt")).rejects.toMatchObject({ code: "hardlink" });
    const hardlinkOpen = await scoped.open("inside-hardlink.txt", { hardlinks: "allow" });
    expect(hardlinkOpen.realPath).toBe(await fs.realpath(hardlink));
    await hardlinkOpen.handle.close();
    await expect(scoped.copyIn("copied-hardlink.txt", hardlink)).resolves.toBeUndefined();
    await expect(scoped.copyIn("copied-hardlink.txt", hardlink, { sourceHardlinks: "allow" }))
      .resolves
      .toBeUndefined();
    await expect(readLocalFileSafely({ filePath: inside, maxBytes: 16 })).resolves.toMatchObject({
      realPath: await fs.realpath(inside),
    });
    const opened = await openLocalFileSafely({ filePath: inside });
    await opened[Symbol.asyncDispose]();

    await fs.mkdir(path.join(rootDir, "dir"));
    await expect(scoped.openWritable("dir")).rejects.toMatchObject({ code: "not-file" });
    await expect(scoped.openWritable("inside-hardlink.txt")).rejects.toMatchObject({
      code: "path-alias",
    });
    await expect(scoped.openWritable("inside-link.txt")).rejects.toMatchObject({
      code: "path-alias",
    });

    const outsideFile = path.join(outside, "outside.txt");
    await fs.writeFile(outsideFile, "outside", "utf8");
    await fs.symlink(outsideFile, path.join(rootDir, "outside-link.txt"));
    await expect(scoped.openWritable("outside-link.txt")).rejects.toMatchObject({
      code: "path-alias",
    });
  });
});

describe("path helpers", () => {
  it("covers Windows and POSIX path decisions", async () => {
    const root = await tempRoot("fs-safe-path-");
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "ok", "utf8");
    const cache = new Map<string, string>();

    expect(normalizeWindowsPathForComparison("\\\\?\\UNC\\Server\\Share\\A/../B")).toContain(
      "\\\\server\\share",
    );
    expect(hasNodeErrorCode(Object.assign(new Error("x"), { code: "ENOENT" }), "ENOENT")).toBe(
      true,
    );
    expect(isNotFoundPathError(Object.assign(new Error("x"), { code: "ENOTDIR" }))).toBe(true);
    expect(isSymlinkOpenError(Object.assign(new Error("x"), { code: "ELOOP" }))).toBe(true);
    expect(isPathInside(root, file)).toBe(true);
    expect(resolveSafeBaseDir(root)).toBe(`${path.resolve(root)}${path.sep}`);
    // Use the sync realpath to compare against safeRealpathSync. On windows
    // fs.realpathSync and fs.realpath (async) sometimes disagree on 8.3
    // short-name canonicalization (e.g. "RUNNER~1" vs "runneradmin").
    expect(safeRealpathSync(file, cache)).toBe(realpathSync(file));
    expect(safeRealpathSync(file, cache)).toBe(realpathSync(file));
    expect(safeRealpathSync(path.join(root, "missing"), cache)).toBeNull();
    expect(isPathInsideWithRealpath(root, file, { cache })).toBe(true);
    expect(isPathInsideWithRealpath(root, path.join(root, "missing"), { requireRealpath: false }))
      .toBe(true);
    expect(isPathInsideWithRealpath(root, path.join(root, "missing"))).toBe(false);
    expect(safeStatSync(file)?.isFile()).toBe(true);
    expect(safeStatSync(path.join(root, "missing"))).toBeNull();
    expect(() => assertNoNulPathInput("a\0b")).toThrow("NUL");
    expect(splitSafeRelativePath("./a//b")).toEqual(["a", "b"]);
    for (const bad of ["../x", "/x", "C:\\x", "C:evil", "C:..", "a/C:b", "a\\b", "a\0b"]) {
      expect(() => splitSafeRelativePath(bad)).toThrow();
    }
    expect(resolveSafeRelativePath(root, "a/b")).toBe(path.join(root, "a", "b"));
  });
});

describe("root path resolution helpers", () => {
  it.runIf(process.platform !== "win32")("covers canonical aliases and final symlink policies", async () => {
    const base = await tempRoot("fs-safe-root-path-extra-");
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(root, "file.txt"), "ok", "utf8");
    await fs.symlink(root, path.join(outside, "root-link"));
    await fs.symlink(path.join(root, "file.txt"), path.join(root, "file-link"));

    await expect(
      resolveRootPath({
        rootPath: root,
        absolutePath: path.join(outside, "root-link", "file.txt"),
        boundaryLabel: "root",
      }),
    ).resolves.toMatchObject({
      exists: true,
      kind: "file",
      relativePath: "file.txt",
    });
    await expect(
      resolveRootPathSync({
        rootPath: root,
        absolutePath: path.join(root, "missing", "later.txt"),
        boundaryLabel: "root",
      }),
    ).toMatchObject({
      exists: false,
      kind: "missing",
      relativePath: path.join("missing", "later.txt"),
    });
    await expect(
      resolveRootPath({
        rootPath: root,
        absolutePath: path.join(root, "file-link"),
        boundaryLabel: "root",
        policy: ROOT_PATH_ALIAS_POLICIES.unlinkTarget,
      }),
    ).resolves.toMatchObject({
      exists: true,
      kind: "symlink",
      relativePath: "file-link",
    });
    await expect(
      resolveRootPath({
        rootPath: root,
        absolutePath: path.join(base, "escape.txt"),
        boundaryLabel: "root",
      }),
    ).rejects.toThrow("escapes");
  });

  it("covers root path list, writable, existing, and scoped wrappers", async () => {
    const base = await tempRoot("fs-safe-root-paths-extra-");
    const root = path.join(base, "root");
    await fs.mkdir(root);
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "ok", "utf8");
    await fs.mkdir(path.join(root, "dir"));

    expect(
      resolvePathWithinRoot({
        rootDir: root,
        requestedPath: " ",
        scopeLabel: "uploads",
      }),
    ).toEqual({ ok: false, error: "path is required" });
    expect(
      resolvePathWithinRoot({
        rootDir: root,
        requestedPath: " ",
        defaultFileName: "default.txt",
        scopeLabel: "uploads",
      }),
    ).toEqual({ ok: true, path: path.join(root, "default.txt") });
    expect(
      resolvePathsWithinRoot({
        rootDir: root,
        requestedPaths: ["file.txt", "../escape.txt"],
        scopeLabel: "uploads",
      }),
    ).toMatchObject({ ok: false });
    await expect(
      resolveWritablePathWithinRoot({
        rootDir: file,
        requestedPath: "new.txt",
        scopeLabel: "uploads",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      resolveWritablePathWithinRoot({
        rootDir: root,
        requestedPath: "dir",
        scopeLabel: "uploads",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      ensureDirectoryWithinRoot({
        rootDir: root,
        requestedPath: "made/nested",
        scopeLabel: "uploads",
        mode: 0o700,
      }),
    ).resolves.toMatchObject({ ok: true, path: path.join(root, "made", "nested") });
    await expect(
      ensureDirectoryWithinRoot({
        rootDir: root,
        requestedPath: "file.txt",
        scopeLabel: "uploads",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      resolveExistingPathsWithinRoot({
        rootDir: path.join(base, "missing-root"),
        requestedPaths: ["missing.txt"],
        scopeLabel: "uploads",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      resolveStrictExistingPathsWithinRoot({
        rootDir: root,
        requestedPaths: ["dir"],
        scopeLabel: "uploads",
      }),
    ).resolves.toMatchObject({ ok: false });

    const scope = pathScope(root, { label: "uploads" });
    expect(scope.resolve(" ", { defaultName: "fallback.txt" })).toEqual({
      ok: true,
      path: path.join(root, "fallback.txt"),
    });
    expect(scope.resolveAll(["file.txt"])).toEqual({ ok: true, paths: [file] });
    await expect(scope.existing(["missing.txt"])).resolves.toEqual({
      ok: true,
      paths: [path.join(root, "missing.txt")],
    });
    await expect(scope.ensureDir("scoped")).resolves.toMatchObject({
      ok: true,
      path: path.join(root, "scoped"),
    });
  });
});

describe("URL, install, and local-root helpers", () => {
  it("covers local file URL parsing and install path sanitizers", async () => {
    const root = await tempRoot("fs-safe-install-");
    const file = path.join(root, "hello world.txt");
    await fs.writeFile(file, "ok", "utf8");
    const fileUrl = new URL(`file://${file}`).href;

    expect(hasEncodedFileUrlSeparator("file:///tmp/a%2Fb")).toBe(true);
    expect(safeFileURLToPath(fileUrl)).toBe(file);
    expect(trySafeFileURLToPath("https://example.com/file")).toBeUndefined();
    expect(basenameFromMediaSource(fileUrl)).toBe("hello world.txt");
    expect(basenameFromMediaSource("plain/name.txt")).toBe("name.txt");
    expect(() => safeFileURLToPath("file://remote/share/file.txt")).toThrow("remote hosts");
    expect(isWindowsDriveLetterPath("C:\\Users\\demo", "win32")).toBe(true);
    expect(isWindowsDriveLetterPath("C:\\Users\\demo", "linux")).toBe(false);
    if (process.platform === "win32") {
      expect(() => assertNoWindowsNetworkPath("\\\\server\\share", "Media")).toThrow();
    } else {
      expect(() => assertNoWindowsNetworkPath("\\\\server\\share", "Media")).not.toThrow();
    }

    expect(safeDirName(" bad/name? ")).toBe("bad__name?");
    expect(safePathSegmentHashed("x".repeat(200))).toHaveLength(61);
    expect(
      resolveSafeInstallDir({
        baseDir: root,
        id: "../Plugin Name",
        invalidNameMessage: "bad plugin",
      }),
    ).toMatchObject({ ok: true, path: path.join(root, "..__Plugin Name") });
    await expect(
      assertCanonicalPathWithinBase({
        baseDir: root,
        candidatePath: path.join(root, "new-file.txt"),
        boundaryLabel: "install root",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCanonicalPathWithinBase({
        baseDir: root,
        candidatePath: path.dirname(root),
        boundaryLabel: "install root",
      }),
    ).rejects.toThrow("within");

    expect(
      resolveLocalPathFromRootsSync({
        filePath: fileUrl,
        roots: [new URL(`file://${root}`).href],
        label: "media roots",
        requireFile: true,
      }),
    ).toMatchObject({ path: realpathSync(file) });
    expect(() =>
      resolveLocalPathFromRootsSync({
        filePath: "bad\0path",
        roots: [root],
        label: "media roots",
      }),
    ).toThrow("NUL");
  });
});

describe("ZIP preflight", () => {
  it("counts central directory entries and enforces archive limits", async () => {
    const zip = new JSZip();
    zip.file("a.txt", "a");
    zip.file("b.txt", "b");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    expect(readZipCentralDirectoryEntryCount(buffer)).toBe(2);
    expect(readZipCentralDirectoryEntryCount(Buffer.from("not a zip"))).toBeNull();
    await expect(loadZipArchiveWithPreflight(buffer, { maxEntries: 1 })).rejects.toMatchObject({
      code: "archive-entry-count-exceeds-limit",
    });
    await expect(loadZipArchiveWithPreflight(buffer, { maxArchiveBytes: 4 })).rejects.toMatchObject({
      code: "archive-size-exceeds-limit",
    });
    await expect(loadZipArchiveWithPreflight(buffer, { maxEntries: 3 })).resolves.toBeInstanceOf(
      JSZip,
    );
  });

  it("handles non-Buffer zip views and malformed central directory metadata", async () => {
    const emptyZip = new JSZip();
    const emptyBuffer = await emptyZip.generateAsync({ type: "nodebuffer" });
    expect(readZipCentralDirectoryEntryCount(new Uint8Array(emptyBuffer))).toBe(0);

    const zip = new JSZip();
    zip.file("commented.txt", "ok");
    zip.comment = "hello";
    const commented = await zip.generateAsync({ type: "nodebuffer" });
    expect(readZipCentralDirectoryEntryCount(commented)).toBe(1);

    const malformed = Buffer.from(commented);
    const eocdOffset = malformed.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocdOffset).toBeGreaterThanOrEqual(0);
    malformed.writeUInt32LE(0xffffffff, eocdOffset + 12);
    malformed.writeUInt32LE(0xffffffff, eocdOffset + 16);
    expect(readZipCentralDirectoryEntryCount(malformed)).toBe(1);
  });
});

describe("move fallback helper", () => {
  it("renames on the same filesystem and falls back to copy/remove on EXDEV", async () => {
    const root = await tempRoot("fs-safe-move-extra-");
    const from = path.join(root, "from.txt");
    const renamed = path.join(root, "renamed.txt");
    await fs.writeFile(from, "rename", "utf8");
    await movePathWithCopyFallback({ from, to: renamed });
    await expect(fs.readFile(renamed, "utf8")).resolves.toBe("rename");
    await expect(fs.stat(from)).rejects.toMatchObject({ code: "ENOENT" });

    const crossDeviceFrom = path.join(root, "cross-device.txt");
    const crossDeviceTo = path.join(root, "copied.txt");
    await fs.writeFile(crossDeviceFrom, "copy", "utf8");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, dest) => {
      if (source === crossDeviceFrom && dest === crossDeviceTo) {
        const error = new Error("cross device") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      }
      return await originalRename(source, dest);
    });

    try {
      await movePathWithCopyFallback({ from: crossDeviceFrom, to: crossDeviceTo });
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.readFile(crossDeviceTo, "utf8")).resolves.toBe("copy");
    await expect(fs.stat(crossDeviceFrom)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("archive extraction", () => {
  it("extracts tar archives and enforces tar limits", async () => {
    const root = await tempRoot("fs-safe-tar-");
    const packageDir = path.join(root, "package");
    const archivePath = path.join(root, "pkg.tar");
    const destDir = path.join(root, "dest");
    await fs.mkdir(path.join(packageDir, "nested"), { recursive: true });
    await fs.mkdir(destDir);
    await fs.writeFile(path.join(packageDir, "nested", "file.txt"), "tar data", "utf8");
    await tar.c({ cwd: root, file: archivePath }, ["package"]);

    await extractArchive({
      archivePath,
      destDir,
      kind: "tar",
      stripComponents: 1,
      timeoutMs: 15_000,
      limits: { maxEntries: 8, maxExtractedBytes: 1024, maxEntryBytes: 1024 },
    });
    await expect(fs.readFile(path.join(destDir, "nested", "file.txt"), "utf8")).resolves.toBe(
      "tar data",
    );
    const smallDest = path.join(root, "small");
    await fs.mkdir(smallDest);
    await expect(
      extractArchive({
        archivePath,
        destDir: smallDest,
        kind: "tar",
        timeoutMs: 15_000,
        limits: { maxArchiveBytes: 4 },
      }),
    ).rejects.toMatchObject({ code: "archive-size-exceeds-limit" });
    await expect(
      extractArchive({
        archivePath: path.join(root, "pkg.txt"),
        destDir,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("unsupported archive");
  });
});

describe("JSON and regular-file helpers", () => {
  it("covers JSON success, parse, read, and lock behavior", async () => {
    const root = await tempRoot("fs-safe-json-extra-");
    const file = path.join(root, "state", "value.json");
    await writeJson(file, { ok: true }, { trailingNewline: true });
    await expect(readJson(file)).resolves.toEqual({ ok: true });
    await expect(readJsonIfExists(path.join(root, "missing.json"))).resolves.toBeNull();
    await expect(tryReadJson(file)).resolves.toEqual({ ok: true });
    await fs.writeFile(file, "{bad", "utf8");
    await expect(readJson(file)).rejects.toMatchObject({ reason: "parse" });
    await expect(readJson(path.join(root, "missing.json"))).rejects.toMatchObject({
      reason: "read",
    });
    await expect(readJsonIfExists(file)).rejects.toMatchObject({ reason: "parse" });
    await expect(tryReadJson(file)).resolves.toBeNull();

    const syncFile = path.join(root, "sync", "value.json");
    writeJsonSync(syncFile, { sync: true });
    expect(readJsonSync(syncFile)).toEqual({ sync: true });
    expect(tryReadJsonSync(syncFile)).toEqual({ sync: true });
    await writeTextAtomic(path.join(root, "text.txt"), "text", { trailingNewline: false });

    const calls: string[] = [];
    const lock = createAsyncLock();
    await Promise.all([
      lock(async () => {
        calls.push("first");
      }),
      lock(async () => {
        calls.push("second");
        return "value";
      }),
    ]);
    expect(calls).toEqual(["first", "second"]);
  });

  it("covers json store fallback, unlocked writes, locked writes, and updates", async () => {
    const root = await tempRoot("fs-safe-json-store-extra-");
    const fallback = { count: 1 };
    const store = fileStore({ rootDir: root, private: true }).json<{ count: number }>("state.json", {
      lock: {
        managerKey: `coverage-json-store-${Date.now()}-${Math.random()}`,
        staleMs: 60_000,
        timeoutMs: 1000,
      },
    });
    const first = await store.read();
    expect(first).toBeUndefined();
    await store.write({ count: 2 });
    await expect(store.read()).resolves.toEqual({ count: 2 });
    await expect(store.updateOr(fallback, (current) => ({ count: current.count + 1 }))).resolves.toEqual({
      count: 3,
    });

    const unlocked = jsonStore<number>({ filePath: path.join(root, "unlocked.json") });
    await expect(unlocked.read()).resolves.toBeUndefined();
    await unlocked.write(4);
    await expect(unlocked.update((value) => (value ?? 0) + 1)).resolves.toBe(5);
  });

  it("covers regular file read, stat, append, and limit behavior", async () => {
    const root = await tempRoot("fs-safe-regular-extra-");
    const file = path.join(root, "file.txt");
    const dir = path.join(root, "dir");
    await fs.mkdir(dir);
    await fs.writeFile(file, "abc", "utf8");

    expect(resolveRegularFileAppendFlags({ O_APPEND: 8, O_CREAT: 512, O_WRONLY: 1 })).toBe(521);
    await expect(statRegularFile(path.join(root, "missing.txt"))).resolves.toEqual({
      missing: true,
    });
    expect(statRegularFileSync(path.join(root, "missing.txt"))).toEqual({ missing: true });
    await expect(statRegularFile(dir)).rejects.toThrow("regular file");
    expect(() => statRegularFileSync(dir)).toThrow("regular file");
    await expect(readRegularFile({ filePath: file, maxBytes: 8 })).resolves.toMatchObject({
      buffer: Buffer.from("abc"),
    });
    await expect(readRegularFile({ filePath: file, maxBytes: 2 })).rejects.toThrow("exceeds");
    expect(readRegularFileSync({ filePath: file, maxBytes: 8 }).buffer).toEqual(Buffer.from("abc"));
    expect(() => readRegularFileSync({ filePath: file, maxBytes: 2 })).toThrow("exceeds");

    await appendRegularFile({ filePath: file, content: "d", maxFileBytes: 10 });
    await appendRegularFile({ filePath: file, content: "skip", maxFileBytes: 2 });
    appendRegularFileSync({ filePath: file, content: Buffer.from("e"), maxFileBytes: 10 });
    appendRegularFileSync({ filePath: file, content: "skip", maxFileBytes: 2 });
    await expect(fs.readFile(file, "utf8")).resolves.toBe("abcde");
  });
});

describe("temporary workspace and symlink parent helpers", () => {
  it("covers async and sync temporary workspace operations", async () => {
    const root = await tempRoot("fs-safe-workspace-extra-");
    const source = path.join(root, "source.txt");
    await fs.writeFile(source, "copy", "utf8");

    const workspace = await tempWorkspace({ rootDir: root, prefix: "bad prefix!" });
    expect(() => workspace.path("../bad")).toThrow("Invalid temp workspace");
    const privateFile = await workspace.write("private.bin", Buffer.from("private"));
    await workspace.store.writeText("store.txt", "stored");
    const textFile = await workspace.writeText("text.txt", "text");
    const jsonFile = await workspace.writeJson("data.json", { ok: true }, {
      trailingNewline: false,
    });
    await expect(workspace.copyIn("copy.txt", source)).resolves.toBe(workspace.path("copy.txt"));
    await expect(workspace.read("text.txt")).resolves.toEqual(Buffer.from("text"));
    await expect(workspace.store.readText("store.txt")).resolves.toBe("stored");
    expect(path.basename(privateFile)).toBe("private.bin");
    expect(path.basename(textFile)).toBe("text.txt");
    await expect(fs.readFile(jsonFile, "utf8")).resolves.toBe('{\n  "ok": true\n}');
    await workspace.cleanup();

    await expect(
      withTempWorkspace({ rootDir: root, prefix: "." }, async (scoped) => {
        await scoped.writeText("value.txt", "value");
        return (await scoped.read("value.txt")).toString("utf8");
      }),
    ).resolves.toBe("value");

    const syncWorkspace = tempWorkspaceSync({ rootDir: root, prefix: ".." });
    try {
      expect(() => syncWorkspace.path("bad/name")).toThrow("Invalid temp workspace");
      expect(syncWorkspace.write("private.bin", Buffer.from("private"))).toContain(
        "private.bin",
      );
      expect(syncWorkspace.store.writeText("store.txt", "stored")).toContain("store.txt");
      expect(syncWorkspace.store.readTextIfExists("store.txt")).toBe("stored");
      expect(syncWorkspace.writeText("text.txt", "text")).toContain("text.txt");
      expect(syncWorkspace.writeJson("data.json", { ok: true }, { trailingNewline: false }))
        .toContain("data.json");
      expect(syncWorkspace.read("text.txt")).toEqual(Buffer.from("text"));
    } finally {
      syncWorkspace[Symbol.dispose]();
    }
    expect(
      withTempWorkspaceSync({ rootDir: root, prefix: "sync" }, (scoped) => {
        scoped.writeText("value.txt", "value");
        return scoped.read("value.txt").toString("utf8");
      }),
    ).toBe("value");
  });

  it.runIf(process.platform !== "win32")("covers symlink parent policies", async () => {
    const root = await tempRoot("fs-safe-symlink-parent-extra-");
    const outside = await tempRoot("fs-safe-symlink-parent-outside-");
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(outside, path.join(root, "link"));
    await fs.writeFile(path.join(root, "file.txt"), "x", "utf8");

    await expect(
      assertNoSymlinkParents({
        rootDir: root,
        targetPath: path.join(root, "missing", "file.txt"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertNoSymlinkParents({
        rootDir: root,
        targetPath: path.join(root, "link", "file.txt"),
      }),
    ).rejects.toThrow("symlinked");
    await expect(
      assertNoSymlinkParents({
        rootDir: root,
        targetPath: path.join(root, "link", "file.txt"),
        allowRootChildSymlink: true,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertNoSymlinkParents({
        rootDir: root,
        targetPath: path.join(root, "file.txt", "child"),
        requireDirectories: true,
      }),
    ).rejects.toThrow("directories");
    await expect(
      assertNoSymlinkParents({
        rootDir: root,
        targetPath: path.join(outside, "file.txt"),
        allowOutsideRoot: true,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertNoSymlinkParents({
        rootDir: root,
        targetPath: path.join(outside, "file.txt"),
      }),
    ).rejects.toThrow("must stay");

    expect(() =>
      assertNoSymlinkParentsSync({
        rootDir: root,
        targetPath: path.join(root, "link", "file.txt"),
      }),
    ).toThrow("symlinked");
    expect(() =>
      assertNoSymlinkParentsSync({
        rootDir: root,
        targetPath: path.join(root, "missing", "file.txt"),
      }),
    ).not.toThrow();
  });
});

describe("file stores and private stores", () => {
  it.skipIf(process.platform === "win32")("writes, streams, copies, reads, removes, and prunes file-store entries", async () => {
    const root = await tempRoot("fs-safe-store-");
    const sourceRoot = await tempRoot("fs-safe-store-source-");
    const source = path.join(sourceRoot, "source.txt");
    await fs.writeFile(source, "copy", "utf8");
    const store = fileStore({ rootDir: root, maxBytes: 64 });

    expect(store.path("a/b.txt")).toBe(path.join(root, "a", "b.txt"));
    await expect(store.write("a/b.txt", "data")).resolves.toBe(path.join(root, "a", "b.txt"));
    await expect(store.readBytes("a/b.txt")).resolves.toEqual(Buffer.from("data"));
    await expect(store.readText("a/b.txt")).resolves.toBe("data");
    await expect(store.writeJson("state.json", { ok: true })).resolves.toBe(
      path.join(root, "state.json"),
    );
    await expect(store.readJson("state.json")).resolves.toEqual({ ok: true });
    await expect(store.write("too-large.txt", Buffer.alloc(65))).rejects.toMatchObject({
      code: "too-large",
    });
    await store.writeStream("stream.txt", Readable.from(["hello"]));
    await expect(fs.readFile(path.join(root, "stream.txt"), "utf8")).resolves.toBe("hello");
    await expect(store.writeStream("stream-too-large.txt", Readable.from(["123", "456"]), {
      maxBytes: 4,
    })).rejects.toMatchObject({ code: "too-large" });
    await expect(store.copyIn("copied.txt", source)).resolves.toBe(path.join(root, "copied.txt"));
    await expect(store.copyIn("bad.txt", sourceRoot))
      .rejects
      .toMatchObject({ code: "not-file" });
    await expect(store.exists("copied.txt")).resolves.toBe(true);
    await store.remove("copied.txt");
    await expect(store.exists("copied.txt")).resolves.toBe(false);

    const old = path.join(root, "old", "stale.txt");
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, "old", "utf8");
    const stale = new Date(Date.now() - 60_000);
    await fs.utimes(old, stale, stale);
    await store.pruneExpired({ ttlMs: 1, recursive: true, pruneEmptyDirs: true });
    await expect(fs.stat(old)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("covers private file store mode", async () => {
    const root = await tempRoot("fs-safe-private-store-");
    const store = fileStore({ rootDir: root, private: true });

    await store.writeText("nested/value.txt", "secret");
    await expect(store.readText("nested/value.txt")).resolves.toBe("secret");
    await store.writeJson("nested/value.json", { ok: true }, { trailingNewline: true });
    await expect(store.readJson("nested/value.json")).resolves.toEqual({ ok: true });
    await expect(store.exists("nested/value.json")).resolves.toBe(true);
    await expect(store.readBytes("nested/value.txt")).resolves.toEqual(Buffer.from("secret"));
    expect(store.path("nested/value.txt")).toBe(path.join(root, "nested", "value.txt"));
    expect(() => store.path("../escape.txt")).toThrow("relative path");
    await expect(store.readTextIfExists("missing.txt")).resolves.toBeNull();
    await expect(store.readJsonIfExists("missing.json")).resolves.toBeNull();
    await store.remove("nested/value.json");
    await expect(store.exists("nested/value.json")).resolves.toBe(false);

    const syncStore = fileStoreSync({ rootDir: root, private: true });
    const syncText = syncStore.writeText("sync/value.txt", "sync");
    expect(await fs.readFile(syncText, "utf8")).toBe("sync");
    const syncJson = syncStore.writeJson("sync/value.json", { ok: true }, { trailingNewline: true });
    expect(JSON.parse(await fs.readFile(syncJson, "utf8"))).toEqual({ ok: true });
    expect(() => syncStore.writeText("../escape.txt", "nope")).toThrow("relative path");
  });
});

describe("secret files and temp roots", () => {
  it("covers secret read failures and private write validation", async () => {
    const root = await tempRoot("fs-safe-secret-extra-");
    const empty = path.join(root, "empty.txt");
    await fs.writeFile(empty, " \n", "utf8");
    expect(() => readSecretFileSync("", "Token")).toThrow("Token file path is empty.");
    expect(() => readSecretFileSync(path.join(root, "missing.txt"), "Token")).toThrow(
      "Failed to inspect Token file",
    );
    expect(() => readSecretFileSync(root, "Token")).toThrow("must be a regular file");
    expect(() => readSecretFileSync(empty, "Token")).toThrow("is empty");
    expect(tryReadSecretFileSync("", "Token")).toBeUndefined();
    expect(tryReadSecretFileSync(path.join(root, "missing.txt"), "Token")).toBeUndefined();

    const big = path.join(root, "big.txt");
    await fs.writeFile(big, "12345", "utf8");
    expect(() => readSecretFileSync(big, "Token", { maxBytes: 2 })).toThrow("exceeds 2 bytes");

    const target = path.join(root, "private", "token.txt");
    await writeSecretFileAtomic({ rootDir: root, filePath: target, content: "secret\n" });
    expect(readSecretFileSync(target, "Token")).toBe("secret");
    await fs.mkdir(path.join(root, "dir-target"));
    await expect(
      writeSecretFileAtomic({
        rootDir: root,
        filePath: path.join(root, "dir-target"),
        content: "bad",
      }),
    ).rejects.toThrow("regular file");
  });

  it("covers secure temp root resolution and timeout behavior", async () => {
    const root = await tempRoot("fs-safe-temp-root-");
    const secure = path.join(root, "secure");
    expect(resolveSecureTempRoot({ fallbackPrefix: "fallback", preferredDir: secure })).toBe(
      path.resolve(secure),
    );
    const winFallback = path.win32.join(root, "fallback");
    const winFallbackStat = { isDirectory: () => true, isSymbolicLink: () => false };
    expect(resolveSecureTempRoot({
      accessSync: vi.fn(), chmodSync: vi.fn(), fallbackPrefix: "fallback",
      getuid: () => undefined, lstatSync: vi.fn(() => winFallbackStat), mkdirSync: vi.fn(),
      platform: "win32", preferredDir: secure, skipPreferredOnWindows: true, tmpdir: () => root,
    })).toBe(winFallback);
    await expect(withTimeout(Promise.resolve("ok"), 10, { message: "slow" })).resolves.toBe("ok");
    await expect(withTimeout(new Promise(() => undefined), 1, { message: "slow" }))
      .rejects
      .toThrow("slow");
  });

  it("covers temp target sanitizing, disposable files, and cleanup", async () => {
    const root = await tempRoot("fs-safe-temp-file-");
    expect(sanitizeTempFileName("../bad name?.txt")).toBe("bad-name-.txt");
    expect(
      buildRandomTempFilePath({
        rootDir: root,
        prefix: "bad prefix!",
        extension: "log",
        now: 1.9,
        uuid: " fixed ",
      }),
    ).toBe(path.join(root, "bad-prefix-1-fixed.log"));
    const tmp = await tempFile({ rootDir: root, prefix: "download", fileName: "../x.bin" });
    await fs.writeFile(tmp.path, "ok", "utf8");
    await expect(fs.readFile(tmp.file("alt?.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await tmp[Symbol.asyncDispose]();
    await expect(fs.stat(tmp.dir)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      withTempFile({ rootDir: root, prefix: "scoped", fileName: "x.txt" }, async (tmpPath) => {
        await fs.writeFile(tmpPath, "scoped", "utf8");
        return await fs.readFile(tmpPath, "utf8");
      }),
    ).resolves.toBe("scoped");
  });
});

describe("policy and directory replacement helpers", () => {
  it("covers alias policy and atomic directory replacement outcomes", async () => {
    const root = await tempRoot("fs-safe-policy-");
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "ok", "utf8");
    await expect(
      assertNoPathAliasEscape({ rootPath: root, absolutePath: file, boundaryLabel: "root" }),
    ).resolves.toBeUndefined();
    await expect(
      assertNoPathAliasEscape({
        rootPath: root,
        absolutePath: path.join(path.dirname(root), "outside.txt"),
        boundaryLabel: "root",
      }),
    ).rejects.toThrow("outside");

    await expect(
      assertNoHardlinkedFinalPath({ filePath: file, root, boundaryLabel: "root" }),
    ).resolves.toBeUndefined();
    if (process.platform !== "win32") {
      const hardlink = path.join(root, "hardlink.txt");
      await fs.link(file, hardlink);
      await expect(
        assertNoHardlinkedFinalPath({ filePath: hardlink, root, boundaryLabel: "root" }),
      ).rejects.toThrow("Hardlinked");
    }

    const next = path.join(root, "next");
    await fs.mkdir(next);
    await fs.writeFile(path.join(next, "new.txt"), "new", "utf8");
    const target = path.join(root, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "old.txt"), "old", "utf8");
    await replaceDirectoryAtomic({ stagedDir: next, targetDir: target });
    await expect(fs.readFile(path.join(target, "new.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.stat(next)).rejects.toMatchObject({ code: "ENOENT" });

    const notDir = path.join(root, "not-dir");
    await fs.writeFile(notDir, "x", "utf8");
    await expect(replaceDirectoryAtomic({ sourceDir: notDir, targetDir: target })).rejects
      .toThrow();
  });
});
