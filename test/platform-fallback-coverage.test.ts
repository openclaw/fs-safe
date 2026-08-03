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
});
