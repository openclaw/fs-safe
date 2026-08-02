import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { createNativeExclusiveFile, type NativeFileHandle } from "./native-operations.js";
import type { Root } from "./root-impl.js";
import {
  computeSidecarLockDelayMs,
  defaultSidecarLockShouldReclaim,
  isTransientLockFileDenial,
  maxTransientLockDenials,
} from "./sidecar-lock-policy.js";
import {
  readSidecarLockSnapshot,
  relativeSidecarLockPath,
  releaseSidecarReclaimGuard,
  removeSidecarLockIfUnchanged,
  removeStaleSidecarLockIfAllowed,
  serializeSidecarLockPayload,
  sidecarLockSnapshotStillPresent,
  sidecarReclaimGuardExists,
  tryAcquireSidecarReclaimGuard,
  type SidecarLockSnapshot,
} from "./sidecar-lock-reclaim.js";
import type { SidecarLockAcquireOptions, SidecarLockHandle } from "./sidecar-lock-types.js";

type SidecarFileHandle = Pick<NativeFileHandle, "close" | "stat" | "writeFile">;

export type HeldSidecarLock = {
  refCount: number;
  reentrantOwner?: string;
  handle: SidecarFileHandle;
  lockPath: string;
  snapshot: SidecarLockSnapshot;
  acquiredAt: number;
  metadata: Record<string, unknown>;
  releasePromise?: Promise<void>;
  lockRoot?: Root;
  parsePayload?: (raw: string) => unknown;
  compromiseTimer?: NodeJS.Timeout;
};

type SidecarLockAcquisitionContext = {
  held: Map<string, HeldSidecarLock>;
  reclaimGuards: Set<string>;
  ensureExitCleanupRegistered(): void;
  handleForHeldLock(normalizedTargetPath: string, held: HeldSidecarLock): SidecarLockHandle;
  releaseHeldLock(
    normalizedTargetPath: string,
    held: HeldSidecarLock,
    options?: { force?: boolean },
  ): Promise<boolean>;
};

async function resolveNormalizedTargetPath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  try {
    return path.join(await fs.realpath(dir), path.basename(resolved));
  } catch {
    return resolved;
  }
}

