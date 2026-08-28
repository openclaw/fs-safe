import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");


async function importRootForPlatform(platform: NodeJS.Platform) {
  vi.resetModules();
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
  return await import("../src/root.js");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("node:fs/promises");
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  vi.resetModules();
});

describe("platform fallback coverage", () => {
  it("falls back for stat and list on Windows", async () => {
    const { root: openRoot } = await importRootForPlatform("win32");
    const rootDir = await tempRoot("fs-safe-win-stat-list-");
    await fs.mkdir(path.join(rootDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "nested", "file.txt"), "ok", "utf8");
    const scoped = await openRoot(rootDir);

    await expect(scoped.stat("nested/file.txt")).resolves.toMatchObject({
      isFile: true,
      size: 2,
    });
    await expect(scoped.list("nested")).resolves.toEqual(["file.txt"]);
    await expect(scoped.list("nested", { withFileTypes: true })).resolves.toMatchObject([
      { name: "file.txt", isFile: true, size: 2 },
    ]);
  });

  it("exercises root write, copy, mkdir, and remove fallbacks used on Windows", async () => {
    const { root: openRoot } = await importRootForPlatform("win32");
    const rootDir = await tempRoot("fs-safe-win-fallback-");
    const sourceDir = await tempRoot("fs-safe-win-fallback-source-");
    const source = path.join(sourceDir, "source.txt");
    await fs.writeFile(source, "copied", "utf8");
    const scoped = await openRoot(rootDir, { mkdir: true });

    await scoped.mkdir("nested");
    await scoped.write("nested/file.txt", "first");
    await expect(fs.readFile(path.join(rootDir, "nested", "file.txt"), "utf8")).resolves.toBe(
      "first",
    );

    await scoped.write("nested/file.txt", Buffer.from("second"));
    await expect(fs.readFile(path.join(rootDir, "nested", "file.txt"), "utf8")).resolves.toBe(
      "second",
    );
    await expect(scoped.create("nested/file.txt", "third")).rejects.toMatchObject({
      code: "already-exists",
    });
    await scoped.create("nested/created.txt", "created");
    await expect(fs.readFile(path.join(rootDir, "nested", "created.txt"), "utf8")).resolves.toBe(
      "created",
    );

    await scoped.copyIn("nested/copied.txt", source, { maxBytes: 16 });
    await expect(fs.readFile(path.join(rootDir, "nested", "copied.txt"), "utf8")).resolves.toBe(
      "copied",
    );
    await expect(scoped.copyIn("nested/too-large.txt", source, { maxBytes: 3 })).rejects.toMatchObject({
      code: "too-large",
    });

    await scoped.remove("nested/copied.txt");
    await expect(fs.stat(path.join(rootDir, "nested", "copied.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prunes empty directories through the Windows remove fallback", async () => {
    await importRootForPlatform("win32");
    const { fileStore } = await import("../src/file-store.js");
    const rootDir = await tempRoot("fs-safe-win-prune-");
    const store = fileStore({ rootDir });
    const stalePath = path.join(rootDir, "old", "stale.txt");
    await fs.mkdir(path.dirname(stalePath), { recursive: true });
    await fs.writeFile(stalePath, "stale", "utf8");
    await fs.utimes(stalePath, new Date(0), new Date(0));

    await store.pruneExpired({ ttlMs: 1, recursive: true, pruneEmptyDirs: true });

    // Root.remove's Node fallback must use rmdir for empty directories; fs.rm
    // without recursive rejects dirs and would silently leave pruneEmptyDirs work.
    await expect(fs.stat(path.join(rootDir, "old"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps Windows fallback mutation failures to stable FsSafeError codes", async () => {
    const { root: openRoot } = await importRootForPlatform("win32");
    const rootDir = await tempRoot("fs-safe-win-errors-");
    const scoped = await openRoot(rootDir, { mkdir: true });

    await fs.mkdir(path.join(rootDir, "directory"));
    await fs.mkdir(path.join(rootDir, "non-empty"));
    await fs.writeFile(path.join(rootDir, "non-empty", "child.txt"), "child");
    await fs.writeFile(path.join(rootDir, "source.txt"), "source");
    await fs.writeFile(path.join(rootDir, "existing.txt"), "existing");
    await fs.writeFile(path.join(rootDir, "hardlink-origin.txt"), "linked");
    await fs.link(path.join(rootDir, "hardlink-origin.txt"), path.join(rootDir, "hardlink.txt"));

    await expect(scoped.openWritable("missing/child.txt", { mkdir: false }))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(scoped.write("directory", "data"))
      .rejects.toMatchObject({ code: "not-file" });
    await expect(scoped.remove("missing.txt"))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(scoped.remove("non-empty"))
      .rejects.toMatchObject({ code: "not-empty" });
    await expect(scoped.stat("missing.txt"))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(scoped.list("missing"))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(scoped.list("source.txt"))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(scoped.move("missing.txt", "moved.txt"))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(scoped.move("hardlink.txt", "moved-hardlink.txt"))
      .rejects.toMatchObject({ code: "hardlink" });
    await expect(scoped.move("directory", "moved-directory"))
      .rejects.toMatchObject({ code: "invalid-path" });
    await expect(scoped.move("source.txt", "existing.txt"))
      .rejects.toMatchObject({ code: "already-exists" });
    await expect(scoped.move("source.txt", "missing-parent/moved.txt"))
      .rejects.toMatchObject({ code: "not-found" });

    await expect(fs.readFile(path.join(rootDir, "source.txt"), "utf8")).resolves.toBe("source");
    await expect(fs.readFile(path.join(rootDir, "existing.txt"), "utf8")).resolves.toBe("existing");
  });

  it("rejects every denied mutation before a Windows fallback syscall", async () => {
    const { root: openRoot } = await importRootForPlatform("win32");
    const rootDir = await tempRoot("fs-safe-win-denied-");
    const denied = path.join(rootDir, "denied");
    await fs.mkdir(denied);
    await fs.writeFile(path.join(denied, "source.txt"), "source");
    const scoped = await openRoot(rootDir, {
      mkdir: true,
      denyMutations: { prefixes: [denied] },
    });

    await expect(scoped.write("denied/write.txt", "data"))
      .rejects.toMatchObject({ code: "denied-path" });
    await expect(scoped.mkdir("denied/nested"))
      .rejects.toMatchObject({ code: "denied-path" });
    await expect(scoped.remove("denied/source.txt"))
      .rejects.toMatchObject({ code: "denied-path" });
    await expect(scoped.move("denied/source.txt", "moved.txt"))
      .rejects.toMatchObject({ code: "denied-path" });
    await expect(scoped.move("moved.txt", "denied/target.txt"))
      .rejects.toMatchObject({ code: "denied-path" });

    await expect(fs.readFile(path.join(denied, "source.txt"), "utf8")).resolves.toBe("source");
    await expect(fs.readdir(denied)).resolves.toEqual(["source.txt"]);
  });

  itPosix("rejects symlinked missing mkdir components in fallback", async () => {
    const { root: openRoot } = await importRootForPlatform("win32");
    const { __setFsSafeTestHooksForTest } = await import("../src/test-hooks.js");
    const rootDir = await tempRoot("fs-safe-win-mkdir-race-");
    const outsideDir = await tempRoot("fs-safe-win-mkdir-outside-");
    const scoped = await openRoot(rootDir);
    const racedComponent = path.join(rootDir, "link");
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation, targetPath) {
        if (operation !== "mkdir" || path.basename(targetPath) !== "link") return;
        await fs.symlink(outsideDir, targetPath, "dir");
      },
    });

    await expect(scoped.mkdir("link/created")).rejects.toBeTruthy();
    await expect(fs.stat(path.join(outsideDir, "created"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("does not remove an attacker file after a missing-write verification race", async () => {
    const { root: openRoot } = await importRootForPlatform("win32");
    const verification = await import("../src/root-write-verification.js");
    const verifyPublished = verification.verifyAtomicWriteResult;
    const rootDir = await fs.realpath(await tempRoot("fs-safe-win-create-cleanup-"));
    const outsideDir = await fs.realpath(await tempRoot("fs-safe-win-create-cleanup-outside-"));
    const parent = path.join(rootDir, "nested");
    const target = path.join(parent, "created.txt");
    const outsideTarget = path.join(outsideDir, "created.txt");
    await fs.mkdir(parent);
    await fs.writeFile(outsideTarget, "attacker");
    const scoped = await openRoot(rootDir, { mkdir: false });
    let swapped = false;
    vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params, reopenVerified) => {
      expect(params.targetPath).toBe(target);
      swapped = true;
      await fs.rename(parent, `${parent}-original`);
      await fs.symlink(outsideDir, parent, "dir");
      await verifyPublished(params, reopenVerified);
    });

    await expect(scoped.create("nested/created.txt", "library", {
      renameIdentity: "verify-content-with-lock",
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("attacker");
    await expect(fs.readFile(path.join(`${parent}-original`, "created.txt"), "utf8"))
      .resolves.toBe("library");
  });

  itPosix("warns when overwrite verification detects a parent swap", async () => {
    const { root: openRoot } = await importRootForPlatform("win32");
    const verification = await import("../src/root-write-verification.js");
    const verifyPublished = verification.verifyAtomicWriteResult;
    const rootDir = await fs.realpath(await tempRoot("fs-safe-win-overwrite-warning-"));
    const outsideDir = await fs.realpath(await tempRoot("fs-safe-win-overwrite-warning-outside-"));
    const parent = path.join(rootDir, "nested");
    const target = path.join(parent, "value.txt");
    const outsideTarget = path.join(outsideDir, "value.txt");
    await fs.mkdir(parent);
    await fs.writeFile(target, "old");
    await fs.writeFile(outsideTarget, "attacker");
    const scoped = await openRoot(rootDir, { mkdir: false });
    const priorWarnings = process.env.FS_SAFE_DEBUG_WARNINGS;
    process.env.FS_SAFE_DEBUG_WARNINGS = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let swapped = false;
    vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params, reopenVerified) => {
      expect(params.targetPath).toBe(target);
      swapped = true;
      await fs.rename(parent, `${parent}-original`);
      await fs.symlink(outsideDir, parent, "dir");
      await verifyPublished(params, reopenVerified);
    });

    try {
      await expect(scoped.write("nested/value.txt", "library", {
        renameIdentity: "verify-content-with-lock",
      })).rejects.toMatchObject({ code: "path-mismatch" });
    } finally {
      if (priorWarnings === undefined) {
        delete process.env.FS_SAFE_DEBUG_WARNINGS;
      } else {
        process.env.FS_SAFE_DEBUG_WARNINGS = priorWarnings;
      }
    }
    expect(swapped).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("post-write verification failed"));
    await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("attacker");
    await expect(fs.readFile(path.join(`${parent}-original`, "value.txt"), "utf8"))
      .resolves.toBe("library");
  });
});
