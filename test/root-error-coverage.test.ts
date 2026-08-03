import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { openLocalFileSafely, root as openRoot } from "../src/root.js";
import { resolvePathWithinRoot, resolveRootContext } from "../src/root-context.js";
import { resolveStrictExistingPathsWithinRoot } from "../src/root-paths.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

describe("Root open error paths", () => {
  itPosix("rejects direct local symlinks before open", async () => {
    const rootDir = await fs.realpath(await tempRoot("fs-safe-local-symlink-"));
    const target = path.join(rootDir, "target.txt");
    const link = path.join(rootDir, "link.txt");
    await fs.writeFile(target, "target");
    await fs.symlink(target, link);

    await expectFsSafeError(openLocalFileSafely({ filePath: link }), "symlink");
  });

  itPosix("maps a final symlink introduced immediately before open", async () => {
    const rootDir = await fs.realpath(await tempRoot("fs-safe-open-symlink-race-"));
    const filePath = path.join(rootDir, "value.txt");
    const displacedPath = path.join(rootDir, "value-original.txt");
    await fs.writeFile(filePath, "trusted");
    const scoped = await openRoot(rootDir);
    __setFsSafeTestHooksForTest({
      async beforeOpen(openedPath) {
        if (openedPath !== filePath) return;
        await fs.rename(filePath, displacedPath);
        await fs.symlink(displacedPath, filePath);
      },
    });

    await expectFsSafeError(scoped.open("value.txt"), "symlink");
    await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe("trusted");
  });

  itPosix("detects followed and rejected symlink swaps after open", async () => {
    const rootDir = await fs.realpath(await tempRoot("fs-safe-open-post-swap-"));
    const first = path.join(rootDir, "first.txt");
    const second = path.join(rootDir, "second.txt");
    const link = path.join(rootDir, "link.txt");
    await fs.writeFile(first, "first");
    await fs.writeFile(second, "second");
    await fs.symlink(first, link);
    const scoped = await openRoot(rootDir);
    __setFsSafeTestHooksForTest({
      async afterOpen(openedPath) {
        if (openedPath !== link) return;
        await fs.rm(link);
        await fs.symlink(second, link);
      },
    });
    await expectFsSafeError(
      scoped.open("link.txt", { symlinks: "follow-within-root" }),
      "path-mismatch",
    );

    const regular = path.join(rootDir, "regular.txt");
    const displaced = path.join(rootDir, "regular-original.txt");
    await fs.writeFile(regular, "regular");
    __setFsSafeTestHooksForTest({
      async afterOpen(openedPath) {
        if (openedPath !== regular) return;
        await fs.rename(regular, displaced);
        await fs.symlink(displaced, regular);
      },
    });
    await expectFsSafeError(scoped.open("regular.txt"), "symlink");
    await expect(fs.readFile(displaced, "utf8")).resolves.toBe("regular");
  });

  it("normalizes a file removed after open and closes on hook failure", async () => {
    const rootDir = await fs.realpath(await tempRoot("fs-safe-open-vanished-"));
    const vanished = path.join(rootDir, "vanished.txt");
    await fs.writeFile(vanished, "value");
    const scoped = await openRoot(rootDir);
    __setFsSafeTestHooksForTest({
      async afterOpen(openedPath) {
        if (openedPath === vanished) await fs.rm(vanished);
      },
    });
    await expectFsSafeError(scoped.open("vanished.txt"), "not-found");

    const failed = path.join(rootDir, "failed.txt");
    await fs.writeFile(failed, "value");
    const sentinel = new Error("after-open failure");
    __setFsSafeTestHooksForTest({
      afterOpen() {
        throw sentinel;
      },
    });
    await expect(openLocalFileSafely({ filePath: failed })).rejects.toBe(sentinel);
  });

  it("does not let descriptor-close failures replace successful reads or disposal", async () => {
    const rootDir = await fs.realpath(await tempRoot("fs-safe-close-failure-"));
    const first = path.join(rootDir, "first.txt");
    const second = path.join(rootDir, "second.txt");
    const third = path.join(rootDir, "third.txt");
    await fs.writeFile(first, "first");
    await fs.writeFile(second, "second");
    await fs.writeFile(third, "third");
    const cleanups: Array<() => Promise<void>> = [];
    const failClose = (handle: Awaited<ReturnType<typeof fs.open>>) => {
      cleanups.push(handle.close.bind(handle));
      Object.defineProperty(handle, "close", {
        configurable: true,
        value: async () => {
          throw new Error("injected close failure");
        },
      });
    };

    const opened = await openLocalFileSafely({ filePath: first });
    failClose(opened.handle);
    await expect(opened[Symbol.asyncDispose]()).resolves.toBeUndefined();

    const scoped = await openRoot(rootDir);
    __setFsSafeTestHooksForTest({
      afterOpen(openedPath, handle) {
        if (openedPath === second || openedPath === third) failClose(handle);
      },
    });
    await expect(scoped.readText("second.txt")).resolves.toBe("second");
    await expect(resolveStrictExistingPathsWithinRoot({
      rootDir,
      requestedPaths: ["third.txt"],
      scopeLabel: "test root",
    })).resolves.toMatchObject({ ok: true });

    await Promise.all(cleanups.map(async (cleanup) => await cleanup()));
  });
});

