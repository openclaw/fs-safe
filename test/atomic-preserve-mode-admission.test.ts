import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

function replacementTemps(entries: string[]): string[] {
  return entries.filter((entry) => entry.startsWith(".fs-safe-replace"));
}

describe("atomic preserved-mode admission", () => {
  itPosix("inherits only regular-file rwx bits in async and sync replacements", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-mode-");
    const asyncPath = path.join(root, "async.txt");
    const syncPath = path.join(root, "sync.txt");
    await fs.writeFile(asyncPath, "old");
    await fs.writeFile(syncPath, "old");
    await fs.chmod(asyncPath, 0o4751);
    await fs.chmod(syncPath, 0o2751);

    await replaceFileAtomic({ filePath: asyncPath, content: "new", preserveExistingMode: true });
    replaceFileAtomicSync({ filePath: syncPath, content: "new", preserveExistingMode: true });

    expect((await fs.stat(asyncPath)).mode & 0o7777).toBe(0o751);
    expect(fsSync.statSync(syncPath).mode & 0o7777).toBe(0o751);
  });

  itPosix("rejects existing and dangling symlinks before staging", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-symlink-");
    const victimPath = path.join(root, "victim.txt");
    const asyncPath = path.join(root, "async.txt");
    const syncPath = path.join(root, "sync.txt");
    const danglingAsyncPath = path.join(root, "dangling-async.txt");
    const danglingSyncPath = path.join(root, "dangling-sync.txt");
    await fs.writeFile(victimPath, "victim");
    await fs.symlink(victimPath, asyncPath);
    await fs.symlink(victimPath, syncPath);
    await fs.symlink(path.join(root, "missing-async.txt"), danglingAsyncPath);
    await fs.symlink(path.join(root, "missing-sync.txt"), danglingSyncPath);

    await expect(replaceFileAtomic({
      filePath: asyncPath,
      content: "replacement",
      preserveExistingMode: true,
    })).rejects.toMatchObject({ code: "symlink" });
    expect(() => replaceFileAtomicSync({
      filePath: syncPath,
      content: "replacement",
      preserveExistingMode: true,
    })).toThrow(expect.objectContaining({ code: "symlink" }));
    await expect(replaceFileAtomic({
      filePath: danglingAsyncPath,
      content: "replacement",
      preserveExistingMode: true,
    })).rejects.toMatchObject({ code: "symlink" });
    expect(() => replaceFileAtomicSync({
      filePath: danglingSyncPath,
      content: "replacement",
      preserveExistingMode: true,
    })).toThrow(expect.objectContaining({ code: "symlink" }));

    expect(await fs.readFile(victimPath, "utf8")).toBe("victim");
    for (const linkPath of [asyncPath, syncPath, danglingAsyncPath, danglingSyncPath]) {
      expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    }
    expect(replacementTemps(await fs.readdir(root))).toEqual([]);
  });

  it("rejects non-regular destinations before staging", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-kind-");
    const asyncPath = path.join(root, "async-directory");
    const syncPath = path.join(root, "sync-directory");
    await fs.mkdir(asyncPath);
    await fs.mkdir(syncPath);

    await expect(replaceFileAtomic({
      filePath: asyncPath,
      content: "replacement",
      preserveExistingMode: true,
    })).rejects.toMatchObject({ code: "not-file" });
    expect(() => replaceFileAtomicSync({
      filePath: syncPath,
      content: "replacement",
      preserveExistingMode: true,
    })).toThrow(expect.objectContaining({ code: "not-file" }));

    expect((await fs.lstat(asyncPath)).isDirectory()).toBe(true);
    expect((await fs.lstat(syncPath)).isDirectory()).toBe(true);
    expect(replacementTemps(await fs.readdir(root))).toEqual([]);
  });

  it("uses no-follow adapter inspection and propagates inspection failures", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-adapter-");
    const asyncPath = path.join(root, "async.txt");
    const syncPath = path.join(root, "sync.txt");
    const deniedPath = path.join(root, "denied.txt");
    await fs.writeFile(asyncPath, "old");
    await fs.writeFile(syncPath, "old");
    await fs.writeFile(deniedPath, "old");
    let asyncDestinationLstats = 0;
    let syncDestinationLstats = 0;

    await replaceFileAtomic({
      filePath: asyncPath,
      content: "new",
      preserveExistingMode: true,
      fileSystem: {
        promises: {
          ...fs,
          stat: (async () => { throw new Error("stat must not inspect inherited mode"); }) as typeof fs.stat,
          lstat: (async (...args: Parameters<typeof fs.lstat>) => {
            if (String(args[0]) === asyncPath) asyncDestinationLstats += 1;
            return await fs.lstat(...args);
          }) as typeof fs.lstat,
        },
      },
    });
    replaceFileAtomicSync({
      filePath: syncPath,
      content: "new",
      preserveExistingMode: true,
      fileSystem: {
        ...fsSync,
        statSync: (() => { throw new Error("statSync must not inspect inherited mode"); }) as typeof fsSync.statSync,
        lstatSync: ((...args: Parameters<typeof fsSync.lstatSync>) => {
          if (String(args[0]) === syncPath) syncDestinationLstats += 1;
          return fsSync.lstatSync(...args);
        }) as typeof fsSync.lstatSync,
      },
    });

    expect(asyncDestinationLstats).toBeGreaterThanOrEqual(1);
    expect(syncDestinationLstats).toBeGreaterThanOrEqual(1);

    const denied = Object.assign(new Error("inspection denied"), { code: "EACCES" });
    await expect(replaceFileAtomic({
      filePath: deniedPath,
      content: "new",
      preserveExistingMode: true,
      fileSystem: {
        promises: {
          ...fs,
          lstat: (async (candidate, ...args) => {
            if (String(candidate) === deniedPath) throw denied;
            return await fs.lstat(candidate, ...args);
          }) as typeof fs.lstat,
        },
      },
    })).rejects.toBe(denied);
    expect(() => replaceFileAtomicSync({
      filePath: deniedPath,
      content: "new",
      preserveExistingMode: true,
      fileSystem: {
        ...fsSync,
        lstatSync: ((candidate, ...args) => {
          if (String(candidate) === deniedPath) throw denied;
          return fsSync.lstatSync(candidate, ...args);
        }) as typeof fsSync.lstatSync,
      },
    })).toThrow(denied);
    expect(await fs.readFile(deniedPath, "utf8")).toBe("old");
    expect(replacementTemps(await fs.readdir(root))).toEqual([]);
  });

  itPosix("uses sanitized inherited modes through both copy-fallback policies", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-fallback-");
    const renameDenied = () => Object.assign(new Error("rename denied"), { code: "EPERM" });

    for (const restore of ["none", "restore-original"] as const) {
      const asyncPath = path.join(root, `async-${restore}.txt`);
      const syncPath = path.join(root, `sync-${restore}.txt`);
      await fs.writeFile(asyncPath, "old");
      await fs.writeFile(syncPath, "old");
      await fs.chmod(asyncPath, 0o4751);
      await fs.chmod(syncPath, 0o2751);
      const restoreOptions = restore === "restore-original"
        ? { copyFallbackRestore: restore, maxRestoreBytes: 1024 }
        : { copyFallbackRestore: restore };

      await replaceFileAtomic({
        filePath: asyncPath,
        content: "new",
        preserveExistingMode: true,
        copyFallbackOnPermissionError: true,
        ...restoreOptions,
        fileSystem: { promises: { ...fs, rename: async () => { throw renameDenied(); } } },
      });
      replaceFileAtomicSync({
        filePath: syncPath,
        content: "new",
        preserveExistingMode: true,
        copyFallbackOnPermissionError: true,
        ...restoreOptions,
        fileSystem: { ...fsSync, renameSync: () => { throw renameDenied(); } },
      });

      expect(await fs.readFile(asyncPath, "utf8")).toBe("new");
      expect(fsSync.readFileSync(syncPath, "utf8")).toBe("new");
      expect((await fs.stat(asyncPath)).mode & 0o7777).toBe(0o751);
      expect(fsSync.statSync(syncPath).mode & 0o7777).toBe(0o751);
    }
  });
});
