import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, vi } from "vitest";
import type { ExtractionDeadline } from "../src/archive-deadline.js";
import { stageArchiveFileForExtraction } from "../src/archive-input.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import {
  prepareArchiveOutputPath,
  preparePrivateArchiveOutputPath,
  withStagedArchiveDestination,
} from "../src/archive-staging.js";
import {
  ensureDurableDirectory,
  pinDirectory,
  syncDirectory,
  syncDirectoryBestEffort,
  syncDirectoryBestEffortSync,
} from "../src/directory-durability.js";
import { writeExternalFileWithinRoot } from "../src/output.js";
import {
  tempWorkspace,
  tempWorkspaceSync,
  withTempWorkspace,
  withTempWorkspaceSync,
} from "../src/private-temp-workspace.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { resolveSecureTempRoot } from "../src/secure-temp-dir.js";
import { writeCallbackSibling } from "../src/sibling-staged-file.js";
import { itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function deadline(): ExtractionDeadline {
  const signal = new AbortController().signal;
  return {
    signal,
    check: () => undefined,
    ownDestinationMutation: async (run) => await run(),
    waitForDestinationMutations: async () => undefined,
    dispose: () => undefined,
  };
}

function secureDirStat() {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    mode: 0o40700,
    uid: 501,
  };
}

