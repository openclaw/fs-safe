import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";

const { tempRoot } = useTempDirs();


async function replaceParentAfterOpen(params: {
  targetPath: string;
  parentPath: string;
  movedParentPath: string;
  symlinkTargetPath: string;
}): Promise<() => void> {
  const originalOpen = fs.open;
  let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === params.targetPath) {
      closeSpy = vi.spyOn(handle, "close");
      await fs.rename(params.parentPath, params.movedParentPath);
      await fs.symlink(params.symlinkTargetPath, params.parentPath, "dir");
    }
    return handle;
  });
  return () => {
    openSpy.mockRestore();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
});

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("guarded fallback write cleanup", () => {
  itPosix("closes pinned no-overwrite handles when post guards fail", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    configureFsSafeNative({ mode: "off" });
    const base = await tempRoot("fs-safe-pinned-post-guard-");
    const parentPath = path.join(base, "nested");
    const movedParentPath = path.join(base, "nested-real");
    const targetPath = path.join(parentPath, "created.txt");
    const outside = await tempRoot("fs-safe-pinned-post-guard-outside-");
    const outsideFile = path.join(outside, "created.txt");
    await fs.mkdir(parentPath);
    await fs.writeFile(outsideFile, "outside");
    const assertClosed = await replaceParentAfterOpen({
      targetPath,
      parentPath,
      movedParentPath,
      symlinkTargetPath: outside,
    });

    await expect(
      runPinnedWriteHelper({
        rootPath: base,
        relativeParentPath: "nested",
        basename: "created.txt",
        mkdir: false,
        mode: 0o600,
        overwrite: false,
        input: { kind: "buffer", data: "payload" },
      }),
    ).rejects.toBeTruthy();

    assertClosed();
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });

  itPosix("closes root no-overwrite handles when post guards fail", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const { root: openRoot } = await import("../src/index.js");
    const base = await tempRoot("fs-safe-root-post-guard-");
    const parentPath = path.join(base, "nested");
    const movedParentPath = path.join(base, "nested-real");
    const outside = await tempRoot("fs-safe-root-post-guard-outside-");
    const outsideFile = path.join(outside, "created.txt");
    await fs.mkdir(parentPath);
    await fs.writeFile(outsideFile, "outside");
    const targetPath = path.join(await fs.realpath(parentPath), "created.txt");
    const assertClosed = await replaceParentAfterOpen({
      targetPath,
      parentPath,
      movedParentPath,
      symlinkTargetPath: outside,
    });
    const scoped = await openRoot(base);

    await expect(scoped.create("nested/created.txt", "payload")).rejects.toBeTruthy();

    assertClosed();
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });
});
