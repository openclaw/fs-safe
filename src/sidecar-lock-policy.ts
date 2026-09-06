import fs from "node:fs/promises";
import type { SidecarLockRetryOptions } from "./sidecar-lock-types.js";

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

export function validateSidecarLockRetryOptions(retry: SidecarLockRetryOptions): void {
  if (retry.retries !== undefined && (!Number.isSafeInteger(retry.retries) || retry.retries < 0)) {
    throw new RangeError("lock retry.retries must be a non-negative safe integer");
  }
  if (retry.factor !== undefined) assertFiniteNonNegative(retry.factor, "lock retry.factor");
  if (retry.minTimeout !== undefined) {
    assertFiniteNonNegative(retry.minTimeout, "lock retry.minTimeout");
  }
  if (retry.maxTimeout !== undefined) {
    assertFiniteNonNegative(retry.maxTimeout, "lock retry.maxTimeout");
  }
  if (
    retry.minTimeout !== undefined &&
    retry.maxTimeout !== undefined &&
    retry.minTimeout > retry.maxTimeout
  ) {
    throw new RangeError("lock retry.minTimeout must not exceed retry.maxTimeout");
  }
}

export function validateSidecarLockTimeoutMs(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined || timeoutMs === Number.POSITIVE_INFINITY) return;
  assertFiniteNonNegative(timeoutMs, "lock timeoutMs");
}

export function computeSidecarLockDelayMs(retry: SidecarLockRetryOptions, attempt: number): number {
  validateSidecarLockRetryOptions(retry);
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