export async function acquireSidecarLock<TPayload extends Record<string, unknown>>(
  options: SidecarLockAcquireOptions<TPayload>,
  context: SidecarLockAcquisitionContext,
): Promise<SidecarLockHandle> {
  context.ensureExitCleanupRegistered();
  const normalizedTargetPath = await resolveNormalizedTargetPath(options.targetPath);
  const lockPath = options.lockPath ?? `${normalizedTargetPath}.lock`;
  const held = context.held.get(normalizedTargetPath);
  if (
    held &&
    options.reentrantOwner !== undefined &&
    held.reentrantOwner !== undefined &&
    options.reentrantOwner === held.reentrantOwner
  ) {
    held.refCount += 1;
    return context.handleForHeldLock(normalizedTargetPath, held);
  }

  const startedAt = Date.now();
  const retry = options.retry ?? {};
  const maxRetries = options.timeoutMs === Number.POSITIVE_INFINITY ? undefined : retry.retries;
  const reclaimGuardPath = `${lockPath}.reclaim`;
  let ownsReclaimGuard = false;
  let attempt = 0;
  // Bounded so a genuine denial still surfaces as EPERM, not a lock timeout.
  let transientDenials = 0;
  const withinDenialBudget = (): boolean => ++transientDenials <= maxTransientLockDenials;
  const waitForRetry = async (): Promise<void> => {
    const elapsed = Date.now() - startedAt;
    if (
      (options.timeoutMs !== undefined &&
        options.timeoutMs !== Number.POSITIVE_INFINITY &&
        elapsed >= options.timeoutMs) ||
      (maxRetries !== undefined && attempt >= maxRetries)
    ) {
      throw Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
        code: "file_lock_timeout",
        lockPath,
        normalizedTargetPath,
      });
    }
    const remaining =
      options.timeoutMs === undefined || options.timeoutMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(0, options.timeoutMs - elapsed);
    const delay = Math.min(computeSidecarLockDelayMs(retry, attempt), remaining);
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
  };
  // Waiting can fail on the caller's own retry or deadline limits. Classifying
  // a denial as contention must not cost them the original diagnosis, so hand
  // the denial back when no further attempt can be scheduled.
  const retryOrRethrowDenial = async (denial: unknown): Promise<void> => {
    try {
      await waitForRetry();
    } catch (waitError) {
      if ((waitError as NodeJS.ErrnoException).code === "file_lock_timeout") throw denial;
      throw waitError;
    }
  };

  try {
    while (true) {
      if (!ownsReclaimGuard && (await sidecarReclaimGuardExists(reclaimGuardPath))) {
        await waitForRetry();
        continue;
      }
      let handle: SidecarFileHandle | null = null;
      let lockFileCreateDenied = false;
      try {
        const payload = await options.payload();
        const { raw, ownershipToken } = serializeSidecarLockPayload(payload);
        if (options.lockRoot) {
          const relativeLockPath = relativeSidecarLockPath(options.lockRoot, lockPath);
          try {
            await options.lockRoot.create(relativeLockPath, raw, { mkdir: true, mode: 0o600 });
          } catch (error) {
            if (error instanceof FsSafeError && error.code === "already-exists") {
              throw Object.assign(new Error("sidecar lock exists"), { code: "EEXIST" });
            }
            throw error;
          }
          handle = (await options.lockRoot.open(relativeLockPath)).handle;
        } else {
          try {
            handle =
              (await createNativeExclusiveFile(lockPath, 0o600)) ??
              (await fs.open(lockPath, "wx"));
          } catch (createError) {
            lockFileCreateDenied = isTransientLockFileDenial(createError, lockPath);
            throw createError;
          }
          await handle.writeFile(raw, "utf8");
        }
        const snapshot = { raw, payload, stat: await handle.stat(), ownershipToken };
        const createdHeld: HeldSidecarLock = {
          refCount: 1,
          reentrantOwner: options.reentrantOwner,
          handle,
          lockPath,
          snapshot,
          acquiredAt: Date.now(),
          metadata: options.metadata ?? {},
          lockRoot: options.lockRoot,
          parsePayload: options.parsePayload,
        };
        context.held.set(normalizedTargetPath, createdHeld);
        if (ownsReclaimGuard) {
          try {
            await releaseSidecarReclaimGuard(context.reclaimGuards, reclaimGuardPath);
            ownsReclaimGuard = false;
          } catch (err) {
            await context.releaseHeldLock(normalizedTargetPath, createdHeld, { force: true });
            throw err;
          }
        }
        const returnedHandle = context.handleForHeldLock(normalizedTargetPath, createdHeld);
        const interval = options.compromiseCheckIntervalMs;
        if (options.onCompromised && interval !== undefined && interval > 0) {
          createdHeld.compromiseTimer = setInterval(() => {
            void returnedHandle.verifyStillHeld().then((stillHeld) => {
              if (!stillHeld && createdHeld.compromiseTimer) {
                clearInterval(createdHeld.compromiseTimer);
                createdHeld.compromiseTimer = undefined;
                options.onCompromised?.({ lockPath, normalizedTargetPath });
              }
            });
          }, interval);
          createdHeld.compromiseTimer.unref();
        }
        return returnedHandle;
      } catch (err) {
        if (handle) {
          const failedSnapshot: SidecarLockSnapshot = { payload: null };
          try {
            failedSnapshot.stat = await handle.stat();
          } catch {
            // Best-effort cleanup of a failed exclusive create.
          }
          const current = context.held.get(normalizedTargetPath);
          if (current?.handle === handle) {
            context.held.delete(normalizedTargetPath);
          }
          // If payload serialization/write fails, the file may be empty or
          // partial JSON, so remove while our exclusive handle is still open.
          if (!options.lockRoot) {
            await fs.rm(lockPath, { force: true }).catch(() => undefined);
          }
          await handle.close().catch(() => undefined);
          // Windows can refuse removing an open file; retry after close but
          // only if the path still points at the file identity we created.
          await removeSidecarLockIfUnchanged(lockPath, failedSnapshot, {
            lockRoot: options.lockRoot,
            parsePayload: options.parsePayload,
          });
        }
        if (lockFileCreateDenied && withinDenialBudget()) {
          await retryOrRethrowDenial(err);
          continue;
        }
        if ((err as { code?: unknown }).code !== "EEXIST") {
          throw err;
        }
        if (ownsReclaimGuard) {
          await releaseSidecarReclaimGuard(context.reclaimGuards, reclaimGuardPath);
          ownsReclaimGuard = false;
          continue;
        }
        const nowMs = Date.now();
        let snapshot: SidecarLockSnapshot | null;
        try {
          snapshot = await readSidecarLockSnapshot(lockPath, {
            lockRoot: options.lockRoot,
            parsePayload: options.parsePayload,
            rejectNonFile: true,
          });
        } catch (readErr) {
          if (!isTransientLockFileDenial(readErr, lockPath) || !withinDenialBudget()) throw readErr;
          await retryOrRethrowDenial(readErr);
          continue;
        }
        if (!snapshot) {
          continue;
        }
        if (context.held.has(normalizedTargetPath)) {
          await waitForRetry();
          continue;
        }
        const shouldReclaim = options.shouldReclaim ?? defaultSidecarLockShouldReclaim;
        if (
          await shouldReclaim({
            lockPath,
            normalizedTargetPath,
            payload: snapshot?.payload ?? null,
            staleMs: options.staleMs,
            nowMs,
            heldByThisProcess: context.held.has(normalizedTargetPath),
          })
        ) {
          if (
            !(await sidecarLockSnapshotStillPresent(lockPath, snapshot, {
              lockRoot: options.lockRoot,
              parsePayload: options.parsePayload,
            }))
          ) {
            continue;
          }
          const staleRecovery = options.staleRecovery ?? "fail-closed";
          if (staleRecovery === "remove-if-unchanged") {
            if (!(await tryAcquireSidecarReclaimGuard(context.reclaimGuards, reclaimGuardPath))) {
              await waitForRetry();
              continue;
            }
            ownsReclaimGuard = true;
            const removal = await removeStaleSidecarLockIfAllowed({
              lockPath,
              normalizedTargetPath,
              snapshot,
              shouldRemoveStaleLock: options.shouldRemoveStaleLock,
              lockRoot: options.lockRoot,
              parsePayload: options.parsePayload,
            });
            if (removal === "removed" || removal === "changed") {
              continue;
            }
            await releaseSidecarReclaimGuard(context.reclaimGuards, reclaimGuardPath);
            ownsReclaimGuard = false;
          }
          throw Object.assign(new Error(`file lock stale for ${normalizedTargetPath}`), {
            code: "file_lock_stale",
            lockPath,
            normalizedTargetPath,
          });
        }
        await waitForRetry();
      }
    }
  } finally {
    if (ownsReclaimGuard) {
      await releaseSidecarReclaimGuard(context.reclaimGuards, reclaimGuardPath).catch(
        () => undefined,
      );
    }
  }
}
