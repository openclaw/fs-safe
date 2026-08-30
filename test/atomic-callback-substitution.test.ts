import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
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

async function expectAsyncSubstitutePreserved(substitute: Substitute): Promise<void> {
  const root = await tempRoot(`fs-safe-atomic-hook-${substitute}-`);
  const filePath = path.join(root, "target");
  const outsidePath = path.join(root, "outside");
  await fs.writeFile(filePath, "old");
  await fs.writeFile(outsidePath, "outside");
  let tempPath = "";
  let movedPath = "";

  await expect(replaceFileAtomic({
    filePath,
    content: "new",
    beforeRename: async ({ tempPath: candidate }) => {
      tempPath = candidate;
      movedPath = `${candidate}.owned`;
      await installAsyncSubstitute({ substitute, tempPath, movedPath, outsidePath });
    },
  })).rejects.toMatchObject({ code: expectedCode(substitute) });

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

async function expectSyncSubstitutePreserved(substitute: Substitute): Promise<void> {
  const root = await tempRoot(`fs-safe-atomic-hook-sync-${substitute}-`);
  const filePath = path.join(root, "target");
  const outsidePath = path.join(root, "outside");
  fsSync.writeFileSync(filePath, "old");
  fsSync.writeFileSync(outsidePath, "outside");
  let tempPath = "";
  let movedPath = "";

  expect(() => replaceFileAtomicSync({
    filePath,
    content: "new",
    beforeRename: ({ tempPath: candidate }) => {
      tempPath = candidate;
      movedPath = `${candidate}.owned`;
      installSyncSubstitute({ substitute, tempPath, movedPath, outsidePath });
    },
  })).toThrow(expect.objectContaining({ code: expectedCode(substitute) }));

  expect(fsSync.readFileSync(filePath, "utf8")).toBe("old");
  expect(fsSync.readFileSync(movedPath, "utf8")).toBe("new");
  __cleanupRegisteredTempPathsForTest();
  if (substitute === "missing") {
    expect(() => fsSync.lstatSync(tempPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  } else if (substitute === "directory") {
    expect(fsSync.readFileSync(path.join(tempPath, "sentinel"), "utf8")).toBe("keep");
  } else if (substitute === "symlink") {
    expect(fsSync.lstatSync(tempPath).isSymbolicLink()).toBe(true);
    expect(fsSync.readFileSync(outsidePath, "utf8")).toBe("outside");
  } else {
    expect(fsSync.readFileSync(tempPath, "utf8")).toBe(substitute === "file" ? "replacement" : "outside");
  }
}

describe("atomic beforeRename ownership", () => {
  it.each(["file", "directory", "missing"] as const)(
    "rejects and preserves an async %s substitution",
    expectAsyncSubstitutePreserved,
  );
  itPosix.each(["symlink", "hardlink"] as const)(
    "rejects and preserves an async %s substitution",
    expectAsyncSubstitutePreserved,
  );
  it.each(["file", "directory", "missing"] as const)(
    "rejects and preserves a sync %s substitution",
    expectSyncSubstitutePreserved,
  );
  itPosix.each(["symlink", "hardlink"] as const)(
    "rejects and preserves a sync %s substitution",
    expectSyncSubstitutePreserved,
  );

  it("detects an async final-name replacement after rename without rollback", async () => {
    const root = await tempRoot("fs-safe-atomic-published-async-");
    const filePath = path.join(root, "target");
    const movedPath = path.join(root, "moved");
    await fs.writeFile(filePath, "old");
    await expect(replaceFileAtomic({
      filePath,
      content: "new",
      fileSystem: {
        promises: {
          ...fs,
          rename: async (source, destination) => {
            await fs.rename(source, destination);
            await fs.rename(destination, movedPath);
            await fs.writeFile(destination, "replacement");
          },
        },
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
    expect(await fs.readFile(movedPath, "utf8")).toBe("new");
  });

  it("detects a sync final-name replacement after rename without rollback", async () => {
    const root = await tempRoot("fs-safe-atomic-published-sync-");
    const filePath = path.join(root, "target");
    const movedPath = path.join(root, "moved");
    fsSync.writeFileSync(filePath, "old");
    expect(() => replaceFileAtomicSync({
      filePath,
      content: "new",
      fileSystem: {
        ...fsSync,
        renameSync: (source, destination) => {
          fsSync.renameSync(source, destination);
          fsSync.renameSync(destination, movedPath);
          fsSync.writeFileSync(destination, "replacement");
        },
      },
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("replacement");
    expect(fsSync.readFileSync(movedPath, "utf8")).toBe("new");
  });

  it("rechecks the async final name after parent sync", async () => {
    const root = await tempRoot("fs-safe-atomic-parent-sync-async-");
    const filePath = path.join(root, "target");
    const movedPath = path.join(root, "moved");
    await fs.writeFile(filePath, "old");
    let swapped = false;
    await expect(replaceFileAtomic({
      filePath,
      content: "new",
      syncParentDir: true,
      fileSystem: {
        promises: {
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
        },
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
    expect(await fs.readFile(movedPath, "utf8")).toBe("new");
  });

  it("rechecks the sync final name after parent sync", async () => {
    const root = await tempRoot("fs-safe-atomic-parent-sync-sync-");
    const filePath = path.join(root, "target");
    const movedPath = path.join(root, "moved");
    fsSync.writeFileSync(filePath, "old");
    let swapped = false;
    expect(() => replaceFileAtomicSync({
      filePath,
      content: "new",
      syncParentDir: true,
      fileSystem: {
        ...fsSync,
        fsyncSync: (fd) => {
          if (!swapped) {
            swapped = true;
            fsSync.renameSync(filePath, movedPath);
            fsSync.writeFileSync(filePath, "replacement");
          }
          fsSync.fsyncSync(fd);
        },
      },
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("replacement");
    expect(fsSync.readFileSync(movedPath, "utf8")).toBe("new");
  });

  it("rejects an async source replacement entering copy fallback", async () => {
    const root = await tempRoot("fs-safe-atomic-fallback-source-async-");
    const filePath = path.join(root, "target");
    await fs.writeFile(filePath, "old");
    let tempPath = "";
    const movedPath = path.join(root, "moved");
    await expect(replaceFileAtomic({
      filePath,
      content: "new",
      copyFallbackOnPermissionError: true,
      beforeRename: async ({ tempPath: candidate }) => {
        tempPath = candidate;
      },
      fileSystem: {
        promises: {
          ...fs,
          rename: async () => {
            await fs.rename(tempPath, movedPath);
            await fs.writeFile(tempPath, "replacement");
            throw Object.assign(new Error("rename denied"), { code: "EPERM" });
          },
        },
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(await fs.readFile(filePath, "utf8")).toBe("old");
    expect(await fs.readFile(tempPath, "utf8")).toBe("replacement");
    expect(await fs.readFile(movedPath, "utf8")).toBe("new");
  });

  it("rejects a sync source replacement entering copy fallback", async () => {
    const root = await tempRoot("fs-safe-atomic-fallback-source-sync-");
    const filePath = path.join(root, "target");
    fsSync.writeFileSync(filePath, "old");
    let tempPath = "";
    const movedPath = path.join(root, "moved");
    expect(() => replaceFileAtomicSync({
      filePath,
      content: "new",
      copyFallbackOnPermissionError: true,
      beforeRename: ({ tempPath: candidate }) => {
        tempPath = candidate;
      },
      fileSystem: {
        ...fsSync,
        renameSync: () => {
          fsSync.renameSync(tempPath, movedPath);
          fsSync.writeFileSync(tempPath, "replacement");
          throw Object.assign(new Error("rename denied"), { code: "EPERM" });
        },
      },
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("old");
    expect(fsSync.readFileSync(tempPath, "utf8")).toBe("replacement");
    expect(fsSync.readFileSync(movedPath, "utf8")).toBe("new");
  });

  it("rechecks async ownership before a rename retry", async () => {
    const root = await tempRoot("fs-safe-atomic-retry-source-async-");
    const filePath = path.join(root, "target");
    await fs.writeFile(filePath, "old");
    let tempPath = "";
    let renames = 0;
    await expect(replaceFileAtomic({
      filePath,
      content: "new",
      renameMaxRetries: 1,
      renameRetryBaseDelayMs: 0,
      beforeRename: async ({ tempPath: candidate }) => {
        tempPath = candidate;
      },
      fileSystem: {
        promises: {
          ...fs,
          rename: async () => {
            renames += 1;
            await fs.rename(tempPath, `${tempPath}.owned`);
            await fs.writeFile(tempPath, "replacement");
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          },
        },
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(renames).toBe(1);
    expect(await fs.readFile(filePath, "utf8")).toBe("old");
    expect(await fs.readFile(tempPath, "utf8")).toBe("replacement");
  });

  it("rechecks sync ownership before a rename retry", async () => {
    const root = await tempRoot("fs-safe-atomic-retry-source-sync-");
    const filePath = path.join(root, "target");
    fsSync.writeFileSync(filePath, "old");
    let tempPath = "";
    let renames = 0;
    expect(() => replaceFileAtomicSync({
      filePath,
      content: "new",
      renameMaxRetries: 1,
      renameRetryBaseDelayMs: 0,
      beforeRename: ({ tempPath: candidate }) => {
        tempPath = candidate;
      },
      fileSystem: {
        ...fsSync,
        renameSync: () => {
          renames += 1;
          fsSync.renameSync(tempPath, `${tempPath}.owned`);
          fsSync.writeFileSync(tempPath, "replacement");
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      },
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(renames).toBe(1);
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("old");
    expect(fsSync.readFileSync(tempPath, "utf8")).toBe("replacement");
  });
});
