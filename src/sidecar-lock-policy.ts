import fs from "node:fs/promises";
import type { SidecarLockRetryOptions } from "./sidecar-lock-types.js";

export function computeSidecarLockDelayMs(retry: SidecarLockRetryOptions, attempt: number): number {
  const minTimeout = retry.minTimeout ?? 50;
  const maxTimeout = retry.maxTimeout ?? 1000;
  const factor = retry.factor ?? 1;
  const base = Math.min(maxTimeout, Math.max(minTimeout, minTimeout * factor ** attempt));
  const jitter = retry.randomize ? 1 + Math.random() : 1;
  return Math.min(maxTimeout, Math.round(base * jitter));
}

// Windows denies access to a lock file while a just-unlinked directory entry
// is still being torn down, so a contended acquire sees EPERM on a name that is
// already gone -- both when creating it exclusively and when reading the
// holder's snapshot. The next attempt succeeds, so this is contention rather
// than a permission failure. The error must name the lock file itself: the
// exclusive-create helper opens the parent directory first, and a denial from
// that setup step carries no teardown evidence and has to reach the caller.
export const maxTransientLockDenials = 8;

export function isTransientLockFileDenial(error: unknown, lockPath: string): boolean {
  const denial = error as NodeJS.ErrnoException | null;
  return process.platform === "win32" && denial?.code === "EPERM" && denial.path === lockPath;
}

export function sidecarLockPayloadIsStale(
  payload: unknown,
  staleMs: number,
  nowMs: number,
): boolean {
  const createdAtMs = sidecarLockPayloadCreatedAtMs(payload);
  return createdAtMs !== null && nowMs - createdAtMs > staleMs;
}

export function sidecarLockPayloadCreatedAtMs(payload: unknown): number | null {
  const createdAt =
    payload &&
    typeof payload === "object" &&
    "createdAt" in payload &&
    typeof payload.createdAt === "string"
      ? payload.createdAt
      : "";
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) ? createdAtMs : null;
}

export async function defaultSidecarLockShouldReclaim(params: {
  lockPath: string;
  payload: unknown;
  staleMs: number;
  nowMs: number;
}): Promise<boolean> {
  const createdAtMs = sidecarLockPayloadCreatedAtMs(params.payload);
  if (createdAtMs !== null) return params.nowMs - createdAtMs > params.staleMs;
  try {
    return params.nowMs - (await fs.stat(params.lockPath)).mtimeMs > params.staleMs;
  } catch {
    return true;
  }
}
