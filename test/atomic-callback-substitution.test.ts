import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  replaceFileAtomic, replaceFileAtomicSync,
  type ReplaceFileAtomicOptions, type ReplaceFileAtomicSyncOptions,
} from "../src/atomic.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
});

type Substitute = "file" | "directory" | "missing" | "symlink" | "hardlink";

function expectedCode(substitute: Substitute): string {
  if (substitute === "directory") return "not-file";
  if (substitute === "symlink") return "symlink";
  if (substitute === "hardlink") return "hardlink";
  return "path-mismatch";
}

async function installAsyncSubstitute(params: {
  substitute: Substitute;
  tempPath: string;
  movedPath: string;
  outsidePath: string;
}): Promise<void> {
  await fs.rename(params.tempPath, params.movedPath);
  if (params.substitute === "file") await fs.writeFile(params.tempPath, "replacement");
  if (params.substitute === "directory") {
    await fs.mkdir(params.tempPath);
    await fs.writeFile(path.join(params.tempPath, "sentinel"), "keep");
  }
  if (params.substitute === "symlink") await fs.symlink(params.outsidePath, params.tempPath);
  if (params.substitute === "hardlink") await fs.link(params.outsidePath, params.tempPath);
}

function installSyncSubstitute(params: {
  substitute: Substitute;
  tempPath: string;
  movedPath: string;
  outsidePath: string;
}): void {
  fsSync.renameSync(params.tempPath, params.movedPath);
  if (params.substitute === "file") fsSync.writeFileSync(params.tempPath, "replacement");
  if (params.substitute === "directory") {
    fsSync.mkdirSync(params.tempPath);
    fsSync.writeFileSync(path.join(params.tempPath, "sentinel"), "keep");
  }
  if (params.substitute === "symlink") fsSync.symlinkSync(params.outsidePath, params.tempPath);
  if (params.substitute === "hardlink") fsSync.linkSync(params.outsidePath, params.tempPath);
}

type VariantOptions = { async: ReplaceFileAtomicOptions; sync: ReplaceFileAtomicSyncOptions };
const variants = [
  {
    name: "async",
    reject: async (options: VariantOptions, code: string) => {
      await expect(replaceFileAtomic(options.async)).rejects.toMatchObject({ code });
    },
  },
  {
    name: "sync",
    reject: (options: VariantOptions, code: string) => {
      expect(() => replaceFileAtomicSync(options.sync)).toThrow(expect.objectContaining({ code }));
    },
  },
] as const;