describe("Root writable error paths", () => {
  itPosix("rejects a hardlink or symlink introduced only after the writable open", async () => {
    const rootDir = await fs.realpath(await tempRoot("fs-safe-writable-open-race-"));
    const hardlinkTarget = path.join(rootDir, "hardlink-target.txt");
    const hardlinkAlias = path.join(rootDir, "hardlink-alias.txt");
    const symlinkTarget = path.join(rootDir, "symlink-target.txt");
    const symlinkOriginal = path.join(rootDir, "symlink-original.txt");
    const outside = await fs.realpath(await tempRoot("fs-safe-writable-open-outside-"));
    const outsideFile = path.join(outside, "outside.txt");
    await fs.writeFile(hardlinkTarget, "hardlink");
    await fs.writeFile(symlinkTarget, "inside");
    await fs.writeFile(outsideFile, "outside");
    const scoped = await openRoot(rootDir);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      const handle = await realOpen(candidate, flags, mode);
      if (String(candidate) === hardlinkTarget) {
        await fs.link(hardlinkTarget, hardlinkAlias);
      } else if (String(candidate) === symlinkTarget) {
        await fs.rename(symlinkTarget, symlinkOriginal);
        await fs.symlink(outsideFile, symlinkTarget);
      }
      return handle;
    });

    await expectFsSafeError(scoped.openWritable("hardlink-target.txt"), "hardlink");
    await expectFsSafeError(scoped.openWritable("symlink-target.txt"), "symlink");
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
    await expect(fs.readFile(symlinkOriginal, "utf8")).resolves.toBe("inside");
  });

  it("maps a no-follow writable open failure and preserves unknown open errors", async () => {
    const rootDir = await fs.realpath(await tempRoot("fs-safe-writable-open-errors-"));
    const symlinkRace = path.join(rootDir, "symlink-race.txt");
    const denied = path.join(rootDir, "denied.txt");
    await fs.writeFile(symlinkRace, "value");
    await fs.writeFile(denied, "value");
    const scoped = await openRoot(rootDir);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      if (String(candidate) === symlinkRace) {
        throw Object.assign(new Error("symlink loop"), { code: "ELOOP" });
      }
      if (String(candidate) === denied) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return await realOpen(candidate, flags, mode);
    });

    await expectFsSafeError(scoped.openWritable("symlink-race.txt"), "symlink");
    await expect(scoped.openWritable("denied.txt")).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("root context error paths", () => {
  it("exposes the public convenience resolver and preserves an unexpected root lookup errno", async () => {
    const rootDir = await fs.realpath(await tempRoot("fs-safe-root-context-"));
    await expect(resolvePathWithinRoot({ rootDir, relativePath: "value.txt" }))
      .resolves.toMatchObject({ resolved: path.join(rootDir, "value.txt") });

    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "realpath").mockRejectedValueOnce(denied);
    await expect(resolveRootContext(rootDir)).rejects.toBe(denied);
  });
});
