import fsSync from "node:fs";
import type { SidecarLockReclaimParams, SidecarLockRetryOptions } from "./sidecar-lock-types.js";

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

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

export function validateSidecarLockStaleMs(staleMs: number | undefined): void {
  // The lower-level sidecar manager historically treats an omitted threshold
  // as disabling age-based reclamation. Its public type requires a number, but
  // retain that fail-closed runtime behavior for JavaScript callers and older
  // consumers.
  if (staleMs === undefined || staleMs === Number.POSITIVE_INFINITY) return;
  assertFiniteNonNegative(staleMs, "lock staleMs");
}

export function validateSidecarLockCompromiseCheckIntervalMs(intervalMs: number | undefined): void {
  if (intervalMs === undefined || intervalMs === 0) return;
  if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `lock compromiseCheckIntervalMs must be 0 or a finite number between 1 and ${MAX_TIMER_DELAY_MS}`,
    );
  }
}

export function computeSidecarLockDelayMs(retry: SidecarLockRetryOptions, attempt: number): number {
  validateSidecarLockRetryOptions(retry);
  const minTimeout = retry.minTimeout ?? 50;
  const maxTimeout = retry.maxTimeout ?? 1000;
  const factor = retry.factor ?? 1;
  // Zero times an overflowing power is NaN, which makes Atomics.wait unbounded.
  const scaled = minTimeout === 0 ? 0 : minTimeout * factor ** attempt;
  const base = Math.min(maxTimeout, Math.max(minTimeout, scaled));
  const jitter = retry.randomize ? 1 + Math.random() : 1;
  return Math.min(maxTimeout, Math.round(base * jitter));
}

export function sidecarLockTimeout(lockPath: string, normalizedTargetPath: string): Error {
  return Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
    code: "file_lock_timeout",
    lockPath,
    normalizedTargetPath,
  });
}

export function sidecarLockStale(lockPath: string, normalizedTargetPath: string): Error {
  return Object.assign(new Error(`file lock stale for ${normalizedTargetPath}`), {
    code: "file_lock_stale",
    lockPath,
    normalizedTargetPath,
  });
}

/** Undefined means the deadline or retry count is exhausted. */
export function sidecarLockRetryDelay(
  retry: SidecarLockRetryOptions,
  timeoutMs: number | undefined,
  elapsed: number,
  attempt: number,
): number | undefined {
  if (
    (timeoutMs !== undefined && elapsed >= timeoutMs) ||
    (retry.retries !== undefined && attempt >= retry.retries)
  ) return undefined;
  const remaining = timeoutMs === undefined || timeoutMs === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY : Math.max(0, timeoutMs - elapsed);
  return Math.min(computeSidecarLockDelayMs(retry, attempt), remaining);
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

export async function defaultSidecarLockShouldReclaim(
  params: Pick<SidecarLockReclaimParams, "lockPath" | "payload" | "staleMs" | "nowMs">,
): Promise<boolean> {
  const createdAtMs = sidecarLockPayloadCreatedAtMs(params.payload);
  if (createdAtMs !== null) return params.nowMs - createdAtMs > params.staleMs;
  try {
    return params.nowMs - fsSync.statSync(params.lockPath).mtimeMs > params.staleMs;
  } catch {
    return true;
  }
}