describe.each(variants)("atomic beforeRename ownership ($name)", ({ name, reject }) => {
  async function expectSubstitutePreserved(substitute: Substitute): Promise<void> {
    const root = await tempRoot(`fs-safe-atomic-hook-${name}-${substitute}-`);
    const filePath = path.join(root, "target");
    const outsidePath = path.join(root, "outside");
    await fs.writeFile(filePath, "old");
    await fs.writeFile(outsidePath, "outside");
    let tempPath = "";
    let movedPath = "";
    const options = { filePath, content: "new" };

    await reject({
      async: { ...options, beforeRename: async ({ tempPath: candidate }) => {
        tempPath = candidate;
        movedPath = `${candidate}.owned`;
        await installAsyncSubstitute({ substitute, tempPath, movedPath, outsidePath });
      } },
      sync: { ...options, beforeRename: ({ tempPath: candidate }) => {
        tempPath = candidate;
        movedPath = `${candidate}.owned`;
        installSyncSubstitute({ substitute, tempPath, movedPath, outsidePath });
      } },
    }, expectedCode(substitute));

    expect(await fs.readFile(filePath, "utf8")).toBe("old");
    expect(await fs.readFile(movedPath, "utf8")).toBe("new");
    __cleanupRegisteredTempPathsForTest();
    if (substitute === "missing") {
      await expect(fs.lstat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    } else if (substitute === "directory") {
      expect(await fs.readFile(path.join(tempPath, "sentinel"), "utf8")).toBe("keep");
    } else if (substitute === "symlink") {
      expect((await fs.lstat(tempPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(outsidePath, "utf8")).toBe("outside");
    } else {
      expect(await fs.readFile(tempPath, "utf8")).toBe(substitute === "file" ? "replacement" : "outside");
    }
  }

  it.each(["file", "directory", "missing"] as const)("rejects and preserves a %s substitution", expectSubstitutePreserved);
  itPosix.each(["symlink", "hardlink"] as const)("rejects and preserves a %s substitution", expectSubstitutePreserved);

  it("detects a final-name replacement after rename without rollback", async () => {
    const root = await tempRoot(`fs-safe-atomic-published-${name}-`);
    const filePath = path.join(root, "target");
    const movedPath = path.join(root, "moved");
    await fs.writeFile(filePath, "old");
    const options = { filePath, content: "new" };
    await reject({
      async: { ...options, fileSystem: { promises: {
        ...fs,
        rename: async (source, destination) => {
          await fs.rename(source, destination);
          await fs.rename(destination, movedPath);
          await fs.writeFile(destination, "replacement");
        },
      } } },
      sync: { ...options, fileSystem: {
        ...fsSync,
        renameSync: (source, destination) => {
          fsSync.renameSync(source, destination);
          fsSync.renameSync(destination, movedPath);
          fsSync.writeFileSync(destination, "replacement");
        },
      } },
    }, "path-mismatch");
    expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
    expect(await fs.readFile(movedPath, "utf8")).toBe("new");
  });

  it("rechecks the final name after parent sync", async () => {
    const root = await tempRoot(`fs-safe-atomic-parent-sync-${name}-`);
    const filePath = path.join(root, "target");
    const movedPath = path.join(root, "moved");
    await fs.writeFile(filePath, "old");
    let swapped = false;
    const options = { filePath, content: "new", syncParentDir: true };
    await reject({
      async: { ...options, fileSystem: { promises: {
        ...fs,
        open: async (...args) => {
          const handle = await fs.open(...args);
          if (args[0] === root) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
              if (!swapped) {
                swapped = true;
                await fs.rename(filePath, movedPath);
                await fs.writeFile(filePath, "replacement");
              }
              await sync();
            };
          }
          return handle;
        },
      } } },
      sync: { ...options, fileSystem: {
        ...fsSync,
        fsyncSync: (fd) => {
          if (!swapped) {
            swapped = true;
            fsSync.renameSync(filePath, movedPath);
            fsSync.writeFileSync(filePath, "replacement");
          }
          fsSync.fsyncSync(fd);
        },
      } },
    }, "path-mismatch");
    expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
    expect(await fs.readFile(movedPath, "utf8")).toBe("new");
  });

  const renameUnstableAsync = { promises: {
    ...fs,
    rename: async (source: fsSync.PathLike, destination: fsSync.PathLike) => {
      await fs.copyFile(source, destination);
      await fs.unlink(source);
    },
  } } satisfies NonNullable<ReplaceFileAtomicOptions["fileSystem"]>;
  const renameUnstableSync = {
    ...fsSync,
    renameSync: (source: fsSync.PathLike, destination: fsSync.PathLike) => {
      fsSync.copyFileSync(source, destination);
      fsSync.unlinkSync(source);
    },
  } satisfies NonNullable<ReplaceFileAtomicSyncOptions["fileSystem"]>;

  it("keeps strict identity checks on rename-unstable filesystems", async () => {
    const root = await tempRoot(`fs-safe-atomic-fuse-strict-${name}-`);
    const filePath = path.join(root, "target");
    await fs.writeFile(filePath, "old");
    const options = { filePath, content: "new" };
    await reject({
      async: { ...options, fileSystem: renameUnstableAsync },
      sync: { ...options, fileSystem: renameUnstableSync },
    }, "path-mismatch");
    expect(await fs.readFile(filePath, "utf8")).toBe("new");
  });

  it("accepts rename-unstable publication only with locked content verification", async () => {
    const root = await tempRoot(`fs-safe-atomic-fuse-${name}-`);
    const filePath = path.join(root, "target");
    await fs.writeFile(filePath, "old");
    const options = { filePath, content: "new", renameIdentity: "verify-content-with-lock", syncParentDir: true } as const;
    if (name === "async") {
      await expect(replaceFileAtomic({ ...options, fileSystem: renameUnstableAsync })).resolves.toEqual({ method: "rename" });
    } else {
      expect(replaceFileAtomicSync({ ...options, fileSystem: renameUnstableSync })).toEqual({ method: "rename" });
    }
    expect(await fs.readFile(filePath, "utf8")).toBe("new");
    expect((await fs.readdir(root)).filter((entry) => entry.startsWith(".fs-safe-atomic-"))).toEqual([]);
  });

  it("rejects a source replacement entering copy fallback", async () => {
    const root = await tempRoot(`fs-safe-atomic-fallback-source-${name}-`);
    const filePath = path.join(root, "target");
    await fs.writeFile(filePath, "old");
    let tempPath = "";
    const movedPath = path.join(root, "moved");
    const options = { filePath, content: "new", copyFallbackOnPermissionError: true };
    await reject({
      async: { ...options,
        beforeRename: async ({ tempPath: candidate }) => { tempPath = candidate; },
        fileSystem: { promises: {
          ...fs,
          rename: async () => {
            await fs.rename(tempPath, movedPath);
            await fs.writeFile(tempPath, "replacement");
            throw Object.assign(new Error("rename denied"), { code: "EPERM" });
          },
        } },
      },
      sync: { ...options,
        beforeRename: ({ tempPath: candidate }) => { tempPath = candidate; },
        fileSystem: {
          ...fsSync,
          renameSync: () => {
            fsSync.renameSync(tempPath, movedPath);
            fsSync.writeFileSync(tempPath, "replacement");
            throw Object.assign(new Error("rename denied"), { code: "EPERM" });
          },
        },
      },
    }, "path-mismatch");
    expect(await fs.readFile(filePath, "utf8")).toBe("old");
    expect(await fs.readFile(tempPath, "utf8")).toBe("replacement");
    expect(await fs.readFile(movedPath, "utf8")).toBe("new");
  });

  it("rechecks ownership before a rename retry", async () => {
    const root = await tempRoot(`fs-safe-atomic-retry-source-${name}-`);
    const filePath = path.join(root, "target");
    await fs.writeFile(filePath, "old");
    let tempPath = "";
    let renames = 0;
    const options = { filePath, content: "new", renameMaxRetries: 1, renameRetryBaseDelayMs: 0 };
    await reject({
      async: { ...options,
        beforeRename: async ({ tempPath: candidate }) => { tempPath = candidate; },
        fileSystem: { promises: {
          ...fs,
          rename: async () => {
            renames += 1;
            await fs.rename(tempPath, `${tempPath}.owned`);
            await fs.writeFile(tempPath, "replacement");
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          },
        } },
      },
      sync: { ...options,
        beforeRename: ({ tempPath: candidate }) => { tempPath = candidate; },
        fileSystem: {
          ...fsSync,
          renameSync: () => {
            renames += 1;
            fsSync.renameSync(tempPath, `${tempPath}.owned`);
            fsSync.writeFileSync(tempPath, "replacement");
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          },
        },
      },
    }, "path-mismatch");
    expect(renames).toBe(1);
    expect(await fs.readFile(filePath, "utf8")).toBe("old");
    expect(await fs.readFile(tempPath, "utf8")).toBe("replacement");
  });
});

describe("atomic beforeRename ownership (async policy validation)", () => {
  it("rejects mismatched content under the rename-unstable compatibility policy", async () => {
    const root = await tempRoot("fs-safe-atomic-fuse-tampered-");
    const filePath = path.join(root, "target");
    await fs.writeFile(filePath, "old");
    await expect(replaceFileAtomic({
      filePath,
      content: "new",
      renameIdentity: "verify-content-with-lock",
      fileSystem: {
        promises: {
          ...fs,
          rename: async (source, destination) => {
            await fs.writeFile(destination, "tampered");
            await fs.unlink(source);
          },
        },
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(await fs.readFile(filePath, "utf8")).toBe("tampered");
    expect((await fs.readdir(root)).filter((name) => name.startsWith(".fs-safe-atomic-")))
      .toEqual([]);
  });

  it("rejects an invalid rename identity policy before mutation", async () => {
    const root = await tempRoot("fs-safe-atomic-fuse-policy-");
    const filePath = path.join(root, "target");
    await expect(replaceFileAtomic({
      filePath,
      content: "new",
      renameIdentity: "unknown" as "strict",
    })).rejects.toThrow("renameIdentity must be strict or verify-content-with-lock");
    await expect(fs.lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

});
