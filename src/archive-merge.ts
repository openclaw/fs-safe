import fs from "node:fs/promises";
import path from "node:path";
import { ownExtractionDestinationMutation, type ExtractionDeadline } from "./archive-deadline.js";
import {
  assertDirectoryIdentityGuard, assertResolvedInsideDestination,
  createDirectoryIdentityGuard, createArchiveSymlinkTraversalError,
  preparePrivateArchiveOutputPath,
} from "./archive-staging.js";
import { type AsyncDirectoryGuard } from "./directory-guard.js";
import { type DirectoryModeOwner } from "./directory-mode-owner.js";
import { pinNodeDirectoryForMode } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { formatErrorDetail } from "./error-detail.js";
import { isPathInside } from "./path.js";
import { root } from "./root.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

export type ArchivePublicationEntry = { path: string; kind: "file" | "directory"; mode: number };
type MergeParams = {
  sourceDir: string;
  destinationDir: string;
  destinationRealDir: string;
  deadline?: ExtractionDeadline;
};

export async function mergePlannedArchiveIntoDestination(
  params: MergeParams & { entries: readonly ArchivePublicationEntry[] },
): Promise<void> {
  await mergeTree(params, params.entries);
}

export async function mergeExtractedTreeIntoDestination(params: MergeParams): Promise<void> {
  await mergeTree(params);
}

async function mergeTree(params: MergeParams, publication?: readonly ArchivePublicationEntry[]): Promise<void> {
  const check = () => params.deadline?.check();
  check();
  const destinationGuard = await createDirectoryIdentityGuard(params.destinationRealDir);
  check();
  const targetRoot = await root(params.destinationRealDir);
  check();
  const sourceGuard = await createDirectoryIdentityGuard(params.sourceDir);
  check();
  const plan = publication ? new Map<string, ArchivePublicationEntry>() : undefined;
  for (const entry of publication ?? []) {
    // Resolve admitted spelling in private staging, preserving the volume's case
    // and Unicode behavior without assigning explicit modes to distinct parents.
    const stagedPath = await fs.realpath(path.join(params.sourceDir, entry.path));
    check();
    if (!isPathInside(sourceGuard.realPath, stagedPath) || plan!.has(stagedPath)) {
      throw new FsSafeError("path-mismatch", "archive publication paths changed in staging");
    }
    plan!.set(stagedPath, entry);
  }
  const ancestors: Array<{ guard: AsyncDirectoryGuard; owner: DirectoryModeOwner }> = [];
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
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    check();
    for (const entry of entries) {
      await assertGuards();
      const sourcePath = path.join(sourceDir, entry.name);
      const relPath = path.relative(params.sourceDir, sourcePath);
      const originalPath = relPath.split(path.sep).join("/");
      const destinationPath = path.join(params.destinationDir, relPath);
      const sourceStat = await fs.lstat(sourcePath);
      check();
      if (sourceStat.isSymbolicLink()) throw createArchiveSymlinkTraversalError(originalPath);
      const sourceReal = await fs.realpath(sourcePath);
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
      const mode = plan ? planned?.mode ?? 0o755 : sourceStat.mode & 0o777;
      await preparePrivateArchiveOutputPath({
        ...params, relPath, outPath: destinationPath, originalPath, isDirectory: kind === "directory",
      }, assertGuards);
      check();
      if (kind === "directory") {
        // Ownership spans open, descendants, finalization and close, including timeout.
        await ownExtractionDestinationMutation(params.deadline, async () => {
          await assertGuards();
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
              await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("chmod", destinationPath);
              check();
              await assertGuards();
              // Do not recursively verify this owner from inside its serialized apply.
              ancestors.pop();
              await owner.apply(mode, { check, beforeChmod: async () => {
                await assertGuards();
                await assertDirectoryIdentityGuard(guard);
                check();
                await assertResolvedInsideDestination({
                  destinationRealDir: params.destinationRealDir, targetPath: destinationPath, originalPath,
                });
                check();
              } });
              check();
              await assertGuards();
            } finally {
              if (ancestors.at(-1)?.owner === owner) ancestors.pop();
            }
          } finally {
            await owner.close();
          }
        });
      } else {
        await ownExtractionDestinationMutation(params.deadline, async () => {
          await assertGuards();
          try {
            await targetRoot.copyIn(relPath, sourcePath, { mkdir: true, mode });
            check();
            await assertGuards();
            await assertResolvedInsideDestination({
              destinationRealDir: params.destinationRealDir, targetPath: destinationPath, originalPath,
            });
            check();
            const stat = await fs.lstat(destinationPath);
            check();
            if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
              throw createArchiveSymlinkTraversalError(originalPath);
            }
          } catch (error) {
            // copyIn alone owns cleanup; no receipt permits archive-layer unlink.
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
}
