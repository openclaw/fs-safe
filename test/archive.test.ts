import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  type ArchiveSecurityError,
  extractArchive,
  resolvePackedRootDir,
} from "../src/archive.js";
import { withExtractionDeadline } from "../src/archive-deadline.js";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import {
  buildRandomTempFilePath,
  sanitizeTempFileName,
  tempFile,
  withTempFile,
} from "../src/temp-target.js";

const { tempRoot } = useTempDirs();

beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
});


async function createRebindableDirectoryAlias(params: {
  aliasPath: string;
  targetPath: string;
}): Promise<void> {
  await fs.rm(params.aliasPath, { recursive: true, force: true });
  await fs.symlink(
    params.targetPath,
    params.aliasPath,
    process.platform === "win32" ? "junction" : undefined,
  );
}

async function withRealpathSymlinkRebindRace<T>(params: {
  shouldFlip: (realpathInput: string) => boolean;
  symlinkPath: string;
  symlinkTarget: string;
  run: () => Promise<T>;
}): Promise<T> {
  const realRealpath = fs.realpath.bind(fs);
  let flipped = false;
  const realpathSpy = vi
    .spyOn(fs, "realpath")
    .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      const filePath = String(args[0]);
      if (!flipped && params.shouldFlip(filePath)) {
        flipped = true;
        const resolved = await realRealpath(...args);
        await createRebindableDirectoryAlias({
          aliasPath: params.symlinkPath,
          targetPath: params.symlinkTarget,
        });
        return resolved;
      }
      return await realRealpath(...args);
    });
  try {
    return await params.run();
  } finally {
    realpathSpy.mockRestore();
  }
}

afterEach(async () => {
  __resetFsSafeNativeConfigForTest();
  __setFsSafeTestHooksForTest(undefined);
});

