import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ownExtractionDestinationMutation, type ExtractionDeadline } from "./archive-deadline.js";
import {
  assertDirectoryIdentityGuard, assertResolvedInsideDestination,
  createDirectoryIdentityGuard, createArchiveSymlinkTraversalError,
  preparePrivateArchiveOutputPath,
  type ArchiveDirectoryGuard,
} from "./archive-staging.js";
import { type DirectoryModeOwner } from "./directory-mode-owner.js";
import { pinNodeDirectoryForMode } from "./directory-mode-node.js";
import { assertSyncDirectoryGuard, inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { formatErrorDetail } from "./error-detail.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { rootFromDirectoryGuard } from "./root-impl.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { realpathSync } from "./realpath.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { onCopyPublication, onCopySourceAdmission, type CopyPublicationOptions } from "./copy-publication.js";
import { syncFileBestEffortSync } from "./file-sync.js";
import { finalizeArchivePublication, type ArchivePublishedDirectory, type ArchivePublishedFile } from "./archive-durability.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

export type ArchivePublicationEntry = { path: string; kind: "file" | "directory"; mode: number };
type MergeParams = {
  sourceDir: string;
  destinationDir: string;
  destinationRealDir: string;
  deadline?: ExtractionDeadline;
};
type GuardedMergeParams = Pick<MergeParams, "sourceDir" | "deadline"> & {
  destinationGuard: ArchiveDirectoryGuard;
};

export async function mergePlannedArchiveIntoDestination(
  params: GuardedMergeParams & { entries: readonly ArchivePublicationEntry[]; durable?: boolean; entryUmask?: number },
): Promise<void> {
  assertMergePathInputs(params);
  await mergeTree(params, params.entries, params.durable === true, params.entryUmask);
}

export async function mergeExtractedTreeIntoDestination(params: MergeParams): Promise<void> {
  const sourceDir = params.sourceDir;
  const destinationDir = params.destinationDir;
  const destinationRealDir = params.destinationRealDir;
  assertNoWindowsPathAlias(sourceDir);
  assertNoWindowsPathAlias(destinationDir);
  assertNoWindowsPathAlias(destinationRealDir);
  const destinationGuard = await createDirectoryIdentityGuard(destinationRealDir);
  await mergeTree({ sourceDir, deadline: params.deadline, destinationGuard });
}

function assertMergePathInputs(params: GuardedMergeParams): void {
  assertNoWindowsPathAlias(params.sourceDir);
  assertNoWindowsPathAlias(params.destinationGuard.dir);
  assertNoWindowsPathAlias(params.destinationGuard.realPath);
}

async function mergeTree(params: GuardedMergeParams, publication?: readonly ArchivePublicationEntry[], durable = true, entryUmask = 0): Promise<void> {
  const publishedFiles: ArchivePublishedFile[] = [];
  const publishedDirectories: ArchivePublishedDirectory[] = [];
  const check = () => params.deadline?.check();
  check();
  const { destinationGuard } = params;
  const destinationDir = destinationGuard.dir;
  const destinationRealDir = destinationGuard.realPath;
  const targetRoot = rootFromDirectoryGuard(destinationGuard);
  check();
  const sourceGuard = await createDirectoryIdentityGuard(params.sourceDir);
  check();
  const plan = publication ? new Map<string, ArchivePublicationEntry>() : undefined;
  for (const entry of publication ?? []) {
    // Resolve admitted spelling in private staging, preserving the volume's case
    // and Unicode behavior without assigning explicit modes to distinct parents.
    const stagedPath = realpathSync.native(path.join(params.sourceDir, entry.path));
    check();
    if (!isPathInside(sourceGuard.realPath, stagedPath) || plan!.has(stagedPath)) {
      throw new FsSafeError("path-mismatch", "archive publication paths changed in staging");
    }
    plan!.set(stagedPath, entry);
  }
  const ancestors: Array<{ guard: ArchiveDirectoryGuard; owner: DirectoryModeOwner }> = [];
  const sourceAncestors: ArchiveDirectoryGuard[] = [];
  const assertSourceDirectory = (guard: ArchiveDirectoryGuard, canonical = false) => {
    try {
      // Child receipts already retain canonical ancestry. An exact no-follow
      // observation checks each named association without re-running realpath.
      if (canonical) assertSyncDirectoryGuard(guard);
      else inspectDirectoryIdentitySync(guard.dir, guard.stat);
    } catch (error) {
      if (error instanceof FsSafeError || isNotFoundPathError(error)) {
        throw createArchiveSymlinkTraversalError(path.relative(params.sourceDir, guard.dir));
      }
      throw error;
    }
    check();
  };
  const assertSourceFrontier = () => {
    const current = sourceAncestors.at(-1);
    if (current) assertSourceDirectory(current);
  };
  const assertSourceAncestors = () => {
    for (const ancestor of sourceAncestors) assertSourceDirectory(ancestor);
  };
  const assertGuards = async () => {
    await assertDirectoryIdentityGuard(destinationGuard);
    check();
    for (const ancestor of ancestors) {
      await assertDirectoryIdentityGuard(ancestor.guard);
      check();
      await ancestor.owner.verify(check);
      check();
    }
    await assertDirectoryIdentityGuard(sourceGuard);
    check();
  };
  const walk = async (sourceDir: string): Promise<void> => {
    await assertGuards();
    assertSourceFrontier();
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    check();
    if (entries.length === 0) {
      await assertGuards();
      assertSourceFrontier();
    }
    for (const entry of entries) {
      await assertGuards();
      assertSourceFrontier();
      const sourcePath = path.join(sourceDir, entry.name);
      const relPath = path.relative(params.sourceDir, sourcePath);
      const originalPath = relPath.split(path.sep).join("/");
      const destinationPath = path.join(destinationDir, relPath);
      const sourceStat = inspectFileIdentitySync(() => fsSync.lstatSync(sourcePath, { bigint: true }));
      check();
      if (sourceStat.isSymbolicLink()) throw createArchiveSymlinkTraversalError(originalPath);
      const sourceReal = realpathSync.native(sourcePath);
      check();
      if (!isPathInside(sourceGuard.realPath, sourceReal)) throw createArchiveSymlinkTraversalError(originalPath);
      if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
        throw new Error(`archive staging contains unsupported entry: ${formatErrorDetail(originalPath)}`);
      }
      const kind = sourceStat.isDirectory() ? "directory" : "file";
      const planned = plan?.get(sourceReal);
      if (plan && ((planned && planned.kind !== kind) || (!planned && kind === "file"))) {
        throw new FsSafeError("path-mismatch", "archive staging disagrees with the admitted publication plan");
      }
      let mode = plan ? (planned?.mode ?? 0o755) & ~entryUmask : Number(sourceStat.mode & 0o777n);
      await preparePrivateArchiveOutputPath({
        destinationDir, destinationRealDir, deadline: params.deadline,
        relPath, outPath: destinationPath, originalPath, isDirectory: kind === "directory",
      }, assertGuards, destinationGuard);
      check();
      if (kind === "directory") {
        // Retain the observation made before output preparation: recapturing
        // here could silently authorize a replacement source directory.
        sourceAncestors.push({ dir: sourcePath, realPath: sourceReal, stat: sourceStat });
        try {
          // Ownership spans open, descendants, finalization and close, including timeout.
          await ownExtractionDestinationMutation(params.deadline, async () => {
            await assertGuards();
            assertSourceFrontier();
            const owner = await pinNodeDirectoryForMode(destinationPath).catch((error: unknown) => {
              if (error instanceof FsSafeError && (error.code === "not-file" || error.code === "path-mismatch")) {
                throw createArchiveSymlinkTraversalError(originalPath);
              }
              throw error;
            });
            try {
              check();
              const guard = await createDirectoryIdentityGuard(destinationPath);
              check();
              await owner.verify(check);
              ancestors.push({ guard, owner });
              try {
                await walk(sourcePath);
                if (publication) {
                  await assertGuards();
                  assertSourceAncestors();
                  publishedDirectories.push({ guard, mode, parents: ancestors.slice(0, -1).map((ancestor) => ancestor.guard) });
                  return;
                }
                await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("chmod", destinationPath);
                check();
                await assertGuards();
                // Do not recursively verify this owner from inside its serialized apply.
                ancestors.pop();
                await owner.apply(mode, { check, beforeChmod: async () => {
                  await assertGuards();
                  assertSourceAncestors();
                  await assertDirectoryIdentityGuard(guard);
                  check();
                  await assertResolvedInsideDestination({
                    destinationRealDir, targetPath: destinationPath, originalPath,
                  });
                  check();
                } });
                check();
                await assertGuards();
                assertSourceAncestors();
              } finally {
                if (ancestors.at(-1)?.owner === owner) ancestors.pop();
              }
            } finally {
              await owner.close();
            }
          });
        } finally {
          sourceAncestors.pop();
        }
      } else {
        await ownExtractionDestinationMutation(params.deadline, async () => {
          await assertGuards();
          try {
            const options: CopyPublicationOptions & { mkdir: boolean; mode: number; durable: boolean } = {
              mkdir: false, mode, durable: publication ? false : true,
              [onCopySourceAdmission]: (identity, realPath) => {
                assertSourceDirectory(sourceGuard, true);
                assertSourceFrontier();
                inspectFileIdentitySync(() => identity, sourceStat);
                if (!admitPathInsideRoot({
                  rootPath: sourceGuard.realPath, candidatePath: realPath, rootIdentity: sourceGuard.stat,
                })) throw createArchiveSymlinkTraversalError(originalPath);
                // Public merge permissions come from the admitted descriptor;
                // extraction keeps the separately admitted publication plan.
                if (!plan) mode = Number(identity.mode & 0o777n);
                return { mode, verify() {
                  // Only copy publication boundaries scan the active chain.
                  // Destination mkdir callbacks must not multiply this work.
                  assertSourceDirectory(sourceGuard, true);
                  assertSourceAncestors();
                } };
              },
            };
            if (publication && durable) {
              options[onCopyPublication] = async (fd, identity) => {
                check();
                if ((mode & 0o400) === 0) {
                  // Final mode may prohibit reopening. Sync the writer's still-owned
                  // descriptor without widening permissions or syncing its parent.
                  syncFileBestEffortSync(fd);
                  check();
                } else {
                  publishedFiles.push({ relativePath: relPath, identity,
                    guards: ancestors.map((ancestor) => ancestor.guard) });
                }
              };
            }
            await targetRoot.copyIn(relPath, sourcePath, options);
            check();
            await assertGuards();
            await assertResolvedInsideDestination({
              destinationRealDir, targetPath: destinationPath, originalPath,
            });
            check();
            const stat = fsSync.lstatSync(destinationPath);
            check();
            if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
              throw createArchiveSymlinkTraversalError(originalPath);
            }
          } catch (error) {
            // copyIn cleans unpublished stages; merge never gains rollback authority.
            if (error instanceof FsSafeError && (error.code === "hardlink" || error.code === "path-alias")) {
              throw createArchiveSymlinkTraversalError(originalPath);
            }
            throw error;
          }
        });
      }
    }
  };
  await walk(params.sourceDir);
  if (publication) {
    await finalizeArchivePublication({ targetRoot, destinationGuard, sourceGuard,
      files: publishedFiles, directories: publishedDirectories, durable, deadline: params.deadline });
  }
}
