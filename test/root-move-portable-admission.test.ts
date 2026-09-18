import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-portable-move-admission-");
  const sourceParent = path.join(directory, "incoming");
  const targetParent = path.join(directory, "archive");
  await fs.mkdir(sourceParent);
  await fs.mkdir(targetParent);
  const source = path.join(sourceParent, "value");
  const target = path.join(targetParent, "value");
  await fs.writeFile(source, "original");
  return { directory, sourceParent, targetParent, source, target, scoped: await root(directory) };
}

it.each([1, 2])("settles partial native admissions before falling back after open %s is unsupported", async failedOpen => {
  const { directory, source, target, scoped } = await fixture();
  const descriptors = new Set<number>();
  let rootFd: number | undefined;
  let opens = 0;
  const close = vi.fn((fd: number) => { fsSync.closeSync(fd); descriptors.delete(fd); });
  const rename = vi.fn();
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: close,
    openBeneath(parentFd: number, relativePath: string, flags: number) {
      rootFd = parentFd;
      if (++opens === failedOpen) throw Object.assign(new Error("unsupported open"), { code: "ENOSYS" });
      const fd = fsSync.openSync(path.join(directory, relativePath), flags);
      descriptors.add(fd);
      return { fd, containment: "best-effort" };
    },
    renameNoReplace: rename,
  }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  const link = fsSync.linkSync.bind(fsSync);
  vi.spyOn(fsSync, "linkSync").mockImplementation((from, to) => {
    expect(descriptors.size).toBe(0);
    // The numeric fd may have been reused for the portable source pin; it
    // must no longer identify the admitted root directory.
    if (rootFd !== undefined) {
      try { expect(fsSync.fstatSync(rootFd).isDirectory()).toBe(false); }
      catch (error) { expect(error).toMatchObject({ code: "EBADF" }); }
    }
    link(from, to);
  });
  await scoped.move("incoming/value", "archive/value");
  expect(close).toHaveBeenCalledTimes(failedOpen - 1);
  expect(rename).not.toHaveBeenCalled();
  expect(await fs.readFile(target, "utf8")).toBe("original");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["EINVAL", "EIO", "EACCES"])("preserves an unclassified native parent-open %s error", async code => {
  const { source, target, scoped } = await fixture();
  const failure = Object.assign(new Error("admission failed"), { code });
  const rename = vi.fn();
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: fsSync.closeSync,
    openBeneath() { throw failure; },
    renameNoReplace: rename,
  }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  const link = vi.spyOn(fsSync, "linkSync");
  await expect(scoped.move("incoming/value", "archive/value")).rejects.toBe(failure);
  expect(link).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("original");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not fall back when closing a partial admission fails", async () => {
  const { directory, source, target, scoped } = await fixture();
  const failure = Object.assign(new Error("unsupported second admission"), { code: "ENOTSUP" });
  const closeFailure = new Error("source parent close failed");
  let opened = false;
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: (fd: number) => { fsSync.closeSync(fd); throw closeFailure; },
    openBeneath(_parentFd: number, relativePath: string, flags: number) {
      if (opened) throw failure;
      opened = true;
      return { fd: fsSync.openSync(path.join(directory, relativePath), flags), containment: "best-effort" };
    },
    renameNoReplace: vi.fn(),
  }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  const link = vi.spyOn(fsSync, "linkSync");
  await expect(scoped.move("incoming/value", "archive/value")).rejects.toMatchObject({
    name: "SuppressedError", error: closeFailure, suppressed: failure,
  });
  expect(link).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("original");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32").each(
  (["root", "source", "target"] as const).flatMap(boundary => [1, 2].map(phase => ({ boundary, phase }))),
)("fences a changed $boundary before portable mutation $phase", async ({ boundary, phase }) => {
  const { directory, sourceParent, targetParent, source, scoped } = await fixture();
  const moved = directory + "-moved";
  const changed = boundary === "root" ? directory : boundary === "source" ? sourceParent : targetParent;
  let calls = 0;
  try {
    await expect(scoped.move("incoming/value", "archive/value", {
      assertBeforeMutation: () => {
        if (++calls !== phase) return;
        fsSync.renameSync(changed, moved);
        fsSync.mkdirSync(changed);
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    const originalSource = boundary === "root" ? path.join(moved, "incoming/value")
      : boundary === "source" ? path.join(moved, "value") : source;
    const originalTarget = boundary === "root" ? path.join(moved, "archive/value")
      : boundary === "target" ? path.join(moved, "value") : path.join(targetParent, "value");
    expect(await fs.readFile(originalSource, "utf8")).toBe("original");
    if (phase === 2) expect(await fs.readFile(originalTarget, "utf8")).toBe("original");
    else await expect(fs.lstat(originalTarget)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(moved, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32").each([undefined, "reject", "follow-parents-within-root"] as const)(
  "honors a stable contained parent alias with %s", async mutationSymlinks => {
    const { directory, source, target, scoped } = await fixture();
    await fs.symlink("incoming", path.join(directory, "alias"), "dir");
    configureFsSafeNative({ mode: "off" });
    if (mutationSymlinks === "reject") {
      await expect(scoped.move("alias/value", "archive/value", { mutationSymlinks }))
        .rejects.toMatchObject({ code: "symlink" });
      expect(await fs.readFile(source, "utf8")).toBe("original");
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await scoped.move("alias/value", "archive/value", { mutationSymlinks });
      expect(await fs.readFile(target, "utf8")).toBe("original");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);
