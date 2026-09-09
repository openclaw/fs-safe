import fs from "node:fs/promises";
import path from "node:path";
import { ownExtractionDestinationMutation, type ExtractionDeadline } from "./archive-deadline.js";
import { assertDirectoryIdentityGuard, assertResolvedInsideDestination, createArchiveSymlinkTraversalError } from "./archive-staging.js";
import type { AsyncDirectoryGuard } from "./directory-guard.js";
import { pinNodeDirectoryForMode } from "./directory-mode-node.js";
import { pinDirectory, syncDirectory, type PinnedDirectory } from "./directory-durability.js";
import { syncFileBestEffort } from "./file-sync.js";
import type { PublishedWriteIdentity } from "./pinned-write.js";
import type { Root } from "./root.js";
import { normalizePinnedWriteError } from "./root-errors.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { FsSafeError } from "./errors.js";

export type ArchivePublishedFile = {
  relativePath: string;
  identity: PublishedWriteIdentity;
  guards: readonly AsyncDirectoryGuard[];
};
export type ArchivePublishedDirectory = {
  guard: AsyncDirectoryGuard;
  parents: readonly AsyncDirectoryGuard[];
  mode: number;
};

export async function finalizeArchivePublication(params: {
  targetRoot: Root;
  destinationGuard: AsyncDirectoryGuard;
  sourceGuard: AsyncDirectoryGuard;
  files: readonly ArchivePublishedFile[];
  directories: readonly ArchivePublishedDirectory[];
  durable: boolean;
  deadline?: ExtractionDeadline;
}): Promise<void> {
  const check = () => params.deadline?.check();
  const assertGuards = async (guards: readonly AsyncDirectoryGuard[]) => {
    for (const guard of [params.destinationGuard, ...guards, params.sourceGuard]) {
      await assertDirectoryIdentityGuard(guard);
      check();
    }
  };
  await ownExtractionDestinationMutation(params.deadline, async () => {
    if (params.durable) {
      // Join every active sync before propagating failure or starting another batch.
      for (let offset = 0; offset < params.files.length; offset += 8) {
        check();
        const results = await Promise.allSettled(params.files.slice(offset, offset + 8).map(async (file) => {
          await assertGuards(file.guards);
          await using opened = await params.targetRoot.open(file.relativePath, { hardlinks: "reject", symlinks: "reject" })
            .catch((error: unknown) => {
              if (error instanceof FsSafeError && (error.code === "hardlink" || error.code === "path-alias")) {
                throw createArchiveSymlinkTraversalError(file.relativePath);
              }
              throw error;
            });
          check();
          await inspectFileIdentity(() => opened.handle.stat({ bigint: true }), file.identity);
          check();
          await syncFileBestEffort(opened.handle).catch((error: unknown) => { throw normalizePinnedWriteError(error); });
          check();
          await assertGuards(file.guards);
          await inspectFileIdentity(async () => {
            const stat = await fs.lstat(opened.realPath, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1n) {
              throw new FsSafeError("path-mismatch", "archive file changed during durability pass");
            }
            return stat;
          }, file.identity);
          check();
        }));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
    }
    // Leave working modes intact until file syncing finishes. Re-pin one directory
    // at a time against its original guard, so wide archives do not exhaust fds.
    const directories = [...params.directories].sort((a, b) =>
      b.guard.dir.split(path.sep).length - a.guard.dir.split(path.sep).length);
    for (const directory of directories) {
      const guards = [...directory.parents, directory.guard];
      await assertGuards(guards);
      const owner = await pinNodeDirectoryForMode(directory.guard.dir);
      let pinned: PinnedDirectory | undefined;
      try {
        check();
        await assertGuards(guards);
        if (params.durable && process.platform !== "win32") {
          // An existing search-only directory may become readable in its final mode.
          try { pinned = await pinDirectory(directory.guard.dir); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error; }
          check();
        }
        await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("chmod", directory.guard.dir);
        check();
        await assertGuards(guards);
        await owner.apply(directory.mode, { check, beforeChmod: async () => {
          await assertGuards(guards);
          await assertResolvedInsideDestination({ destinationRealDir: params.destinationGuard.realPath,
            targetPath: directory.guard.dir, originalPath: path.relative(params.targetRoot.rootDir, directory.guard.dir) });
          check();
        } });
        check();
        await assertGuards(guards);
        if (params.durable) {
          if (process.platform === "win32") {
            await syncDirectory(directory.guard.dir).catch((error: unknown) => { throw normalizePinnedWriteError(error); });
          } else {
            pinned ??= await pinDirectory(directory.guard.dir);
            check();
            await pinned.sync().catch((error: unknown) => { throw normalizePinnedWriteError(error); });
          }
          check();
          await assertGuards(guards);
        }
      } finally {
        try { await pinned?.close(); } finally { await owner.close(); }
      }
    }
    if (params.durable) {
      await assertGuards([]);
      await syncDirectory(params.destinationGuard.realPath).catch((error: unknown) => { throw normalizePinnedWriteError(error); });
      check();
      await assertGuards([]);
    }
  });
}
