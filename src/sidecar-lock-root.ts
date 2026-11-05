import path from "node:path";
import { cleanupSidecarStages, sidecarPublicationPending } from "./sidecar-lock-staging.js";
import { admitFileLockSyncRootPath, assertFileLockSyncRootPathsCurrent, assertFileLockSyncRootResolvedPathCurrent, captureFileLockSyncRootAuthority } from "./file-lock-sync-root.js";
import { assertRetainedParentCurrent, observeDirectory } from "./file-lock-sync-root-io.js";
import { inspectDirectoryIdentity } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { fileObservation } from "./file-observation.js";
import { isNotFoundPathError } from "./path.js";
import type { OpenResult, Root } from "./root-impl.js";
import { resolveRootPath } from "./root-path.js";

export async function rootSidecarPublicationPending(lockRoot: Root, relative: string, cleanAbandoned = false): Promise<boolean> {
  const resolved = await lockRoot.resolve(relative);
  const parent = path.dirname(resolved);
  const identity = await inspectDirectoryIdentity(parent);
  if (cleanAbandoned) {
    const admitted = admitFileLockSyncRootPath(captureFileLockSyncRootAuthority(lockRoot), resolved);
    const receipt = observeDirectory(path.dirname(admitted.path));
    cleanupSidecarStages(admitted.path, () => {
      assertFileLockSyncRootPathsCurrent([admitted]);
      assertFileLockSyncRootResolvedPathCurrent(admitted);
      assertRetainedParentCurrent(admitted, receipt);
    });
  }
  const pending = sidecarPublicationPending(resolved);
  await inspectDirectoryIdentity(parent, identity);
  return pending && await lockRoot.resolve(relative) === resolved;
}

export async function openSidecarRoot(
  lockRoot: Root,
  relative: string,
  discardObservation?: "unlinked" | "changed",
  onOpenFailure?: (error: unknown) => void,
): Promise<OpenResult | null> {
  const resolved = await lockRoot.resolve(relative);
  const canonicalPath = async () => (await resolveRootPath({
    absolutePath: resolved,
    rootPath: lockRoot.rootReal,
    rootCanonicalPath: lockRoot.rootReal,
    boundaryLabel: "sidecar lock root",
  })).canonicalPath;
  const expectedRealPath = await canonicalPath();
  if (expectedRealPath === lockRoot.rootReal) throw new FsSafeError("not-file", "sidecar lock is a directory");
  const parents = [];
  let completeParents = true;
  if (discardObservation) {
    // Follow permitted in-root aliases first; receipts cover canonical ancestry.
    for (let dir = path.dirname(expectedRealPath); ; dir = path.dirname(dir)) {
      try {
        parents.push({ dir, stat: await inspectDirectoryIdentity(dir) });
      } catch (error) {
        if (!isNotFoundPathError(error)) throw error;
        completeParents = false;
      }
      if (dir === lockRoot.rootReal) break;
    }
  }
  const observation = fileObservation();
  try {
    const opened = await observation.run(() => lockRoot.open(relative));
    if (opened.realPath !== expectedRealPath) {
      await opened.handle.close().catch(() => undefined);
      throw new FsSafeError("path-mismatch", "sidecar lock path changed during open");
    }
    return opened;
  } catch (error) {
    if (discardObservation && error instanceof FsSafeError && error.code === "hardlink" &&
      await rootSidecarPublicationPending(lockRoot, relative)) return null;
    const openFailed = observation.has(error, `open:${resolved}`);
    if (openFailed) onOpenFailure?.(error);
    const missing = openFailed && error instanceof FsSafeError && error.code === "not-found";
    if (missing && !discardObservation) return null;
    const discardable = observation.has(error, `unlinked:${resolved}`) ||
      (discardObservation === "changed" && observation.has(error, `changed:${resolved}`));
    if (!discardObservation || (!missing && (!completeParents || !discardable))) throw error;
    try {
      const probe = fileObservation();
      try {
        const current = await probe.run(() => lockRoot.stat(relative));
        if (!current.isFile || current.isSymbolicLink || current.nlink !== 1) throw error;
      } catch (probeError) {
        if (!(probeError instanceof FsSafeError && probeError.code === "not-found") &&
          !probe.has(probeError, `stat-leaf-missing:${expectedRealPath}`) &&
          !probe.has(probeError, `stat-leaf-changed:${expectedRealPath}`)) throw probeError;
      }
      for (const { dir, stat } of parents) await inspectDirectoryIdentity(dir, stat);
      await lockRoot.resolve(relative);
      if (await canonicalPath() === expectedRealPath) return null;
    } catch {
      // Keep the original failure when directory or confinement proof fails.
    }
    throw error;
  }
}
