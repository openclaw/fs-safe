import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { sameFileIdentity } from "./file-identity.js";

export type SidecarLockStaleSnapshot = {
  lockPath: string;
  normalizedTargetPath: string;
  raw: string;
  payload: Record<string, unknown> | null;
};

export type SidecarLockSnapshot = {
  raw?: string;
  payload: Record<string, unknown> | null;
  stat?: Stats;
};

export async function readSidecarLockSnapshot(
  lockPath: string,
): Promise<SidecarLockSnapshot | null> {
  try {
    const stat = await fs.lstat(lockPath);
    const raw = await fs.readFile(lockPath, "utf8");
    try {
      const parsed = JSON.parse(raw) as unknown;
      const payload =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      return { raw, payload, stat };
    } catch {
      return { raw, payload: null, stat };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function sidecarLockSnapshotMatches(
  current: SidecarLockSnapshot,
  observed: SidecarLockSnapshot,
): boolean {
  if (observed.stat && current.stat && !sameFileIdentity(observed.stat, current.stat)) {
    return false;
  }
  if (observed.raw !== undefined) {
    return current.raw === observed.raw;
  }
  return observed.stat !== undefined && current.stat !== undefined;
}

export async function removeSidecarLockIfUnchanged(
  lockPath: string,
  observed: SidecarLockSnapshot | null,
): Promise<boolean> {
  const current = await readSidecarLockSnapshot(lockPath);
  if (!current || !observed || !sidecarLockSnapshotMatches(current, observed)) {
    return false;
  }
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
  return true;
}

export async function sidecarLockSnapshotStillPresent(
  lockPath: string,
  observed: SidecarLockSnapshot | null,
): Promise<boolean> {
  const current = await readSidecarLockSnapshot(lockPath);
  return !!current && !!observed && sidecarLockSnapshotMatches(current, observed);
}

export async function sidecarReclaimGuardExists(pathname: string): Promise<boolean> {
  try {
    await fs.lstat(pathname);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function tryAcquireSidecarReclaimGuard(
  reclaimGuards: Set<string>,
  reclaimGuardPath: string,
): Promise<boolean> {
  try {
    await fs.mkdir(reclaimGuardPath);
    reclaimGuards.add(reclaimGuardPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

export async function releaseSidecarReclaimGuard(
  reclaimGuards: Set<string>,
  reclaimGuardPath: string,
): Promise<void> {
  await fs.rmdir(reclaimGuardPath);
  reclaimGuards.delete(reclaimGuardPath);
}

export async function removeStaleSidecarLockIfAllowed(params: {
  lockPath: string;
  normalizedTargetPath: string;
  snapshot: SidecarLockSnapshot;
  shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean | Promise<boolean>;
}): Promise<"removed" | "changed" | "not-approved"> {
  if (!params.shouldRemoveStaleLock || params.snapshot.raw === undefined) {
    return "not-approved";
  }
  if (!(await sidecarLockSnapshotStillPresent(params.lockPath, params.snapshot))) {
    return "changed";
  }
  if (
    !(await params.shouldRemoveStaleLock({
      lockPath: params.lockPath,
      normalizedTargetPath: params.normalizedTargetPath,
      raw: params.snapshot.raw,
      payload: params.snapshot.payload,
    }))
  ) {
    return "not-approved";
  }
  if (!(await sidecarLockSnapshotStillPresent(params.lockPath, params.snapshot))) {
    return "changed";
  }
  try {
    await fs.rm(params.lockPath);
    return "removed";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "changed";
    }
    throw err;
  }
}
