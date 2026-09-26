import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendRegularFile } from "../src/regular-file.js";
import { assertNoSymlinkParentsSync } from "../src/symlink-parents.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.restoreAllMocks());

// path.join normalizes `..` away. Keep the raw segment so the guard sees it.
function rawPath(rootDir: string, ...segments: string[]): string {
  return [rootDir, ...segments].join(path.sep);
}

async function symlinkDir(target: string, linkPath: string): Promise<void> {
  await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

describe("symlink parents cancelled by dotdot", () => {
  it("rejects a symlink ancestor that dotdot would lexically cancel", async () => {
    const base = await tempRoot("fs-safe-symlink-dotdot-");
    const rootDir = path.join(base, "root");
    const outside = path.join(base, "outside");
    await fs.mkdir(path.join(rootDir, "sub"), { recursive: true });
    await fs.mkdir(outside);
    await symlinkDir(outside, path.join(rootDir, "sub", "up"));

    expect(() => assertNoSymlinkParentsSync({
      rootDir,
      targetPath: rawPath(rootDir, "sub", "up", "..", "secret"),
    })).toThrow(/must not traverse symlinked directory/);
  });

  it("allows dotdot through a real directory", async () => {
    const rootDir = await tempRoot("fs-safe-symlink-dotdot-real-");
    await fs.mkdir(path.join(rootDir, "sub"));

    expect(() => assertNoSymlinkParentsSync({
      rootDir,
      targetPath: rawPath(rootDir, "sub", "..", "file"),
    })).not.toThrow();
  });

  it("refuses appendRegularFile when dotdot cancels a symlink parent", async () => {
    const base = await tempRoot("fs-safe-symlink-dotdot-append-");
    const rootDir = path.join(base, "root");
    const outside = path.join(base, "outside");
    const outsideFile = path.join(base, "secret");
    await fs.mkdir(path.join(rootDir, "sub"), { recursive: true });
    await fs.mkdir(outside);
    await symlinkDir(outside, path.join(rootDir, "sub", "up"));

    await expect(appendRegularFile({
      filePath: rawPath(rootDir, "sub", "up", "..", "secret"),
      content: "x",
      rejectSymlinkParents: true,
    })).rejects.toThrow(/symlinked directory/);
    expect(fsSync.existsSync(outsideFile)).toBe(false);
  });
});

it("does not normalize a dot before the trusted root into a symlink bypass", async () => {
  const base = await tempRoot("fs-safe-dot-prefix-");
  const rootDir = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(path.join(rootDir, "sub"), { recursive: true });
  await fs.mkdir(outside);
  await symlinkDir(outside, path.join(rootDir, "sub", "up"));
  expect(() => assertNoSymlinkParentsSync({
    rootDir,
    targetPath: rawPath(base, ".", "root", "sub", "up", "..", "secret"),
  })).toThrow(/symlinked directory/);
});

it("rejects raw paths entering the root only after an outside dotdot", async () => {
  const base = await tempRoot("fs-safe-outside-dotdot-");
  const rootDir = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(rootDir);
  await fs.mkdir(outside);
  await symlinkDir(outside, path.join(base, "alias"));
  expect(() => assertNoSymlinkParentsSync({
    rootDir,
    targetPath: rawPath(base, "alias", "..", "root", "file"),
  })).toThrow(/must stay under/);
});

it("refuses to cancel an explicitly allowed root-child symlink", async () => {
  const rootDir = await tempRoot("fs-safe-allowed-link-dotdot-");
  const outside = await tempRoot("fs-safe-allowed-link-outside-");
  await symlinkDir(outside, path.join(rootDir, "alias"));
  expect(() => assertNoSymlinkParentsSync({
    rootDir,
    targetPath: rawPath(rootDir, "alias", "..", "file"),
    allowRootChildSymlink: true,
  })).toThrow(/symlinked directory/);
});

it.runIf(process.platform !== "win32")("keeps a trailing POSIX backslash in the root name", async () => {
  const base = await tempRoot("fs-safe-literal-backslash-");
  const rootDir = path.join(base, "root\\");
  await fs.mkdir(path.join(rootDir, "child"), { recursive: true });
  expect(() => assertNoSymlinkParentsSync({
    rootDir,
    targetPath: rawPath(rootDir, "child", "..", "file"),
  })).not.toThrow();
});

it("rejects Windows dotdot cancellation of a missing parent before an unchecked symlink", async () => {
  const rootDir = await tempRoot("fs-safe-missing-dotdot-");
  const outside = await tempRoot("fs-safe-missing-dotdot-outside-");
  await symlinkDir(outside, path.join(rootDir, "alias"));
  // Exercise the Windows fail-closed policy on every test host. Native Windows
  // runs also cover its filesystem normalization of the missing component.
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  expect(() => assertNoSymlinkParentsSync({
    rootDir,
    targetPath: rawPath(rootDir, "missing", "..", "alias", "file"),
  })).toThrow(/must not cancel a missing directory/);
  expect(() => assertNoSymlinkParentsSync({
    rootDir,
    targetPath: rawPath(rootDir, "missing", "file"),
  })).not.toThrow();
});
