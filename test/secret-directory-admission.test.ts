import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const writers = [
  { operation: "write", write: writeSecretFileAtomic },
  { operation: "create", write: createSecretFileAtomic },
] as const;
afterEach(() => vi.restoreAllMocks());

async function directoryWithMode(directory: string, mode: number): Promise<void> {
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chown(directory, process.geteuid!(), process.getegid!());
  await fs.chmod(directory, mode);
  expect((await fs.lstat(directory)).mode & 0o7777).toBe(mode);
}

describe("secret directory admission", () => {
  for (const component of ["root", "parent"] as const) {
    for (const mode of [0o500, 0o750, 0o2750]) {
      itPosix.each(writers)(`$operation rejects existing ${component} mode ${mode.toString(8)} without repairing it`, async ({ write }) => {
        const sandbox = await tempRoot("fs-safe-secret-mode-admission-");
        const rootDir = path.join(sandbox, "root");
        await directoryWithMode(rootDir, 0o700);
        const parent = component === "root" ? rootDir : path.join(rootDir, "parent");
        if (parent !== rootDir) await directoryWithMode(parent, 0o700);
        const filePath = path.join(parent, "token");
        await fs.chmod(parent, mode);
        const before = await fs.lstat(parent, { bigint: true });
        const chmod = fs.chmod.bind(fs);
        const chmodSpy = vi.spyOn(fs, "chmod");
        try {
          await expect(write({ rootDir, filePath, content: "synthetic" }))
            .rejects.toMatchObject({ code: "insecure-permissions" });
          expect(chmodSpy).not.toHaveBeenCalled();
          const after = await fs.lstat(parent, { bigint: true });
          expect({ dev: after.dev, ino: after.ino, mode: after.mode }).toEqual({ dev: before.dev, ino: before.ino, mode: before.mode });
          await expect(fs.lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await chmod(parent, 0o700);
        }
      });
    }
  }

  for (const dirMode of [0o700, 0o750, 0o2750]) {
    itPosix.each(writers)(`$operation accepts matching mode ${dirMode.toString(8)} without chmod`, async ({ write }) => {
      const sandbox = await tempRoot("fs-safe-secret-mode-match-");
      const rootDir = path.join(sandbox, "root");
      await directoryWithMode(rootDir, dirMode);
      const chmod = vi.spyOn(fs, "chmod");
      const filePath = path.join(rootDir, "token");

      await write({ rootDir, filePath, dirMode, content: "synthetic" });

      expect(chmod).not.toHaveBeenCalled();
      expect((await fs.lstat(rootDir)).mode & 0o7777).toBe(dirMode);
      expect(await fs.readFile(filePath, "utf8")).toBe("synthetic");
    });
  }

  itPosix.each(writers)("$operation initializes an explicitly requested setgid root", async ({ write }) => {
    const sandbox = await tempRoot("fs-safe-secret-mode-setgid-");
    await fs.chown(sandbox, process.geteuid!(), process.getegid!());
    const rootDir = path.join(sandbox, "root");
    const filePath = path.join(rootDir, "token");
    const chmod = vi.spyOn(fs, "chmod");

    await write({ rootDir, filePath, dirMode: 0o2750, content: "synthetic" });

    expect(chmod).not.toHaveBeenCalled();
    expect((await fs.lstat(rootDir)).mode & 0o7777).toBe(0o2750);
    expect(await fs.readFile(filePath, "utf8")).toBe("synthetic");
  });

  for (const component of ["root", "parent"] as const) {
    itPosix.each(writers)(`$operation does not repair a ${component} created by an EEXIST winner`, async ({ write }) => {
      const sandbox = await tempRoot("fs-safe-secret-mode-eexist-");
      const rootDir = path.join(sandbox, "root");
      if (component === "parent") await directoryWithMode(rootDir, 0o700);
      const parent = component === "root" ? rootDir : path.join(rootDir, "parent");
      const mkdir = fs.mkdir.bind(fs);
      const chmod = fs.chmod.bind(fs);
      let raced = false;
      vi.spyOn(fs, "mkdir").mockImplementation(async (candidate, options) => {
        if (String(candidate) === parent && !raced) {
          raced = true;
          await mkdir(parent, { mode: 0o750 });
          await chmod(parent, 0o750);
        }
        return await mkdir(candidate, options);
      });
      const chmodSpy = vi.spyOn(fs, "chmod");

      await expect(write({ rootDir, filePath: path.join(parent, "token"), content: "synthetic" }))
        .rejects.toMatchObject({ code: "insecure-permissions" });

      expect(raced).toBe(true);
      expect(chmodSpy).not.toHaveBeenCalled();
      expect((await fs.lstat(parent)).mode & 0o7777).toBe(0o750);
      expect(await fs.readdir(parent)).toEqual([]);
    });
  }

  itPosix.each(writers)("$operation requires descriptor authority for an umask777 parent", async ({ write }) => {
    const rootDir = await tempRoot("fs-safe-secret-mode-created-");
    const parent = path.join(rootDir, "parent");
    const filePath = path.join(parent, "token");
    const chmod = vi.spyOn(fs, "chmod");
    const previous = process.umask(0o777);
    try {
      if (process.platform === "darwin" && process.geteuid?.() !== 0) {
        await expect(write({ rootDir, filePath, content: "synthetic" }))
          .rejects.toMatchObject({ code: "EACCES" });
        expect(chmod).not.toHaveBeenCalled();
        expect((await fs.lstat(parent)).mode & 0o7777).toBe(0o000);
        expect(await fs.readdir(rootDir)).toEqual(["parent"]);
      } else {
        await write({ rootDir, filePath, content: "synthetic" });
        expect(chmod.mock.calls.every(([target]) => String(target).startsWith("/proc/self/fd/"))).toBe(true);
        expect((await fs.lstat(parent)).mode & 0o7777).toBe(0o700);
        expect((await fs.lstat(filePath)).mode & 0o7777).toBe(0o600);
      }
    } finally {
      process.umask(previous);
      await fs.chmod(parent, 0o700).catch(() => undefined);
    }
    if (process.platform === "darwin" && process.geteuid?.() !== 0) {
      expect(await fs.readdir(parent)).toEqual([]);
    }
  });

  itPosix.each(writers)("$operation initializes a missing nested root without widening its bootstrap parent", async ({ write }) => {
    const sandbox = await tempRoot("fs-safe-secret-mode-bootstrap-");
    const bootstrap = path.join(sandbox, "bootstrap");
    const rootDir = path.join(bootstrap, "root");
    const previous = process.umask(0o400);
    try {
      await write({ rootDir, filePath: path.join(rootDir, "token"), content: "synthetic" });
      expect((await fs.lstat(bootstrap)).mode & 0o7777).toBe(0o300);
      expect((await fs.lstat(rootDir)).mode & 0o7777).toBe(0o700);
    } finally {
      process.umask(previous);
      await fs.chmod(bootstrap, 0o700).catch(() => undefined);
    }
  });

  for (const option of ["mode", "dirMode"] as const) {
    for (const value of [-1, 0o10000, 1.5, Infinity, NaN]) {
      it.each(writers)(`$operation rejects ${option}=${value} before creating directories`, async ({ write }) => {
        const sandbox = await tempRoot("fs-safe-secret-invalid-mode-");
        const rootDir = path.join(sandbox, "root");
        const mkdir = vi.spyOn(fs, "mkdir");
        await expect(write({ rootDir, filePath: path.join(rootDir, "token"), content: "synthetic", [option]: value }))
          .rejects.toMatchObject({ code: "invalid-path" });
        expect(mkdir).not.toHaveBeenCalled();
        expect(await fs.readdir(sandbox)).toEqual([]);
      });
    }
  }

  itPosix.each(writers)("$operation rejects a created directory replaced while its descriptor is opened", async ({ write }) => {
    const rootDir = await tempRoot("fs-safe-secret-mode-descriptor-swap-");
    const parent = path.join(rootDir, "parent");
    const moved = path.join(rootDir, "moved");
    const open = fs.open.bind(fs);
    const chmod = fs.chmod.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === parent && !swapped) {
        swapped = true;
        await fs.rename(parent, moved);
        await fs.mkdir(parent, { mode: 0o750 });
        await chmod(parent, 0o750);
      }
      return handle;
    });
    const chmodSpy = vi.spyOn(fs, "chmod");
    const previous = process.umask(0o400);
    try {
      await expect(write({ rootDir, filePath: path.join(parent, "token"), content: "synthetic" }))
        .rejects.toMatchObject({ code: "path-mismatch" });
      expect(swapped).toBe(true);
      expect(chmodSpy).not.toHaveBeenCalled();
      expect((await fs.lstat(parent)).mode & 0o7777).toBe(0o750);
      expect((await fs.lstat(moved)).mode & 0o7777).toBe(0o300);
      expect(await fs.readdir(parent)).toEqual([]);
    } finally {
      process.umask(previous);
      await chmod(parent, 0o700).catch(() => undefined);
      await chmod(moved, 0o700).catch(() => undefined);
    }
  });

  itPosix.each(writers)("$operation rejects changed descriptor ownership before initialization", async ({ write }) => {
    const rootDir = await tempRoot("fs-safe-secret-mode-owner-");
    const parent = path.join(rootDir, "parent");
    const open = fs.open.bind(fs);
    const chmod = fs.chmod.bind(fs);
    let changedOwner = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === parent) {
        const stat = handle.stat.bind(handle);
        let inspections = 0;
        vi.spyOn(handle, "stat").mockImplementation(async (options) => {
          const value = await stat(options);
          if (++inspections > 1) {
            changedOwner = true;
            Object.assign(value, { uid: typeof value.uid === "bigint" ? value.uid + 1n : value.uid + 1 });
          }
          return value;
        });
      }
      return handle;
    });
    const chmodSpy = vi.spyOn(fs, "chmod");
    const previous = process.umask(0o400);
    try {
      await expect(write({ rootDir, filePath: path.join(parent, "token"), content: "synthetic" }))
        .rejects.toMatchObject({ code: "not-owned" });
      expect(changedOwner).toBe(true);
      expect(chmodSpy).not.toHaveBeenCalled();
      expect((await fs.lstat(parent)).mode & 0o7777).toBe(0o300);
      await expect(fs.lstat(path.join(parent, "token"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.umask(previous);
      await chmod(parent, 0o700).catch(() => undefined);
    }
  });
});