describe("archive extraction", () => {
  it("enforces deadlines around non-cooperative archive awaits", async () => {
    let finished = false;
    const startedAt = Date.now();

    await expect(
      withExtractionDeadline(1, "extract tar", async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        finished = true;
      }),
    ).rejects.toThrow("extract tar timed out after 1ms");

    expect(Date.now() - startedAt).toBeLessThan(75);
    expect(finished).toBe(false);
  });

  it("extracts zip archives through safe destination checks", async () => {
    const root = await tempRoot("fs-safe-archive-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir, { recursive: true });

    const zip = new JSZip();
    zip.file("package/hello.txt", "hi");
    zip.file("package/my file.txt", "space");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await extractArchive({ archivePath, destDir, timeoutMs: 15_000 });
    const packageDir = await resolvePackedRootDir(destDir);
    await expect(fs.readFile(path.join(packageDir, "hello.txt"), "utf8")).resolves.toBe("hi");
    await expect(fs.readFile(path.join(packageDir, "my file.txt"), "utf8")).resolves.toBe("space");
  });

  it("supports buffer-only ZIP entries while stripping the archive root", async () => {
    const root = await tempRoot("fs-safe-archive-buffer-only-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir);
    const zip = new JSZip();
    zip.file("package/hello.txt", "buffer-only");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await fs.writeFile(archivePath, bytes);

    const loaded = await JSZip.loadAsync(bytes);
    const entry = loaded.file("package/hello.txt");
    const prototype = Object.getPrototypeOf(entry) as object;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "nodeStream");
    expect(descriptor).toBeDefined();
    Object.defineProperty(prototype, "nodeStream", { ...descriptor, value: undefined });
    try {
      await extractArchive({
        archivePath,
        destDir,
        kind: "zip",
        stripComponents: 1,
        timeoutMs: 15_000,
      });
    } finally {
      Object.defineProperty(prototype, "nodeStream", descriptor!);
    }
    await expect(fs.readFile(path.join(destDir, "hello.txt"), "utf8")).resolves.toBe(
      "buffer-only",
    );
  });

  it("copies every byte when staging archive input after short writes", async () => {
    const root = await tempRoot("fs-safe-archive-short-write-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir, { recursive: true });

    const zip = new JSZip();
    zip.file("package/hello.txt", "hi");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    const realOpen = fs.open.bind(fs);
    let shortened = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const flags = Number(args[1]);
      if (!shortened && (flags & fsConstants.O_WRONLY) !== 0) {
        const realWrite = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation(
          (async (
            buffer: Buffer,
            offset?: number,
            length?: number,
            position?: number | null,
          ) => {
            if (
              !shortened &&
              typeof offset === "number" &&
              typeof length === "number" &&
              length > 1
            ) {
              shortened = true;
              return await realWrite(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
            }
            return await realWrite(buffer, offset, length, position);
          }) as FileHandle["write"],
        );
      }
      return handle;
    });

    try {
      await extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 });
    } finally {
      openSpy.mockRestore();
    }

    expect(shortened).toBe(true);
    await expect(fs.readFile(path.join(destDir, "package", "hello.txt"), "utf8")).resolves.toBe(
      "hi",
    );
  });

  itPosix("preserves executable zip entry modes", async () => {
    const root = await tempRoot("fs-safe-archive-mode-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir, { recursive: true });

    const zip = new JSZip();
    zip.file("bin/tool", "#!/bin/sh\n", { unixPermissions: 0o100755 });
    await fs.writeFile(
      archivePath,
      await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
    );

    await extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 });
    const mode = (await fs.stat(path.join(destDir, "bin", "tool"))).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("rejects zip extraction when the deadline elapses before file writes", async () => {
    const root = await tempRoot("fs-safe-archive-timeout-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir, { recursive: true });

    const zip = new JSZip();
    zip.file("package/hello.txt", "hi");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    __setFsSafeTestHooksForTest({
      async beforeArchiveOutputMutation() {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });

    await expect(
      extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 1 }),
    ).rejects.toThrow("extract zip timed out after 1ms");
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
  });

  it("does not truncate existing destination files when zip extraction fails", async () => {
    const root = await tempRoot("fs-safe-archive-fail-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, "keep.txt"), "old-content");

    const zip = new JSZip();
    zip.file("keep.txt", "new-content-that-exceeds-the-entry-limit");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(
      extractArchive({
        archivePath,
        destDir,
        kind: "zip",
        timeoutMs: 15_000,
        limits: { maxEntryBytes: 4 },
      }),
    ).rejects.toMatchObject({
      code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
    });
    await expect(fs.readFile(path.join(destDir, "keep.txt"), "utf8")).resolves.toBe(
      "old-content",
    );
  });

  it("does not remove existing destination directories when zip extraction fails", async () => {
    const root = await tempRoot("fs-safe-archive-dir-conflict-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    const conflictDir = path.join(destDir, "conflict");
    await fs.mkdir(conflictDir, { recursive: true });

    const zip = new JSZip();
    zip.file("conflict", "file-over-dir");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(
      extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
    ).rejects.toBeTruthy();
    await expect(fs.stat(conflictDir)).resolves.toSatisfy((stat) => stat.isDirectory());
  });

  itPosix("rejects zip symlink entries", async () => {
    const root = await tempRoot("fs-safe-archive-link-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    const outsidePath = path.join(root, "outside.txt");
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(outsidePath, "outside", "utf8");

    const zip = new JSZip();
    zip.file("link.txt", outsidePath, { unixPermissions: 0o120777 });
    await fs.writeFile(
      archivePath,
      await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
    );

    await expect(
      extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
    ).rejects.toThrow("zip entry is a link: link.txt");
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
  });

  itPosix("does not clobber out-of-destination file when parent dir is symlink-rebound", async () => {
    const root = await tempRoot("fs-safe-archive-rebind-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    const outsideDir = path.join(root, "outside");
    const slotDir = path.join(destDir, "slot");
    await fs.mkdir(slotDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideTarget = path.join(outsideDir, "target.txt");
    await fs.writeFile(outsideTarget, "SAFE", "utf8");

    const zip = new JSZip();
    zip.file("slot/target.txt", "owned");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await withRealpathSymlinkRebindRace({
      shouldFlip: (realpathInput) => realpathInput === slotDir,
      symlinkPath: slotDir,
      symlinkTarget: outsideDir,
      run: async () => {
        await expect(
          extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
        ).rejects.toMatchObject({
          code: "destination-symlink-traversal",
        } satisfies Partial<ArchiveSecurityError>);
      },
    });

    await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("SAFE");
  });

  itPosix("does not cleanup through a swapped zip entry parent before commit", async () => {
    const root = await tempRoot("fs-safe-archive-cleanup-race-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    const outsideDir = path.join(root, "outside");
    const outsideFile = path.join(outsideDir, "payload.txt");
    await fs.mkdir(destDir);
    await fs.mkdir(outsideDir);
    await fs.writeFile(outsideFile, "outside");
    const zip = new JSZip();
    zip.file("nested/payload.txt", "inside");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    const realMkdir = fs.mkdir.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      const candidate = String(args[0]);
      if (!swapped && path.basename(candidate) === "nested" && await fs.lstat(candidate).then(() => true, () => false)) {
        swapped = true;
        await fs.rename(candidate, path.join(path.dirname(candidate), "nested-real"));
        await fs.symlink(outsideDir, candidate, "dir");
      }
      return await realMkdir(...args);
    });

    await expect(extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }))
      .rejects.toBeTruthy();
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });

  itPosix("rejects zip extraction when a hardlink appears after write", async () => {
    const root = await tempRoot("fs-safe-archive-hardlink-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    const outsideDir = path.join(root, "outside");
    const outsideAlias = path.join(outsideDir, "payload.bin");
    const extractedPath = path.join(destDir, "package", "payload.bin");
    await fs.mkdir(destDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    const extractedRealPath = path.join(await fs.realpath(destDir), "package", "payload.bin");

    const zip = new JSZip();
    zip.file("package/payload.bin", "owned");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    const realLstat = fs.lstat.bind(fs);
    let linked = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (!linked && String(args[0]) === extractedRealPath) {
        await fs.link(extractedRealPath, outsideAlias);
        linked = true;
      }
      return await realLstat(...args);
    });

    try {
      await expect(
        extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
      ).rejects.toMatchObject({
        code: "destination-symlink-traversal",
      } satisfies Partial<ArchiveSecurityError>);
    } finally {
      lstatSpy.mockRestore();
    }

    await expect(fs.readFile(outsideAlias, "utf8")).resolves.toBe("owned");
    await expect(fs.stat(extractedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("pins the archive file before extraction", async () => {
    const root = await tempRoot("fs-safe-archive-input-race-");
    const archivePath = path.join(root, "pkg.zip");
    const replacementPath = path.join(root, "replacement.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir, { recursive: true });

    const zip = new JSZip();
    zip.file("safe.txt", "safe");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    const replacement = new JSZip();
    replacement.file("owned.txt", "owned");
    await fs.writeFile(replacementPath, await replacement.generateAsync({ type: "nodebuffer" }));

    const realLstat = fs.lstat.bind(fs);
    let swapped = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await realLstat(...args);
      if (!swapped && String(args[0]) === archivePath) {
        swapped = true;
        await fs.rename(replacementPath, archivePath);
      }
      return stat;
    });

    try {
      await expect(
        extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
      ).rejects.toThrow("archive changed during validation");
    } finally {
      lstatSpy.mockRestore();
    }
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
  });
});

describe("temp file targets", () => {
  it("sanitizes file names and cleans target directories", async () => {
    const root = await tempRoot("fs-safe-temp-target-");
    expect(sanitizeTempFileName("../bad name?.txt")).toBe("bad-name-.txt");
    expect(
      buildRandomTempFilePath({
        rootDir: root,
        prefix: "demo!",
        extension: "txt",
        now: 123,
        uuid: "abc",
      }),
    ).toBe(path.join(root, "demo-123-abc.txt"));

    let targetDir = "";
    await withTempFile(
      { rootDir: root, prefix: "download", fileName: "../x.txt" },
      async (filePath) => {
        targetDir = path.dirname(filePath);
        await fs.writeFile(filePath, "ok", "utf8");
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("ok");
      },
    );
    await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates explicit temp file targets", async () => {
    const root = await tempRoot("fs-safe-temp-target-");
    const target = await tempFile({ rootDir: root, prefix: "download" });
    expect(target.file("other.txt")).toBe(path.join(target.dir, "other.txt"));
    await fs.writeFile(target.path, "ok", "utf8");
    await target.cleanup();
    await expect(fs.stat(target.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("disposes explicit temp file targets", async () => {
    const root = await tempRoot("fs-safe-temp-target-");
    let dir = "";
    {
      await using target = await tempFile({ rootDir: root, prefix: "download" });
      dir = target.dir;
      await fs.writeFile(target.path, "ok", "utf8");
    }
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
