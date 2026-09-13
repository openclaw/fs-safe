import fsSync from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { isPathInside, resolveSafeRelativePath } from "../src/path.js";
import { safeFileURLToPath, trySafeFileURLToPath } from "../src/local-file-access.js";
import { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import { openPinnedFileSync } from "../src/pinned-open.js";
import {
  readJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";
import {
  appendRegularFile,
  appendRegularFileSync,
  readRegularFile,
  readRegularFileSync,
  statRegularFile,
  statRegularFileSync,
} from "../src/regular-file.js";
import { root } from "../src/root.js";
import { resolveRootPath, resolveRootPathSync } from "../src/root-path.js";
import {
  ensureDirectoryWithinRoot,
  pathScope,
  resolvePathsWithinRoot,
} from "../src/root-paths.js";
import { readSecretFile, tryReadSecretFile } from "../src/secret-read-async.js";
import {
  createSecretFileAtomic,
  prepareSecretFileWrite,
  readSecretFileSync,
  tryReadSecretFileSync,
  writeSecretFileAtomic,
} from "../src/secret-file.js";
import { readSecureFile } from "../src/secure-file.js";
import {
  assertNoWindowsPathAlias,
  hasWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathFromBasePreservingWindowsRoot,
  resolvePathPreservingWindowsRoot,
} from "../src/windows-path-alias.js";

describe("Windows filesystem namespace alias classifier", () => {
  it.each([
    "C:\\root\\file.txt",
    "C:/root/file.txt",
    "\\\\?\\C:\\root\\file.txt",
    "\\\\.\\C:\\root\\file.txt",
    "\\\\server\\share\\file.txt",
    "\\\\?\\UNC\\server\\share\\file.txt",
  ])("admits ordinary rooted filesystem path %s", (value) => {
    expect(hasWindowsPathAlias(value, "filesystem", "win32")).toBe(false);
  });

  it.each([
    "file.txt:stream",
    "C:relative.txt",
    "C:\\root\\file.txt:stream",
    "\\\\server:443\\share\\file.txt",
    "\\\\?\\C:\\root\\file.txt:stream",
    "dir::$INDEX_ALLOCATION\\child",
    "dir:$I30:$INDEX_ALLOCATION\\child",
  ])("rejects Windows namespace alias %s", (value) => {
    expect(hasWindowsPathAlias(value, "filesystem", "win32")).toBe(true);
    expect(() => assertNoWindowsPathAlias(value, "filesystem", "invalid", "win32"))
      .toThrow(expect.objectContaining({ code: "invalid-path" }));
  });

  it("rejects every relative colon on Windows but preserves POSIX colon names", () => {
    expect(hasWindowsPathAlias("logs/10:30.txt", "relative", "win32")).toBe(true);
    expect(hasWindowsPathAlias("logs/10:30.txt", "relative", "linux")).toBe(false);
    expect(hasWindowsPathAlias("/tmp/10:30.txt", "filesystem", "darwin")).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32")("Windows namespace alias admissions", () => {
  it.each(["\\\\?\\C:\\", "\\\\.\\C:\\", "//?/C:/"])(
    "preserves an admitted exact namespace drive root %s",
    (value) => {
      expect(resolvePathPreservingWindowsRoot(value)).toBe(path.win32.normalize(value));
      expect(pathForWindowsFilesystem(value)).toBe("C:\\");
    },
  );

  it.each(["\\\\?\\C:\\", "\\\\.\\C:\\"])(
    "preserves %s when relative resolution returns to the root",
    (rootDir) => {
      for (const relativePath of ["", ".", "./", "child/.."]) {
        expect(
          resolvePathPreservingWindowsRoot(`${rootDir}${relativePath}`),
          `single ${relativePath}`,
        ).toBe(rootDir);
        expect(
          resolvePathFromBasePreservingWindowsRoot(rootDir, relativePath),
          `multi ${relativePath}`,
        ).toBe(rootDir);
      }
      expect(resolvePathFromBasePreservingWindowsRoot(`${rootDir}child`, ".."))
        .toBe(rootDir);
      expect(resolvePathFromBasePreservingWindowsRoot(rootDir, "child", ".."))
        .toBe(rootDir);
      expect(resolvePathFromBasePreservingWindowsRoot("D:\\workspace", rootDir))
        .toBe(rootDir);
      expect(isPathInside(rootDir, `${rootDir}.`)).toBe(true);
      expect(isPathInside(`${rootDir}.`, `${rootDir}child`)).toBe(true);
    },
  );

  it("keeps base-drive semantics and bare namespace rejection during relative resolution", () => {
    expect(resolvePathFromBasePreservingWindowsRoot("D:\\workspace", "\\child"))
      .toBe("D:\\child");
    expect(resolvePathFromBasePreservingWindowsRoot("D:\\workspace", "\\\\?\\C:"))
      .toBe("\\\\?\\C:");
    expect(hasWindowsPathAlias(
      resolvePathFromBasePreservingWindowsRoot("C:\\bad:stream", "\\\\?\\C:\\"),
      "filesystem",
    )).toBe(true);
    expect(resolvePathFromBasePreservingWindowsRoot("\\\\server\\share\\", "child"))
      .toBe("\\\\server\\share\\child");
  });

  it("normalizes mixed separators and does not repair traversal above a namespace root", () => {
    expect(resolvePathPreservingWindowsRoot("//?/c:/./")).toBe("\\\\?\\c:\\");
    expect(resolvePathPreservingWindowsRoot("\\\\?\\C:\\..")).toBe("\\\\?\\");
    expect(pathForWindowsFilesystem("//?/c:/./")).toBe("c:\\");
    expect(pathForWindowsFilesystem("\\\\?\\C:\\..")).toBe("\\\\?\\C:\\..");
  });

  it.each([
    "\\\\?\\C:",
    "\\\\.\\C:",
    "\\\\?\\C:\\child:stream\\..",
    "\\\\?\\C:\\child::$INDEX_ALLOCATION\\..",
  ])("does not normalize an invalid alias into an admitted root: %s", (value) => {
    expect(hasWindowsPathAlias(resolvePathPreservingWindowsRoot(value), "filesystem"))
      .toBe(true);
    expect(pathForWindowsFilesystem(value)).toBe(value);
  });

  it.each([
    "child:stream\\..",
    "child::$INDEX_ALLOCATION\\..",
  ])("does not normalize an invalid relative alias into an admitted root: %s", (value) => {
    expect(hasWindowsPathAlias(
      resolvePathFromBasePreservingWindowsRoot("\\\\?\\C:\\", value),
      "filesystem",
    )).toBe(true);
  });

  it.each(["", ".", "./"])(
    "keeps an exact namespace root for safe relative input %j",
    (relativePath) => {
      expect(resolveSafeRelativePath("\\\\?\\C:\\", relativePath))
        .toBe("\\\\?\\C:\\");
    },
  );

  it.each(["\\\\?\\C:\\", "\\\\.\\C:\\"])(
    "preserves root-returning forms through async and sync root resolution for %s",
    async (rootDir) => {
      const directoryStat = {
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      } as fsSync.Stats;
      const lstat = vi.spyOn(fsSync, "lstatSync").mockReturnValue(directoryStat);
      const stat = vi.spyOn(fsSync, "statSync").mockReturnValue(directoryStat);
      const expected = {
        absolutePath: rootDir,
        canonicalPath: rootDir,
        rootPath: rootDir,
        rootCanonicalPath: rootDir,
        relativePath: "",
        exists: true,
        kind: "directory",
      };

      try {
        for (const field of ["rootPath", "absolutePath", "rootCanonicalPath"] as const) {
          for (const suffix of [".", "./", "child\\.."]) {
            const params = {
              rootPath: rootDir,
              absolutePath: rootDir,
              rootCanonicalPath: rootDir,
              boundaryLabel: "namespace root",
              [field]: `${rootDir}${suffix}`,
            };
            await expect(resolveRootPath(params), `${field} ${suffix}`).resolves.toEqual(expected);
            expect(resolveRootPathSync(params), `${field} ${suffix}`).toEqual(expected);
          }
        }
      } finally {
        lstat.mockRestore();
        stat.mockRestore();
      }
    },
  );

  it.each(["rootPath", "absolutePath", "rootCanonicalPath"] as const)(
    "rejects aliases in %s before root-resolution filesystem access",
    async (field) => {
      const lstat = vi.spyOn(fsSync, "lstatSync");
      const stat = vi.spyOn(fsSync, "statSync");

      try {
        for (const alias of [
          "\\\\?\\C:",
          "\\\\.\\C:",
          "\\\\?\\C:\\child:stream\\..",
          "\\\\?\\C:\\child::$INDEX_ALLOCATION\\..",
        ]) {
          const params = {
            rootPath: "\\\\?\\C:\\",
            absolutePath: "\\\\?\\C:\\",
            rootCanonicalPath: "\\\\?\\C:\\",
            boundaryLabel: "namespace root",
            [field]: alias,
          };
          await expect(resolveRootPath(params)).rejects.toMatchObject({
            code: "invalid-path",
            details: { reason: "windows-path-alias" },
          });
          expect(() => resolveRootPathSync(params)).toThrow(
            expect.objectContaining({
              code: "invalid-path",
              details: { reason: "windows-path-alias" },
            }),
          );
        }
        expect(lstat).not.toHaveBeenCalled();
        expect(stat).not.toHaveBeenCalled();
      } finally {
        lstat.mockRestore();
        stat.mockRestore();
      }
    },
  );

  it("preserves byte-limit validation before pathname admission", async () => {
    const alias = "C:\\missing.txt:hidden";
    const lstat = vi.spyOn(fsSync, "lstatSync");
    await expect(readRegularFile({ filePath: alias, maxBytes: -1 })).rejects
      .toBeInstanceOf(RangeError);
    expect(() => readRegularFileSync({ filePath: alias, maxBytes: -1 }))
      .toThrow(RangeError);
    await expect(readSecureFile({
      filePath: alias,
      io: { maxBytes: -1 },
      permissions: { allowInsecure: true },
    })).rejects.toBeInstanceOf(RangeError);
    await expect(readJsonDurableQueueEntry(alias, { maxBytes: -1 })).rejects
      .toBeInstanceOf(RangeError);
    expect(lstat).not.toHaveBeenCalled();
  });

  it("blocks Root and FileStore stream/index aliases without changing either namespace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-ads-root-"));
    const basePath = path.join(rootDir, "carrier.txt");
    const streamPath = `${basePath}:payload`;
    try {
      await writeFile(basePath, "base");
      await writeFile(streamPath, "stream");
      await mkdir(path.join(rootDir, "directory"));
      const scoped = await root(rootDir);
      const relativeStream = "carrier.txt:payload";
      const relativeIndex = "directory::$INDEX_ALLOCATION/child.txt";
      const source = path.join(rootDir, "source.txt");
      await writeFile(source, "source");

      const rootCalls: Array<[string, () => Promise<unknown>]> = [
        ["resolve", () => scoped.resolve(relativeStream)],
        ["open", () => scoped.open(relativeStream)],
        ["read", () => scoped.read(relativeStream)],
        ["readBytes", () => scoped.readBytes(relativeStream)],
        ["readText", () => scoped.readText(relativeStream)],
        ["readJson", () => scoped.readJson(relativeStream)],
        ["stat", () => scoped.stat(relativeStream)],
        ["exists", () => scoped.exists(relativeStream)],
        ["openWritable", () => scoped.openWritable(relativeStream)],
        ["append", () => scoped.append(relativeStream, "bad")],
        ["write", () => scoped.write(relativeStream, "bad")],
        ["create", () => scoped.create(relativeStream, "bad")],
        ["remove", () => scoped.remove(relativeStream)],
        ["copyIn", () => scoped.copyIn(relativeStream, source)],
        ["move source", () => scoped.move(relativeStream, "moved.txt")],
        ["move destination", () => scoped.move("source.txt", relativeStream)],
        ["index write", () => scoped.write(relativeIndex, "bad")],
        ["index mkdir", () => scoped.mkdir("directory::$INDEX_ALLOCATION/nested")],
      ];
      for (const [label, call] of rootCalls) {
        await expect(call(), label).rejects.toMatchObject({ code: "invalid-path" });
      }

      const store = fileStore({ rootDir });
      const privateStore = fileStore({ rootDir, private: true });
      const syncStore = fileStoreSync({ rootDir });
      for (const call of [
        () => store.writeText(relativeStream, "bad"),
        () => privateStore.writeText(relativeStream, "bad"),
        () => store.readText(relativeStream),
        () => store.remove(relativeStream),
        () => store.copyIn("copied.txt", streamPath),
        () => privateStore.copyIn("private-copy.txt", streamPath),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: "invalid-path" });
      }
      for (const call of [
        () => syncStore.path(relativeStream),
        () => syncStore.readTextIfExists(relativeStream),
        () => syncStore.writeText(relativeStream, "bad"),
      ]) {
        expect(call).toThrow(expect.objectContaining({ code: "invalid-path" }));
      }
      await expect(root(`${rootDir}::$INDEX_ALLOCATION`)).rejects.toMatchObject({
        code: "invalid-path",
      });
      expect(() => fileStore({ rootDir: `${rootDir}::$INDEX_ALLOCATION` })).toThrow(
        expect.objectContaining({ code: "invalid-path" }),
      );

      await expect(readFile(basePath, "utf8")).resolves.toBe("base");
      await expect(readFile(streamPath, "utf8")).resolves.toBe("stream");
      await expect(readFile(source, "utf8")).resolves.toBe("source");
      expect(fsSync.existsSync(path.join(rootDir, "directory", "child.txt"))).toBe(false);
      expect(fsSync.existsSync(path.join(rootDir, "directory", "nested"))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("blocks standalone readers, appenders, and pinned opens before I/O", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-ads-standalone-"));
    const basePath = path.join(rootDir, "carrier.txt");
    const streamPath = `${basePath}:payload`;
    try {
      await writeFile(basePath, "base");
      await writeFile(streamPath, "stream");
      for (const call of [
        () => statRegularFile(streamPath),
        () => readRegularFile({ filePath: streamPath }),
        () => appendRegularFile({ filePath: streamPath, content: "bad" }),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: "invalid-path" });
      }
      for (const call of [
        () => statRegularFileSync(streamPath),
        () => readRegularFileSync({ filePath: streamPath }),
        () => appendRegularFileSync({ filePath: streamPath, content: "bad" }),
      ]) {
        expect(call).toThrow(expect.objectContaining({ code: "invalid-path" }));
      }
      expect(openPinnedFileSync({ filePath: streamPath })).toMatchObject({
        ok: false,
        reason: "validation",
        error: expect.objectContaining({ code: "invalid-path" }),
      });

      const openSync = vi.fn();
      const ioFs = {
        ...fsSync,
        realpathSync: vi.fn(() => "C:\\root\\carrier.txt:payload"),
        lstatSync: vi.fn(() => { throw new Error("must not inspect alias"); }),
        openSync,
      } as unknown as NonNullable<Parameters<typeof openPinnedFileSync>[0]["ioFs"]>;
      expect(openPinnedFileSync({ filePath: "C:\\root\\carrier.txt", ioFs })).toMatchObject({
        ok: false,
        reason: "validation",
      });
      expect(openSync).not.toHaveBeenCalled();
      await expect(readFile(streamPath, "utf8")).resolves.toBe("stream");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("preserves PathScope, local-root, URL, secure-file, and secret contracts", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-ads-contract-"));
    const basePath = path.join(rootDir, "carrier.txt");
    const streamPath = `${basePath}:payload`;
    try {
      await writeFile(basePath, "base");
      await writeFile(streamPath, "stream");
      const scope = pathScope(rootDir, { label: "workspace" });
      const failure = { ok: false, error: "Invalid path: must stay within workspace" };
      expect(scope.resolve("carrier.txt:payload")).toEqual(failure);
      expect(scope.resolve("", { defaultName: "carrier.txt:payload" })).toEqual(failure);
      await expect(scope.writable("carrier.txt:payload")).resolves.toEqual(failure);
      await expect(scope.ensureDir("directory::$INDEX_ALLOCATION")).resolves.toEqual(failure);
      expect(resolvePathsWithinRoot({
        rootDir: `${rootDir}::$INDEX_ALLOCATION`,
        requestedPaths: [],
        scopeLabel: "workspace",
      })).toEqual(failure);
      expect(await ensureDirectoryWithinRoot({
        rootDir,
        requestedPath: "directory::$INDEX_ALLOCATION",
        scopeLabel: "workspace",
      })).toEqual(failure);

      expect(resolveLocalPathFromRootsSync({ filePath: streamPath, roots: [rootDir] })).toBeNull();
      await expect(readLocalFileFromRoots({ filePath: streamPath, roots: [rootDir] }))
        .resolves.toBeNull();
      expect(() => resolveLocalPathFromRootsSync({
        filePath: basePath,
        roots: [`${rootDir}::$INDEX_ALLOCATION`],
      })).toThrow(expect.objectContaining({ code: "invalid-path" }));
      const streamUrl = pathToFileURL(streamPath).href;
      expect(() => safeFileURLToPath(streamUrl)).toThrow(Error);
      expect(trySafeFileURLToPath(streamUrl)).toBeUndefined();

      await expect(readSecureFile({
        filePath: streamPath,
        permissions: { allowInsecure: true },
      })).rejects.toMatchObject({ code: "invalid-path", category: "policy" });
      await expect(readSecureFile({
        filePath: basePath,
        trust: { trustedDirs: [`${rootDir}::$INDEX_ALLOCATION`] },
        permissions: { allowInsecure: true },
      })).rejects.toMatchObject({ code: "invalid-path" });

      expect(() => readSecretFileSync(streamPath, "token")).toThrow(
        expect.objectContaining({ code: "invalid-path" }),
      );
      expect(() => tryReadSecretFileSync(streamPath, "token")).toThrow(
        expect.objectContaining({ code: "invalid-path" }),
      );
      await expect(readSecretFile(streamPath, "token")).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(tryReadSecretFile(streamPath, "token")).rejects.toMatchObject({
        code: "invalid-path",
      });

      const secretPath = path.join(rootDir, "secret.txt:payload");
      const writeParams = { rootDir, filePath: secretPath, content: "bad" };
      await expect(prepareSecretFileWrite(writeParams)).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(writeSecretFileAtomic(writeParams)).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(createSecretFileAtomic(writeParams)).rejects.toMatchObject({
        code: "invalid-path",
      });
      expect(fsSync.existsSync(path.join(rootDir, "secret.txt"))).toBe(false);
      await expect(readFile(basePath, "utf8")).resolves.toBe("base");
      await expect(readFile(streamPath, "utf8")).resolves.toBe("stream");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
