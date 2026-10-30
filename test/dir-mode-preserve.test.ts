import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, vi } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { itDarwin, itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

itPosix.each([false, true])("preserves a non-owned parent without attempting chmod (sync=%s)", async (sync) => {
  const dir = await tempRoot("fs-safe-preserve-owner-");
  const filePath = path.join(dir, "state");
  await fs.chmod(dir, 0o770);
  const denied = Object.assign(new Error("not the directory owner"), { code: "EPERM" });
  const chmod = vi.fn(() => { throw denied; });
  if (sync) {
    const fchmod = fsSync.fchmodSync.bind(fsSync);
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
      if (fsSync.fstatSync(fd).isDirectory()) chmod();
      else fchmod(fd, mode);
    });
    expect(() => replaceFileAtomicSync({ filePath, content: "old" })).toThrow(denied);
    replaceFileAtomicSync({ filePath, content: "new", dirMode: "preserve" });
  } else {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === dir) vi.spyOn(handle, "chmod").mockImplementation(chmod);
      return handle;
    });
    await expect(replaceFileAtomic({ filePath, content: "old" })).rejects.toBe(denied);
    await replaceFileAtomic({ filePath, content: "new", dirMode: "preserve" });
  }
  expect(chmod).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(filePath, "utf8")).toBe("new");
  expect((await fs.stat(dir)).mode & 0o7777).toBe(0o770);
});

itPosix.each([false, true])("leaves shared permissions and inherited special bits intact (sync=%s)", async (sync) => {
  const dir = await tempRoot("fs-safe-preserve-bits-");
  await fs.chmod(dir, 0o2770);
  const original = (await fs.stat(dir)).mode & 0o7777;
  const options = { filePath: path.join(dir, "state"), content: "new", dirMode: "preserve" as const, mode: 0o640 };
  if (sync) replaceFileAtomicSync(options);
  else await replaceFileAtomic(options);
  expect((await fs.stat(dir)).mode & 0o7777).toBe(original);
  expect((await fs.stat(options.filePath)).mode & 0o7777).toBe(0o640);
});

itPosix.each([0o022, 0o077])("creates every missing directory at 0700 under umask %s", async (mask) => {
  const root = await tempRoot("fs-safe-preserve-chain-");
  await fs.chmod(root, 0o2770);
  const previous = process.umask(mask);
  try {
    for (const sync of [false, true]) {
      const first = path.join(root, String(sync));
      const parent = path.join(first, "nested");
      const options = { filePath: path.join(parent, "state"), content: "new", dirMode: "preserve" as const };
      if (sync) replaceFileAtomicSync(options);
      else await replaceFileAtomic(options);
      expect((await fs.stat(first)).mode & 0o7777).toBe(0o700);
      expect((await fs.stat(parent)).mode & 0o7777).toBe(0o700);
    }
  } finally { process.umask(previous); }
});

itDarwin("preserves an existing 0770 parent and its access ACL", async () => {
  const dir = await tempRoot("fs-safe-preserve-acl-");
  await fs.chmod(dir, 0o770);
  execFileSync("chmod", ["+a", "everyone allow read,write,search,add_file,add_subdirectory", dir]);
  const acl = () => execFileSync("ls", ["-lde", dir], { encoding: "utf8" }).split("\n").slice(1).join("\n");
  const before = acl();
  expect(before).toContain("everyone allow");
  await replaceFileAtomic({ filePath: path.join(dir, "state"), content: "new", dirMode: "preserve" });
  expect(acl()).toBe(before);
  expect((await fs.stat(dir)).mode & 0o7777).toBe(0o770);
});

itPosix.each([false, true])("retains file-mode inheritance and locked rename policy (sync=%s)", async sync => {
  const dir = await tempRoot("fs-safe-preserve-inherit-");
  const filePath = path.join(dir, "nested", "state");
  const options = { filePath, content: "first", dirMode: "preserve" as const, renameIdentity: "verify-content-with-lock" as const };
  if (sync) replaceFileAtomicSync(options);
  else await replaceFileAtomic(options);
  await fs.chmod(filePath, 0o640);
  if (sync) replaceFileAtomicSync({ ...options, content: "second", preserveExistingMode: true });
  else await replaceFileAtomic({ ...options, content: "second", preserveExistingMode: true });
  expect((await fs.stat(filePath)).mode & 0o7777).toBe(0o640);
  expect((await fs.stat(path.dirname(filePath))).mode & 0o7777).toBe(0o700);
});

itPosix.each([false, true])("verifies a concurrent mkdir winner without changing its mode (sync=%s)", async (sync) => {
  const root = await tempRoot("fs-safe-preserve-concurrent-");
  const dir = path.join(root, "winner");
  let raced = false;
  if (sync) {
    const mkdir = fsSync.mkdirSync.bind(fsSync);
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((pathname, options) => {
      if (pathname === dir && !raced) {
        raced = true;
        mkdir(dir, { mode: 0o770 });
        fsSync.chmodSync(dir, 0o2770);
      }
      return mkdir(pathname, options);
    });
    replaceFileAtomicSync({ filePath: path.join(dir, "state"), content: "new", dirMode: "preserve" });
  } else {
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation(async (pathname, options) => {
      if (pathname === dir && !raced) {
        raced = true;
        await mkdir(dir, { mode: 0o770 });
        await fs.chmod(dir, 0o2770);
      }
      return await mkdir(pathname, options);
    });
    await replaceFileAtomic({ filePath: path.join(dir, "state"), content: "new", dirMode: "preserve" });
  }
  expect(raced).toBe(true);
  expect((await fs.stat(dir)).mode & 0o7777).toBe(0o2770);
  expect(await fs.readFile(path.join(dir, "state"), "utf8")).toBe("new");
});

itPosix.each([false, true])("rejects a parent replaced by a symlink before opening (sync=%s)", async (sync) => {
  const root = await tempRoot("fs-safe-preserve-swap-");
  const dir = path.join(root, "parent");
  const moved = path.join(root, "moved");
  const outside = path.join(root, "outside");
  await fs.mkdir(dir);
  await fs.mkdir(outside);
  const swap = () => { fsSync.renameSync(dir, moved); fsSync.symlinkSync(outside, dir); };
  if (sync) {
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((pathname, ...args) => {
      if (pathname === dir) swap();
      return open(pathname, ...args);
    });
    expect(() => replaceFileAtomicSync({ filePath: path.join(dir, "state"), content: "new", dirMode: "preserve" })).toThrow();
  } else {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (pathname, ...args) => {
      if (pathname === dir) swap();
      return await open(pathname, ...args);
    });
    await expect(replaceFileAtomic({ filePath: path.join(dir, "state"), content: "new", dirMode: "preserve" })).rejects.toThrow();
  }
  expect((await fs.lstat(dir)).isSymbolicLink()).toBe(true);
  expect(await fs.readdir(outside)).toEqual([]);
});