describe("caller-owned pathname snapshots", () => {
  itWin32("uses one output root/path observation and sanitizes that basename", async () => {
    const root = await tempRoot("fs-safe-snapshot-output-");
    let rootReads = 0;
    let pathReads = 0;
    const options = {
      get rootDir() {
        rootReads += 1;
        return rootReads === 1 ? root : `${root}::$INDEX_ALLOCATION`;
      },
      get path() {
        pathReads += 1;
        return pathReads === 1
          ? "report.bin:hidden"
          : path.join("missing::$INDEX_ALLOCATION", "unexpected.bin");
      },
      staging: "sibling" as const,
      write: async (candidate: string) => await fs.writeFile(candidate, "snapshot"),
    };

    const result = await writeExternalFileWithinRoot(options);

    expect(rootReads).toBe(1);
    expect(pathReads).toBe(1);
    expect(path.basename(result.path)).not.toContain(":");
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("snapshot");
  });

  itWin32("retains sibling temp directory, name, and final-path callback authority", async () => {
    const root = await tempRoot("fs-safe-snapshot-sibling-");
    const safeTemp = path.join(root, "stage.tmp");
    const safeFinal = path.join(root, "final.bin");
    let directoryReads = 0;
    let tempReads = 0;
    let resolverReads = 0;
    const params = {
      get tempDir() {
        directoryReads += 1;
        return directoryReads === 1 ? root : `${root}::$INDEX_ALLOCATION`;
      },
      get tempName() {
        tempReads += 1;
        return tempReads === 1 ? path.basename(safeTemp) : `${path.basename(safeTemp)}:hidden`;
      },
      write: async (candidate: string) => await fs.writeFile(candidate, "snapshot"),
      get resolveFinalPath() {
        resolverReads += 1;
        if (resolverReads > 1) throw new Error("final resolver was reread");
        return () => safeFinal;
      },
      syncTempFile: false,
      syncParentDir: false,
    };

    await expect(writeCallbackSibling(params)).resolves.toMatchObject({ filePath: safeFinal });
    expect(directoryReads).toBe(1);
    expect(tempReads).toBe(1);
    expect(resolverReads).toBe(1);
    await expect(fs.readFile(safeFinal, "utf8")).resolves.toBe("snapshot");
  });

  itWin32("snapshots workspace roots and scoped wrappers ignore unknown getters", async () => {
    const root = await tempRoot("fs-safe-snapshot-workspace-");
    let rootReads = 0;
    const options = {
      get rootDir() {
        rootReads += 1;
        return rootReads === 1 ? root : `${root}::$INDEX_ALLOCATION`;
      },
      prefix: "workspace",
    };
    const workspace = await tempWorkspace(options);
    await workspace.cleanup();
    expect(rootReads).toBe(1);

    let syncRootReads = 0;
    const syncWorkspace = tempWorkspaceSync({
      get rootDir() {
        syncRootReads += 1;
        return syncRootReads === 1 ? root : `${root}::$INDEX_ALLOCATION`;
      },
      prefix: "sync-workspace",
    });
    syncWorkspace.cleanup();
    expect(syncRootReads).toBe(1);

    const scopedOptions = { rootDir: root, prefix: "scoped" };
    Object.defineProperty(scopedOptions, "unknown", {
      enumerable: true,
      get: () => { throw new Error("unknown option getter evaluated"); },
    });
    await expect(withTempWorkspace(scopedOptions, async () => "async"))
      .resolves.toBe("async");
    expect(withTempWorkspaceSync(scopedOptions, () => "sync")).toBe("sync");
  });

  itWin32("observes secure temp preferredDir and injected tmpdir only once", () => {
    let preferredReads = 0;
    const preferredOptions = {
      fallbackPrefix: "snapshot",
      getuid: () => 501,
      lstatSync: () => secureDirStat(),
      accessSync: () => undefined,
      mkdirSync: () => undefined,
      chmodSync: () => undefined,
      platform: "win32" as const,
      get preferredDir() {
        preferredReads += 1;
        return preferredReads === 1 ? "C:\\Temp\\safe" : "C:\\Temp:alias";
      },
    };
    expect(resolveSecureTempRoot(preferredOptions)).toBe("C:\\Temp\\safe");
    expect(preferredReads).toBe(1);

    let tmpdirReads = 0;
    const fallbackOptions = {
      fallbackPrefix: "snapshot",
      getuid: () => 501,
      lstatSync: () => secureDirStat(),
      accessSync: () => undefined,
      mkdirSync: () => undefined,
      chmodSync: () => undefined,
      platform: "win32" as const,
      get tmpdir() {
        tmpdirReads += 1;
        if (tmpdirReads > 1) throw new Error("tmpdir option was reread");
        return () => "C:\\Temp";
      },
    };
    expect(resolveSecureTempRoot(fallbackOptions)).toBe("C:\\Temp\\snapshot-501");
    expect(tmpdirReads).toBe(1);
  });

  itWin32("owns publication paths and parent receipt fields", async () => {
    const root = await tempRoot("fs-safe-snapshot-publish-");
    const source = path.join(root, "source.bin");
    const target = path.join(root, "target.bin");
    await fs.writeFile(source, "snapshot");
    const stableReceipt = await ensureDurableDirectory({ directoryPath: root });
    const reads = { source: 0, target: 0, receipt: 0, path: 0, realPath: 0, identity: 0 };
    const receipt = {
      get path() {
        reads.path += 1;
        return reads.path === 1 ? stableReceipt.path : `${root}::$INDEX_ALLOCATION`;
      },
      get realPath() {
        reads.realPath += 1;
        return reads.realPath === 1 ? stableReceipt.realPath : `${root}::$INDEX_ALLOCATION`;
      },
      get identity() {
        reads.identity += 1;
        if (reads.identity > 1) throw new Error("receipt identity was reread");
        return stableReceipt.identity;
      },
    };
    const params = {
      get sourcePath() {
        reads.source += 1;
        return reads.source === 1 ? source : `${source}:hidden`;
      },
      get targetPath() {
        reads.target += 1;
        return reads.target === 1 ? target : `${target}:hidden`;
      },
      strategy: "link-or-copy" as const,
      get parentReceipt() {
        reads.receipt += 1;
        if (reads.receipt > 1) throw new Error("parent receipt was reread");
        return receipt;
      },
    };

    await expect(publishFileExclusive(params)).resolves.toHaveProperty("method");
    expect(reads).toEqual({ source: 1, target: 1, receipt: 1, path: 1, realPath: 1, identity: 1 });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("snapshot");
  });

  itWin32("owns supplied directory receipts and keeps pin authority private", async () => {
    const root = await tempRoot("fs-safe-snapshot-directory-");
    const stableReceipt = await ensureDurableDirectory({ directoryPath: root });
    const reads = { path: 0, realPath: 0, identity: 0 };
    const receipt = {
      get path() {
        reads.path += 1;
        return reads.path === 1 ? stableReceipt.path : `${root}::$INDEX_ALLOCATION`;
      },
      get realPath() {
        reads.realPath += 1;
        return reads.realPath === 1 ? stableReceipt.realPath : `${root}::$INDEX_ALLOCATION`;
      },
      get identity() {
        reads.identity += 1;
        if (reads.identity > 1) throw new Error("directory identity was reread");
        return stableReceipt.identity;
      },
    };

    await expect(syncDirectory(receipt)).resolves.toHaveProperty("status");
    expect(reads).toEqual({ path: 1, realPath: 1, identity: 1 });

    const pinned = await pinDirectory(stableReceipt);
    try {
      Object.defineProperty(pinned.receipt, "path", {
        configurable: true,
        get: () => `${root}::$INDEX_ALLOCATION`,
      });
      await expect(pinned.assertCurrent()).resolves.toBeUndefined();
    } finally {
      await pinned.close();
    }
  });

  itWin32("best-effort directory sync swallows aliases without filesystem access", async () => {
    const root = await tempRoot("fs-safe-snapshot-best-effort-");
    const lstatSync = vi.spyOn(fsSync, "lstatSync");
    await syncDirectoryBestEffort(`${root}::$INDEX_ALLOCATION`);
    syncDirectoryBestEffortSync(`${root}::$INDEX_ALLOCATION`);
    expect(lstatSync).not.toHaveBeenCalled();
    lstatSync.mockRestore();
  });

  itWin32("snapshots archive output and staging pathname fields", async () => {
    const root = await tempRoot("fs-safe-snapshot-archive-output-");
    const destination = path.join(root, "destination");
    await fs.mkdir(destination);
    const destinationReal = await fs.realpath(destination);

    for (const prepare of [prepareArchiveOutputPath, preparePrivateArchiveOutputPath]) {
      const reads = { destinationDir: 0, destinationRealDir: 0, relPath: 0, outPath: 0,
        originalPath: 0, isDirectory: 0, deadline: 0 };
      const leaf = prepare === prepareArchiveOutputPath ? "public" : "private";
      const params = {
        get destinationDir() {
          reads.destinationDir += 1;
          return reads.destinationDir === 1 ? destination : `${destination}::$INDEX_ALLOCATION`;
        },
        get destinationRealDir() {
          reads.destinationRealDir += 1;
          return reads.destinationRealDir === 1 ? destinationReal : `${destinationReal}::$INDEX_ALLOCATION`;
        },
        get relPath() {
          reads.relPath += 1;
          return reads.relPath === 1 ? `${leaf}/payload.bin` : "unexpected/payload.bin";
        },
        get outPath() {
          reads.outPath += 1;
          return reads.outPath === 1
            ? path.join(destination, leaf, "payload.bin")
            : path.join(`${destination}::$INDEX_ALLOCATION`, "unexpected.bin");
        },
        get originalPath() {
          reads.originalPath += 1;
          return reads.originalPath === 1 ? `${leaf}/payload.bin` : "unexpected";
        },
        get isDirectory() {
          reads.isDirectory += 1;
          return false;
        },
        get deadline() {
          reads.deadline += 1;
          return undefined;
        },
      };
      await expect(prepare(params)).resolves.toBeUndefined();
      expect(reads).toEqual({ destinationDir: 1, destinationRealDir: 1, relPath: 1,
        outPath: 1, originalPath: 1, isDirectory: 1, deadline: 1 });
      await expect(fs.stat(path.join(destination, leaf))).resolves.toBeDefined();
    }

    let destinationReads = 0;
    let prefixReads = 0;
    let runReads = 0;
    await withStagedArchiveDestination({
      get destinationRealDir() {
        destinationReads += 1;
        return destinationReads === 1 ? destinationReal : `${destinationReal}::$INDEX_ALLOCATION`;
      },
      get stagingDirPrefix() {
        prefixReads += 1;
        return prefixReads === 1 ? "snapshot-" : "../escape-";
      },
      get run() {
        runReads += 1;
        if (runReads > 1) throw new Error("archive run callback was reread");
        return async () => "done";
      },
    });
    expect({ destinationReads, prefixReads, runReads })
      .toEqual({ destinationReads: 1, prefixReads: 1, runReads: 1 });
  });

  itWin32("uses the captured archive input in rejection diagnostics", async () => {
    const root = await tempRoot("fs-safe-snapshot-archive-input-");
    const directory = path.join(root, "not-an-archive");
    await fs.mkdir(directory);
    let pathReads = 0;
    const params = {
      get archivePath() {
        pathReads += 1;
        if (pathReads > 1) throw new Error("archive pathname was reread");
        return directory;
      },
      limits: resolveExtractLimits(),
      deadline: deadline(),
    };

    await expect(stageArchiveFileForExtraction(params))
      .rejects.toThrow(`archive is not a regular file: ${directory}`);
    expect(pathReads).toBe(1);
  });
});
