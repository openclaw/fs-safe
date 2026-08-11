import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { useTempDirs } from "./helpers/vitest.js";
import { createBoundedReadStream, createMaxBytesTransform } from "../src/bounded-read-stream.js";
import {
  assertAsyncDirectoryGuard,
  assertSyncDirectoryGuard,
  createAsyncDirectoryGuard,
  createNearestExistingDirectoryGuard,
  createNearestExistingSyncDirectoryGuard,
  createSyncDirectoryGuard,
} from "../src/directory-guard.js";
import { drainFileLockManagerForTest, resetFileLockManagerForTest } from "../src/file-lock.js";
import { sameFileIdentity } from "../src/file-identity.js";
import { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import { resolveSecureTempRoot, type ResolveSecureTempRootOptions } from "../src/secure-temp-dir.js";
import { writeSiblingTempFile, writeViaSiblingTempPath } from "../src/sibling-temp.js";
import {
  buildRandomTempFilePath,
  sanitizeTempFileName,
  tempFile,
  withTempFile,
} from "../src/temp-target.js";

type SecureDirStat = NonNullable<ResolveSecureTempRootOptions["lstatSync"]> extends (
  path: string,
) => infer Result
  ? Result
  : never;

const { tempRoot } = useTempDirs();


function nodeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function dirStat(params?: {
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
  mode?: number;
  uid?: number;
}): SecureDirStat {
  return {
    isDirectory: () => params?.isDirectory ?? true,
    isSymbolicLink: () => params?.isSymbolicLink ?? false,
    mode: params?.mode ?? 0o40700,
    uid: params?.uid,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("secure temp root fallback coverage", () => {
  it("creates the uid-less fallback when no preferred directory is configured", () => {
    const fallbackPath = path.join("/tmp", "fs-safe-test");
    let created = false;

    const resolved = resolveSecureTempRoot({
      fallbackPrefix: "fs-safe-test",
      getuid: () => undefined,
      lstatSync: vi.fn((candidate: string) => {
        if (candidate === fallbackPath && !created) {
          throw nodeError("ENOENT");
        }
        return dirStat();
      }),
      mkdirSync: vi.fn((candidate: string) => {
        if (candidate === fallbackPath) {
          created = true;
        }
      }),
      chmodSync: vi.fn(),
      accessSync: vi.fn(),
      tmpdir: () => "/tmp",
      warn: vi.fn(),
    });

    expect(resolved).toBe(fallbackPath);
  });

  it("rejects an unsafe fallback directory that cannot be repaired", () => {
    expect(() =>
      resolveSecureTempRoot({
        fallbackPrefix: "fs-safe-test",
        getuid: () => 501,
        lstatSync: vi.fn(() => dirStat({ isSymbolicLink: true, uid: 501 })),
        mkdirSync: vi.fn(),
        chmodSync: vi.fn(),
        accessSync: vi.fn(),
        tmpdir: () => "/tmp",
        unsafeFallbackLabel: "test temp",
        warn: vi.fn(),
      }),
    ).toThrow("Unsafe fallback test temp");
  });

  it("accepts a fallback directory after a chmod-denied recheck proves it safe", () => {
    const fallbackPath = path.join("/tmp", "fs-safe-test-501");
    let calls = 0;

    const resolved = resolveSecureTempRoot({
      fallbackPrefix: "fs-safe-test",
      getuid: () => 501,
      lstatSync: vi.fn((candidate: string) => {
        expect(candidate).toBe(fallbackPath);
        calls += 1;
        return dirStat({ mode: calls < 3 ? 0o40777 : 0o40700, uid: 501 });
      }),
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(() => {
        throw nodeError("EPERM");
      }),
      accessSync: vi.fn(),
      tmpdir: () => "/tmp",
      warn: vi.fn(),
    });

    expect(resolved).toBe(fallbackPath);
  });
});

describe("small identity and lock wrappers", () => {
  it("compares file identities across POSIX and Windows zero identity stats", async () => {
    const cases = [
      ["linux", { dev: 1, ino: 2 }, { dev: 1, ino: 2 }, true],
      ["linux", { dev: 1, ino: 2 }, { dev: 1n, ino: 2n }, true],
      ["linux", { dev: 1, ino: 2 }, { dev: 1, ino: 3 }, false],
      ["win32", { dev: 0, ino: 2 }, { dev: 99, ino: 2 }, true],
      ["win32", { dev: 0, ino: 2 }, { dev: 99n, ino: 2n }, true],
      ["linux", { dev: 0n, ino: 2n }, { dev: 99n, ino: 2n }, false],
      ["win32", { dev: 1, ino: 0 }, { dev: 1, ino: 5 }, true],
      ["win32", { dev: 1, ino: 5 }, { dev: 1, ino: 0n }, true],
      ["win32", { dev: 0, ino: 0 }, { dev: 2, ino: 5 }, true],
      ["win32", { dev: 1, ino: 0 }, { dev: 2, ino: 5 }, false],
      ["win32", { dev: 1, ino: 4 }, { dev: 1, ino: 5 }, false],
      ["linux", { dev: 1, ino: 0 }, { dev: 1, ino: 5 }, false],
    ] as const;

    for (const [platform, left, right, expected] of cases) {
      expect(sameFileIdentity(left, right, platform)).toBe(expected);
    }

    const root = await tempRoot("fs-safe-file-lock-wrapper-");
    const targetPath = path.join(root, "state.json");
    await drainFileLockManagerForTest(targetPath, "coverage-lock-wrapper");
    resetFileLockManagerForTest(targetPath, "coverage-lock-wrapper");
  });
});

describe("bounded streams and directory guard coverage", () => {
  it("returns raw streams without limits and rejects oversized limited streams", async () => {
    const raw = Readable.from(["ok"]);
    const returned = createBoundedReadStream({ handle: { createReadStream: () => raw } }, undefined);
    expect(returned).toBe(raw);

    await expectFsSafeError((async () => {
      for await (const _chunk of Readable.from(["ab", "cd"]).pipe(createMaxBytesTransform(3))) {
        // Drain the stream so transform errors surface.
      }
    })(), "too-large");
  });

  it("detects changed or invalid directory guards", async () => {
    const root = await tempRoot("fs-safe-dir-guard-more-");
    const nested = path.join(root, "nested");
    const filePath = path.join(root, "file.txt");
    await fs.mkdir(nested);
    await fs.writeFile(filePath, "not a dir", "utf8");

    await expect(createAsyncDirectoryGuard(filePath)).rejects.toMatchObject({ code: "not-file" });
    expect(() => createSyncDirectoryGuard(filePath)).toThrow("directory component");

    const asyncGuard = await createAsyncDirectoryGuard(nested);
    const syncGuard = createSyncDirectoryGuard(nested);
    await expectFsSafeError(assertAsyncDirectoryGuard({ ...asyncGuard, realPath: root }), "path-mismatch");
    expect(() => assertSyncDirectoryGuard({ ...syncGuard, realPath: root })).toThrow(
      "directory changed",
    );

    await fs.rm(nested, { recursive: true });
    await fs.writeFile(nested, "not a dir", "utf8");

    await expectFsSafeError(assertAsyncDirectoryGuard(asyncGuard), "not-file");
    expect(() => assertSyncDirectoryGuard(syncGuard)).toThrow("directory component");

    const nearest = await createNearestExistingDirectoryGuard(root, path.join(root, "missing", "x"));
    expect(nearest.dir).toBe(root);
    expect(createNearestExistingSyncDirectoryGuard(root, path.join(root, "missing", "x")).dir)
      .toBe(root);
  });
});

describe("sibling temp coverage", () => {
  it("syncs temp files and parent dirs when requested", async () => {
    const root = await tempRoot("fs-safe-sibling-more-");
    const result = await writeSiblingTempFile({
      dir: root,
      mode: 0o600,
      syncParentDir: true,
      syncTempFile: true,
      tempPrefix: ".coverage",
      writeTemp: async (tempPath) => {
        await fs.writeFile(tempPath, "synced", "utf8");
        return { name: "final.txt" };
      },
      resolveFinalPath: ({ name }) => path.join(root, name),
    });

    expect(result.filePath).toBe(path.join(root, "final.txt"));
    await expect(fs.readFile(result.filePath, "utf8")).resolves.toBe("synced");
    if (process.platform !== "win32") {
      // POSIX file modes don't fully apply on Windows.
      expect((await fs.stat(result.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("removes sibling temp files when copy-in rejects the staged source", async () => {
    const root = await tempRoot("fs-safe-sibling-copyin-");
    const outside = await tempRoot("fs-safe-sibling-copyin-outside-");
    const targetPath = path.join(root, "nested", "out.txt");
    let stagedPath = "";
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    await expect(
      writeViaSiblingTempPath({
        rootDir: root,
        targetPath,
        writeTemp: async (candidate) => {
          stagedPath = candidate;
          await fs.writeFile(candidate, "bad", "utf8");
          await fs.symlink(outside, path.dirname(targetPath), "dir");
        },
      }),
    ).rejects.toBeTruthy();

    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });
});

describe("temp target edge coverage", () => {
  it("normalizes empty temp names, extensions, timestamps, and cleanup on thrown callbacks", async () => {
    const root = await tempRoot("fs-safe-temp-more-");

    expect(sanitizeTempFileName("???")).toBe("download.bin");
    const built = buildRandomTempFilePath({
      rootDir: root,
      prefix: "!!!",
      extension: "._-",
      now: Number.NaN,
      uuid: "id",
    });
    expect(path.dirname(built)).toBe(root);
    expect(path.basename(built)).toMatch(/^tmp-\d+-id$/);

    const tmp = await tempFile({ rootDir: root, prefix: "???", fileName: "???" });
    expect(path.basename(tmp.dir)).toMatch(/^tmp-/);
    expect(path.basename(tmp.path)).toBe("download.bin");
    await tmp.cleanup();

    let scopedPath = "";
    await expect(
      withTempFile({ rootDir: root, prefix: "throwing", fileName: "x.txt" }, async (tmpPath) => {
        scopedPath = tmpPath;
        await fs.writeFile(tmpPath, "cleanup", "utf8");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.stat(path.dirname(scopedPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("local roots edge coverage", () => {
  it("rejects invalid root entries and file URL inputs", async () => {
    const root = await tempRoot("fs-safe-local-roots-more-");
    await expect(async () =>
      resolveLocalPathFromRootsSync({ filePath: root, roots: [" "], label: "media roots" }),
    ).rejects.toThrow("media roots entry is required");
    expect(() =>
      resolveLocalPathFromRootsSync({ filePath: root, roots: ["relative"], label: "media roots" }),
    ).toThrow("absolute paths");
    expect(() =>
      resolveLocalPathFromRootsSync({
        filePath: root,
        roots: [`${root}\0bad`],
        label: "media roots",
      }),
    ).toThrow("NUL");
    expect(() =>
      resolveLocalPathFromRootsSync({
        filePath: "file://remote.example/path.txt",
        roots: [root],
      }),
    ).toThrow("Invalid file:// URL");
  });

  it("skips unusable roots and non-file candidates", async () => {
    const root = await tempRoot("fs-safe-local-roots-valid-");
    const missingRoot = path.join(root, "missing-root");
    const realRoot = path.join(root, "real-root");
    const childDir = path.join(realRoot, "child");
    const filePath = path.join(realRoot, "ok.txt");
    await fs.mkdir(childDir, { recursive: true });
    await fs.writeFile(filePath, "ok", "utf8");

    expect(
      resolveLocalPathFromRootsSync({
        filePath,
        roots: [missingRoot, realRoot],
        requireFile: true,
      }),
    ).toMatchObject({ path: fsSync.realpathSync(filePath) });
    expect(
      resolveLocalPathFromRootsSync({
        filePath: childDir,
        roots: [realRoot],
        requireFile: true,
      }),
    ).toBeNull();
    await expect(
      readLocalFileFromRoots({ filePath: realRoot, roots: [missingRoot, realRoot] }),
    ).resolves.toBeNull();
  });
});
