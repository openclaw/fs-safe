import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { extractArchive } from "../src/archive.js";
import { configureFsSafeNative, root as openRoot } from "../src/index.js";
import { prepareArchiveDestinationDir, prepareArchiveOutputPath, mergeExtractedTreeIntoDestination } from "../src/archive-staging.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { writeJsonSync } from "../src/json.js";
import {
  moveJsonDurableQueueEntryToFailed,
  resolveJsonDurableQueueEntryPaths,
} from "../src/json-durable-queue.js";
import { movePathWithCopyFallback } from "../src/move-path.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { replaceFileAtomic } from "../src/replace-file.js";
import { writeViaSiblingTempPath } from "../src/sibling-temp.js";
import { sanitizeTempFileName, tempFile } from "../src/temp-target.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/private-temp-workspace.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { movePathToTrash } from "../src/trash.js";

const { tempRoot } = useTempDirs();
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;


async function writeOldFile(filePath: string, content = "old"): Promise<void> {
  await fsp.writeFile(filePath, content);
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(filePath, old, old);
}

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
  configureFsSafeNative({ mode: "auto" });
  __setFsSafeTestHooksForTest(undefined);
});

describe("security finding regressions", () => {
  itPosix("guards Root fallback mutators against parent swaps", async () => {
    configureFsSafeNative({ mode: "off" });
    const base = await tempRoot("fs-safe-root-fallback-race-");
    const outside = await tempRoot("fs-safe-root-fallback-outside-");
    await fsp.mkdir(path.join(base, "nested"));
    await fsp.writeFile(path.join(base, "nested", "delete.txt"), "inside");
    await fsp.writeFile(path.join(base, "from.txt"), "move");
    await fsp.writeFile(path.join(outside, "delete.txt"), "outside");
    const scoped = await openRoot(base);

    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation) {
        if (operation !== "remove") return;
        await fsp.rename(path.join(base, "nested"), path.join(base, "nested-real"));
        await fsp.symlink(outside, path.join(base, "nested"), "dir");
      },
    });
    await expect(scoped.remove("nested/delete.txt")).rejects.toBeTruthy();
    await expect(fsp.readFile(path.join(outside, "delete.txt"), "utf8")).resolves.toBe("outside");

    await fsp.rm(path.join(base, "nested"));
    await fsp.rename(path.join(base, "nested-real"), path.join(base, "nested"));
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation) {
        if (operation !== "mkdir") return;
        await fsp.rename(path.join(base, "nested"), path.join(base, "nested-real"));
        await fsp.symlink(outside, path.join(base, "nested"), "dir");
      },
    });
    await expect(scoped.mkdir("nested/created")).rejects.toBeTruthy();
    await expect(fsp.stat(path.join(outside, "created"))).rejects.toMatchObject({ code: "ENOENT" });

    await fsp.rm(path.join(base, "nested"));
    await fsp.rename(path.join(base, "nested-real"), path.join(base, "nested"));
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation) {
        if (operation !== "move") return;
        await fsp.rename(path.join(base, "nested"), path.join(base, "nested-real"));
        await fsp.symlink(outside, path.join(base, "nested"), "dir");
      },
    });
    await expect(scoped.move("from.txt", "nested/moved.txt")).rejects.toBeTruthy();
    await expect(fsp.stat(path.join(outside, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("does not create archive directories through a swapped destination", async () => {
    const base = await tempRoot("fs-safe-archive-dir-race-");
    const dest = path.join(base, "dest");
    const outside = await tempRoot("fs-safe-archive-dir-outside-");
    await fsp.mkdir(dest);
    const destinationRealDir = await prepareArchiveDestinationDir(dest);

    __setFsSafeTestHooksForTest({
      async beforeArchiveOutputMutation(operation) {
        if (operation !== "mkdir") return;
        await fsp.rename(dest, path.join(base, "dest-real"));
        await fsp.symlink(outside, dest, "dir");
      },
    });

    await expect(
      prepareArchiveOutputPath({
        destinationDir: dest,
        destinationRealDir,
        relPath: "nested/payload.txt",
        outPath: path.join(dest, "nested", "payload.txt"),
        originalPath: "nested/payload.txt",
        isDirectory: false,
      }),
    ).rejects.toBeTruthy();
    await expect(fsp.stat(path.join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("does not chmod through an archive entry symlink swap", async () => {
    const base = await tempRoot("fs-safe-archive-chmod-race-");
    const source = path.join(base, "source");
    const dest = path.join(base, "dest");
    const outside = await tempRoot("fs-safe-archive-chmod-outside-");
    const outsideFile = path.join(outside, "outside.txt");
    await fsp.mkdir(source);
    await fsp.mkdir(dest);
    await fsp.writeFile(path.join(source, "payload.txt"), "payload");
    await fsp.writeFile(outsideFile, "outside");
    await fsp.chmod(outsideFile, 0o600);
    const destinationRealDir = await prepareArchiveDestinationDir(dest);

    __setFsSafeTestHooksForTest({
      async beforeArchiveOutputMutation(operation, targetPath) {
        if (operation !== "chmod" || !targetPath.endsWith("payload.txt")) return;
        await fsp.rm(targetPath, { force: true });
        await fsp.symlink(outsideFile, targetPath, "file");
      },
    });

    await expect(
      mergeExtractedTreeIntoDestination({ sourceDir: source, destinationDir: dest, destinationRealDir }),
    ).rejects.toBeTruthy();
    expect((await fsp.stat(outsideFile)).mode & 0o777).toBe(0o600);
  });

  itPosix("uses unguessable no-follow temp files in pinned write fallback", async () => {
    configureFsSafeNative({ mode: "off" });
    const base = await tempRoot("fs-safe-pinned-write-fallback-");
    const outside = await tempRoot("fs-safe-pinned-write-outside-");
    const outsideFile = path.join(outside, "outside.txt");
    await fsp.writeFile(outsideFile, "outside");
    await fsp.symlink(outsideFile, path.join(base, ".victim.txt.fallback.tmp"), "file");

    await runPinnedWriteHelper({
      rootPath: base,
      relativeParentPath: "",
      basename: "victim.txt",
      mkdir: true,
      mode: 0o600,
      overwrite: true,
      input: { kind: "buffer", data: "safe" },
    });

    await expect(fsp.readFile(path.join(base, "victim.txt"), "utf8")).resolves.toBe("safe");
    await expect(fsp.readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });

  it("validates pinned write fallback payloads even when native mode is off", async () => {
    configureFsSafeNative({ mode: "off" });
    const parent = await tempRoot("fs-safe-pinned-write-validation-");
    const base = path.join(parent, "root");
    await fsp.mkdir(base);
    await expect(
      runPinnedWriteHelper({
        rootPath: base,
        relativeParentPath: "../escape",
        basename: "victim.txt",
        mkdir: true,
        mode: 0o600,
        overwrite: true,
        input: { kind: "buffer", data: "bad" },
      }),
    ).rejects.toBeTruthy();
    await expect(fsp.lstat(path.join(parent, "escape", "victim.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  itPosix("guards private sync store writes against parent swaps", async () => {
    const base = await tempRoot("fs-safe-sync-private-write-");
    const outside = await tempRoot("fs-safe-sync-private-outside-");
    await fsp.mkdir(path.join(base, "nested"));
    const store = fileStoreSync({ rootDir: base, private: true });

    __setFsSafeTestHooksForTest({
      beforeFileStoreSyncPrivateWrite() {
        fsSync.renameSync(path.join(base, "nested"), path.join(base, "nested-real"));
        fsSync.symlinkSync(outside, path.join(base, "nested"), "dir");
      },
    });

    expect(() => store.writeText("nested/value.txt", "secret")).toThrow();
    await expect(fsp.stat(path.join(outside, "value.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("pins sync store reads against final symlink swaps", async () => {
    const base = await tempRoot("fs-safe-sync-read-race-");
    const outside = await tempRoot("fs-safe-sync-read-outside-");
    const filePath = path.join(base, "value.txt");
    const outsideFile = path.join(outside, "outside.txt");
    await fsp.writeFile(filePath, "inside");
    await fsp.writeFile(outsideFile, "outside");
    const originalReadFileSync = fsSync.readFileSync;
    let swapped = false;
    vi.spyOn(fsSync, "readFileSync").mockImplementation((target, options) => {
      if (!swapped && typeof target === "number") {
        swapped = true;
        fsSync.rmSync(filePath);
        fsSync.symlinkSync(outsideFile, filePath, "file");
      }
      return originalReadFileSync.call(fsSync, target, options as never);
    });

    const store = fileStoreSync({ rootDir: base, private: true });
    expect(store.readTextIfExists("value.txt")).toBe("inside");
    expect(fsSync.readFileSync(outsideFile, "utf8")).toBe("outside");
  });

  itPosix("does not recurse prune through a swapped directory symlink", async () => {
    const base = await tempRoot("fs-safe-prune-race-");
    const outside = await tempRoot("fs-safe-prune-outside-");
    await fsp.mkdir(path.join(base, "cache"));
    await writeOldFile(path.join(base, "cache", "old.txt"));
    await writeOldFile(path.join(outside, "old.txt"), "outside");
    const store = fileStore({ rootDir: base });

    __setFsSafeTestHooksForTest({
      async beforeFileStorePruneDescend(dirPath) {
        if (!dirPath.endsWith("cache")) return;
        await fsp.rename(path.join(base, "cache"), path.join(base, "cache-real"));
        await fsp.symlink(outside, path.join(base, "cache"), "dir");
      },
    });

    await store.pruneExpired({ ttlMs: 1, recursive: true });
    await expect(fsp.readFile(path.join(outside, "old.txt"), "utf8")).resolves.toBe("outside");
  });

  itPosix("does not copy JSON through a raced fallback symlink", async () => {
    const base = await tempRoot("fs-safe-json-fallback-race-");
    const outside = await tempRoot("fs-safe-json-fallback-outside-");
    const target = path.join(base, "state.json");
    const outsideFile = path.join(outside, "outside.json");
    await fsp.writeFile(target, "{}");
    await fsp.writeFile(outsideFile, "outside");
    const originalRenameSync = fsSync.renameSync;
    const originalLstatSync = fsSync.lstatSync;
    let forced = false;
    let swapped = false;
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (!forced && to === target) {
        forced = true;
        throw Object.assign(new Error("forced EPERM"), { code: "EPERM" });
      }
      return originalRenameSync.call(fsSync, from, to);
    });
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      const stat = originalLstatSync.call(fsSync, candidate, options as never);
      if (!swapped && candidate === target && forced) {
        swapped = true;
        fsSync.rmSync(target);
        fsSync.symlinkSync(outsideFile, target, "file");
      }
      return stat;
    });

    writeJsonSync(target, { ok: true });
    await expect(fsp.readFile(outsideFile, "utf8")).resolves.toBe("outside");
    await expect(fsp.readFile(target, "utf8")).resolves.toContain('"ok": true');
  });

  itPosix("does not chmod existing parents during sync JSON writes", async () => {
    const base = await tempRoot("fs-safe-json-parent-mode-");
    const parent = path.join(base, "shared");
    await fsp.mkdir(parent, { mode: 0o755 });
    await fsp.chmod(parent, 0o755);

    writeJsonSync(path.join(parent, "state.json"), { ok: true });

    expect((await fsp.stat(parent)).mode & 0o777).toBe(0o755);
  });

  itPosix("does not copy atomic fallback through a raced destination symlink", async () => {
    const base = await tempRoot("fs-safe-atomic-fallback-race-");
    const outside = await tempRoot("fs-safe-atomic-fallback-outside-");
    const target = path.join(base, "state.txt");
    const outsideFile = path.join(outside, "outside.txt");
    await fsp.writeFile(target, "old");
    await fsp.writeFile(outsideFile, "outside");
    const originalLstat = fsp.lstat;
    let swapped = false;

    await replaceFileAtomic({
      filePath: target,
      content: "new",
      copyFallbackOnPermissionError: true,
      fileSystem: {
        promises: {
          ...fsp,
          rename: async () => {
            throw Object.assign(new Error("forced EPERM"), { code: "EPERM" });
          },
          lstat: async (candidate) => {
            const stat = await originalLstat(candidate);
            if (!swapped && candidate === target) {
              swapped = true;
              await fsp.rm(target);
              await fsp.symlink(outsideFile, target, "file");
            }
            return stat;
          },
        },
      },
    });

    await expect(fsp.readFile(outsideFile, "utf8")).resolves.toBe("outside");
    await expect(fsp.readFile(target, "utf8")).resolves.toBe("new");
  });

  itPosix("stages EXDEV file moves without buffering or chmodding parents", async () => {
    const base = await tempRoot("fs-safe-move-exdev-mode-");
    const source = path.join(base, "source.bin");
    const destDir = path.join(base, "public");
    const dest = path.join(destDir, "dest.bin");
    await fsp.mkdir(destDir, { mode: 0o755 });
    await fsp.chmod(destDir, 0o755);
    await fsp.writeFile(source, Buffer.alloc(1024 * 1024, 7));
    const realRename = fsp.rename;
    const realReadFile = fsp.readFile;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      return await realRename(from, to);
    });
    vi.spyOn(fsp, "readFile").mockImplementation(async (target, options) => {
      if (target === source) {
        throw new Error("move fallback must not buffer source files");
      }
      return await realReadFile(target, options as never);
    });

    await movePathWithCopyFallback({ from: source, to: dest });

    expect((await fsp.stat(destDir)).mode & 0o777).toBe(0o755);
    await expect(fsp.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fsp.readFile(dest)).byteLength).toBe(1024 * 1024);
  });

  itPosix("preserves default directory modes for zip staging parents", async () => {
    const expectedDirectoryMode = 0o777 & ~process.umask();
    const base = await tempRoot("fs-safe-zip-dir-mode-");
    const archivePath = path.join(base, "pkg.zip");
    const destDir = path.join(base, "dest");
    await fsp.mkdir(destDir);
    const zip = new JSZip();
    zip.file("assets/app.js", "console.log('ok');");
    await fsp.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 });

    expect((await fsp.stat(path.join(destDir, "assets"))).mode & 0o777).toBe(expectedDirectoryMode);
  });

  it("rejects durable queue ids that are not safe path segments", async () => {
    const base = await tempRoot("fs-safe-queue-id-");
    expect(() => resolveJsonDurableQueueEntryPaths(base, "../escape")).toThrow();
    await expect(
      moveJsonDurableQueueEntryToFailed({ queueDir: base, failedDir: path.join(base, "failed"), id: "nested/escape" }),
    ).rejects.toBeTruthy();
    await expect(fsp.lstat(path.join(base, "failed", "nested", "escape.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps dot-only temp filenames inside the private temp directory", async () => {
    const base = await tempRoot("fs-safe-temp-dot-");
    expect(sanitizeTempFileName("..")).toBe("download.bin");
    expect(sanitizeTempFileName("./..")).toBe("download.bin");
    const target = await tempFile({ rootDir: base, prefix: "download", fileName: ".." });
    try {
      expect(target.path).toBe(path.join(target.dir, "download.bin"));
      expect(target.file("..")).toBe(path.join(target.dir, "download.bin"));
    } finally {
      await target.cleanup();
    }
  });

  it("accepts safe temp workspace leaf names with spaces and dot prefixes", async () => {
    await using workspace = await tempWorkspace({
      rootDir: await tempRoot("fs-safe-workspace-leaf-"),
      prefix: "work-",
    });

    await workspace.writeText("report 2026.txt", "ok");
    await workspace.writeText(".env", "TOKEN=ok");

    await expect(workspace.read("report 2026.txt")).resolves.toEqual(Buffer.from("ok"));
    await expect(workspace.read(".env")).resolves.toEqual(Buffer.from("TOKEN=ok"));
  });

  itPosix("pins sync temp workspace reads against final symlink swaps", async () => {
    const base = await tempRoot("fs-safe-temp-workspace-sync-read-");
    const outside = await tempRoot("fs-safe-temp-workspace-sync-outside-");
    const workspace = tempWorkspaceSync({ rootDir: base, prefix: "ws-" });
    try {
      workspace.write("value.bin", Buffer.from([0, 1, 2, 3]));
      const outsideFile = path.join(outside, "outside.bin");
      fsSync.writeFileSync(outsideFile, "outside");
      const targetPath = workspace.path("value.bin");
      const originalReadFileSync = fsSync.readFileSync;
      let swapped = false;
      vi.spyOn(fsSync, "readFileSync").mockImplementation((target, options) => {
        if (!swapped && typeof target === "number") {
          swapped = true;
          fsSync.rmSync(targetPath);
          fsSync.symlinkSync(outsideFile, targetPath, "file");
        }
        return originalReadFileSync.call(fsSync, target, options as never);
      });

      expect([...workspace.read("value.bin")]).toEqual([0, 1, 2, 3]);
      expect(fsSync.readFileSync(outsideFile, "utf8")).toBe("outside");
    } finally {
      workspace.cleanup();
    }
  });

  itPosix("writes sibling-temp content from a private temp path, not a swapped target parent", async () => {
    const base = await tempRoot("fs-safe-sibling-temp-race-");
    const outside = await tempRoot("fs-safe-sibling-temp-outside-");
    await fsp.mkdir(path.join(base, "nested"));

    __setFsSafeTestHooksForTest({
      async beforeSiblingTempWrite() {
        await fsp.rename(path.join(base, "nested"), path.join(base, "nested-real"));
        await fsp.symlink(outside, path.join(base, "nested"), "dir");
      },
    });

    await expect(
      writeViaSiblingTempPath({
        rootDir: base,
        targetPath: path.join(base, "nested", "out.txt"),
        writeTemp: async (tempPath) => {
          await fsp.writeFile(tempPath, "secret");
        },
      }),
    ).rejects.toBeTruthy();
    await expect(fsp.stat(path.join(outside, "out.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("does not trash a different path after an allowed parent swap", async () => {
    const base = await tempRoot("fs-safe-trash-race-");
    const outside = await tempRoot("fs-safe-trash-outside-");
    await fsp.mkdir(path.join(base, "dir"));
    await fsp.writeFile(path.join(base, "dir", "victim.txt"), "inside");
    await fsp.writeFile(path.join(outside, "victim.txt"), "outside");

    __setFsSafeTestHooksForTest({
      beforeTrashMove() {
        fsSync.renameSync(path.join(base, "dir"), path.join(base, "dir-real"));
        fsSync.symlinkSync(outside, path.join(base, "dir"), "dir");
      },
    });

    await expect(movePathToTrash(path.join(base, "dir", "victim.txt"), { allowedRoots: [base] }))
      .rejects.toBeTruthy();
    await expect(fsp.readFile(path.join(outside, "victim.txt"), "utf8")).resolves.toBe("outside");
  });
});
