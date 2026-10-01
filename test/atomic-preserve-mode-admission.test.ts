import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const MODES = [
  { label: "async", initialMode: 0o4751 },
  { label: "sync", initialMode: 0o2751 },
] as const;

async function expectAdmissionFailure(mode: (typeof MODES)[number], filePath: string, code: string) {
  const options = { filePath, content: "replacement", preserveExistingMode: true };
  if (mode.label === "async") await expect(replaceFileAtomic(options)).rejects.toMatchObject({ code });
  else expect(() => replaceFileAtomicSync(options)).toThrow(expect.objectContaining({ code }));
}


function replacementTemps(entries: string[]): string[] {
  return entries.filter((entry) => entry.startsWith(".fs-safe-replace"));
}

describe("atomic preserved-mode admission", () => {
  itPosix("inherits only regular-file rwx bits in async and sync replacements", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-mode-");
    for (const mode of MODES) {
      const filePath = path.join(root, `${mode.label}.txt`);
      await fs.writeFile(filePath, "old");
      await fs.chmod(filePath, mode.initialMode);
      const options = { filePath, content: "new", preserveExistingMode: true };
      if (mode.label === "async") await replaceFileAtomic(options);
      else replaceFileAtomicSync(options);
      expect((await fs.stat(filePath)).mode & 0o7777).toBe(0o751);
    }
  });

  itPosix("rejects existing and dangling symlinks before staging", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-symlink-");
    const victimPath = path.join(root, "victim.txt");
    await fs.writeFile(victimPath, "victim");
    for (const dangling of [false, true]) {
      for (const mode of MODES) {
        const filePath = path.join(root, `${mode.label}-${dangling}.txt`);
        await fs.symlink(dangling ? path.join(root, `missing-${mode.label}.txt`) : victimPath, filePath);
        await expectAdmissionFailure(mode, filePath, "symlink");
        expect((await fs.lstat(filePath)).isSymbolicLink()).toBe(true);
      }
    }
    expect(await fs.readFile(victimPath, "utf8")).toBe("victim");
    expect(replacementTemps(await fs.readdir(root))).toEqual([]);
  });

  it("rejects non-regular destinations before staging", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-kind-");
    for (const mode of MODES) {
      const filePath = path.join(root, `${mode.label}-directory`);
      await fs.mkdir(filePath);
      await expectAdmissionFailure(mode, filePath, "not-file");
      expect((await fs.lstat(filePath)).isDirectory()).toBe(true);
    }
    expect(replacementTemps(await fs.readdir(root))).toEqual([]);
  });

  it("uses no-follow adapter inspection and propagates inspection failures", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-adapter-");
    const deniedPath = path.join(root, "denied.txt");
    await fs.writeFile(deniedPath, "old");
    const denied = Object.assign(new Error("inspection denied"), { code: "EACCES" });
    for (const mode of MODES) {
      const filePath = path.join(root, `${mode.label}.txt`);
      await fs.writeFile(filePath, "old");
      let destinationLstats = 0;
      const inspect = (candidate: fsSync.PathLike) => {
        if (String(candidate) === filePath) destinationLstats += 1;
        if (String(candidate) === deniedPath) throw denied;
      };
      const asyncFs = { promises: {
        ...fs,
        stat: (async () => { throw new Error("stat must not inspect inherited mode"); }) as typeof fs.stat,
        lstat: (async (...args: Parameters<typeof fs.lstat>) => {
          inspect(args[0]);
          return await fs.lstat(...args);
        }) as typeof fs.lstat,
      } };
      const syncFs = {
        ...fsSync,
        statSync: (() => { throw new Error("statSync must not inspect inherited mode"); }) as typeof fsSync.statSync,
        lstatSync: ((...args: Parameters<typeof fsSync.lstatSync>) => {
          inspect(args[0]);
          return fsSync.lstatSync(...args);
        }) as typeof fsSync.lstatSync,
      };
      const options = { filePath, content: "new", preserveExistingMode: true };
      if (mode.label === "async") {
        await replaceFileAtomic({ ...options, fileSystem: asyncFs });
        await expect(replaceFileAtomic({ ...options, filePath: deniedPath, fileSystem: asyncFs })).rejects.toBe(denied);
      } else {
        replaceFileAtomicSync({ ...options, fileSystem: syncFs });
        expect(() => replaceFileAtomicSync({ ...options, filePath: deniedPath, fileSystem: syncFs })).toThrow(denied);
      }
      expect(destinationLstats).toBeGreaterThanOrEqual(1);
    }
    expect(await fs.readFile(deniedPath, "utf8")).toBe("old");
    expect(replacementTemps(await fs.readdir(root))).toEqual([]);
  });

  it.each([false, true].flatMap(synchronous =>
    ["isSymbolicLink", "isFile", "mode"].map(member => ({ synchronous, member })),
  ))("preserves ENOENT from admitted metadata $member (sync=$synchronous)", async ({ synchronous, member }) => {
    const root = await tempRoot("fs-safe-atomic-preserved-kind-error-");
    const filePath = path.join(root, "target");
    await fs.writeFile(filePath, "original");
    const identity = await fs.lstat(filePath, { bigint: true });
    const failure = Object.assign(new Error("metadata admission failed"), { code: "ENOENT" });
    let mutations = 0;
    const forbidMutation = () => {
      mutations++;
      throw new Error("mutation dispatched after failed metadata admission");
    };
    const damaged = <T extends fsSync.Stats | fsSync.BigIntStats>(stat: T): T => {
      Object.defineProperty(stat, member, member === "mode"
        ? { get() { throw failure; } }
        : { value() { throw failure; } });
      return stat;
    };
    const run = async () => {
      const options = { filePath, content: "replacement", preserveExistingMode: true };
      if (synchronous) {
        return replaceFileAtomicSync({ ...options, fileSystem: {
          ...fsSync,
          lstatSync: ((...args: Parameters<typeof fsSync.lstatSync>) =>
            damaged(fsSync.lstatSync(...args))) as typeof fsSync.lstatSync,
          mkdirSync: forbidMutation, openSync: forbidMutation, writeFileSync: forbidMutation,
          renameSync: forbidMutation, rmSync: forbidMutation, unlinkSync: forbidMutation,
          copyFileSync: forbidMutation, fchmodSync: forbidMutation,
        } });
      }
      return await replaceFileAtomic({ ...options, fileSystem: { promises: {
        ...fs,
        lstat: (async (...args: Parameters<typeof fs.lstat>) =>
          damaged(await fs.lstat(...args))) as typeof fs.lstat,
        mkdir: forbidMutation, open: forbidMutation, writeFile: forbidMutation,
        rename: forbidMutation, rm: forbidMutation, unlink: forbidMutation,
        copyFile: forbidMutation,
      } } });
    };

    await expect(run()).rejects.toBe(failure);
    expect(mutations).toBe(0);
    expect(await fs.readFile(filePath, "utf8")).toBe("original");
    const current = await fs.lstat(filePath, { bigint: true });
    expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino]);
    expect(await fs.readdir(root)).toEqual(["target"]);
  });

  itPosix("uses sanitized inherited modes through both copy-fallback policies", async () => {
    const root = await tempRoot("fs-safe-atomic-preserved-fallback-");
    const renameDenied = () => Object.assign(new Error("rename denied"), { code: "EPERM" });

    for (const restore of ["none", "restore-original"] as const) {
      for (const mode of MODES) {
        const filePath = path.join(root, `${mode.label}-${restore}.txt`);
        await fs.writeFile(filePath, "old");
        await fs.chmod(filePath, mode.initialMode);
        const restoreOptions = restore === "restore-original"
          ? { copyFallbackRestore: restore, maxRestoreBytes: 1024 }
          : { copyFallbackRestore: restore };
        const options = {
          filePath, content: "new", preserveExistingMode: true,
          copyFallbackOnPermissionError: true, ...restoreOptions,
        };
        if (mode.label === "async") {
          await replaceFileAtomic({ ...options,
            fileSystem: { promises: { ...fs, rename: async () => { throw renameDenied(); } } },
          });
        } else {
          replaceFileAtomicSync({ ...options,
            fileSystem: { ...fsSync, renameSync: () => { throw renameDenied(); } },
          });
        }
        expect(await fs.readFile(filePath, "utf8")).toBe("new");
        expect((await fs.stat(filePath)).mode & 0o7777).toBe(0o751);
      }
    }
  });
});
