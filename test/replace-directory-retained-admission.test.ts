import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { replaceDirectoryAtomic } from "../src/atomic.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

it("rejects and closes a replacement opened in place of an admitted parent", async () => {
  const root = await tempRoot("fs-safe-replace-retained-admission-");
  const parent = path.join(root, "parent");
  const admittedParent = `${parent}.admitted`;
  const staged = path.join(parent, "staged");
  const target = path.join(parent, "target");
  await fs.mkdir(staged, { recursive: true });
  await fs.writeFile(path.join(staged, "value.txt"), "new");
  const renameNoReplaceWithIdentity = vi.fn();
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: vi.fn(),
    canonicalizePath: (pathname: string, ordinary: boolean) => ({
      path: ordinary ? fsSync.realpathSync(pathname) : fsSync.realpathSync.native(pathname),
    }),
    renameNoReplace: vi.fn(),
    renameNoReplaceWithIdentity,
  }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });

  const openSync = fsSync.openSync.bind(fsSync);
  const closeSync = fsSync.closeSync.bind(fsSync);
  let replacementFd: number | undefined;
  let closed = false;
  vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
    if (String(pathname) === parent && replacementFd === undefined) {
      fsSync.renameSync(parent, admittedParent);
      fsSync.mkdirSync(parent);
      fsSync.writeFileSync(path.join(parent, "keep.txt"), "replacement-parent");
      replacementFd = openSync(pathname, flags, mode);
      return replacementFd;
    }
    return openSync(pathname, flags, mode);
  });
  vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
    closeSync(fd);
    if (fd === replacementFd) closed = true;
  });

  await expect(replaceDirectoryAtomic({ stagedDir: staged, targetDir: target }))
    .rejects.toMatchObject({ code: "path-mismatch" });

  expect(replacementFd).toEqual(expect.any(Number));
  expect(closed).toBe(true);
  expect(renameNoReplaceWithIdentity).not.toHaveBeenCalled();
  await expect(fs.readFile(path.join(parent, "keep.txt"), "utf8"))
    .resolves.toBe("replacement-parent");
  await expect(fs.readFile(path.join(admittedParent, "staged", "value.txt"), "utf8"))
    .resolves.toBe("new");
});

it("opens and stats a shared retained parent once with no-follow directory flags", async () => {
  const root = await tempRoot("fs-safe-replace-retained-open-");
  const parent = path.join(root, "parent");
  const staged = path.join(parent, "staged");
  const target = path.join(parent, "target");
  await fs.mkdir(staged, { recursive: true });
  const renameNoReplaceWithIdentity = vi.fn(() => {
    throw Object.assign(new Error("publication denied"), { code: "EACCES" });
  });
  const renameNoReplace = vi.fn();
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: vi.fn(),
    canonicalizePath: (pathname: string, ordinary: boolean) => ({
      path: ordinary ? fsSync.realpathSync(pathname) : fsSync.realpathSync.native(pathname),
    }),
    renameNoReplace,
    renameNoReplaceWithIdentity,
  }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  const openSync = fsSync.openSync.bind(fsSync);
  const parentOpens: Array<{ fd: number; flags: number }> = [];
  vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
    const fd = openSync(pathname, flags, mode);
    if (String(pathname) === parent) parentOpens.push({ fd, flags: Number(flags) });
    return fd;
  });
  const fstatSync = vi.spyOn(fsSync, "fstatSync");

  await expect(replaceDirectoryAtomic({ stagedDir: staged, targetDir: target }))
    .rejects.toMatchObject({ code: "EACCES" });

  expect(parentOpens).toHaveLength(1);
  expect(parentOpens[0]!.flags).toBe(
    fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY |
      fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK,
  );
  expect(fstatSync.mock.calls.filter(([fd]) => fd === parentOpens[0]!.fd)).toHaveLength(1);
  expect(renameNoReplaceWithIdentity).toHaveBeenCalledOnce();
  expect(renameNoReplace).not.toHaveBeenCalled();
});

it.each(["auto", "require"] as const)(
  "requires identity-fenced rename support before creating the target parent (%s)",
  async mode => {
    const root = await tempRoot("fs-safe-replace-retained-capability-");
    const staged = path.join(root, "staged");
    const missingParent = path.join(root, "missing-parent");
    const target = path.join(missingParent, "target");
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, "value.txt"), "new");
    const renameNoReplace = vi.fn();
    __setNativeLoaderForTest(
      () => ({ closeOwnedFd: vi.fn(), renameNoReplace }) as unknown as NativeBinding,
    );
    configureFsSafeNative({ mode });
    const mkdir = vi.spyOn(fs, "mkdir");

    await expect(replaceDirectoryAtomic({ stagedDir: staged, targetDir: target }))
      .rejects.toMatchObject({
        code: "helper-unavailable",
        message: expect.stringContaining("identity-fenced"),
      });

    expect(mkdir).not.toHaveBeenCalled();
    expect(renameNoReplace).not.toHaveBeenCalled();
    await expect(fs.lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(staged, "value.txt"), "utf8")).resolves.toBe("new");
  },
);
