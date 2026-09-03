import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { fileObservation } from "./file-observation.js";
import { readFileHandleBounded } from "./bounded-read.js";
import { openSidecarRoot } from "./sidecar-lock-root.js";
import { createNativeExclusiveFile, type NativeFileHandle } from "./native-operations.js";
import type { Root } from "./root-impl.js";
import {
  computeSidecarLockDelayMs,
  defaultSidecarLockShouldReclaim,
  isTransientLockFileDenial,
  maxTransientLockDenials,
  validateSidecarLockRetryOptions,
  validateSidecarLockTimeoutMs,
} from "./sidecar-lock-policy.js";
import {
  readSidecarLockRawSnapshot,
  parseSidecarLockSnapshot,
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
import { createSuppressedError } from "./suppressed-error.js";

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
  const retry = options.retry ?? {};
  validateSidecarLockRetryOptions(retry);
  validateSidecarLockTimeoutMs(options.timeoutMs);
  context.ensureExitCleanupRegistered();
  const normalizedTargetPath = await resolveNormalizedTargetPath(options.targetPath);
  const lockPath = options.lockPath ?? `${normalizedTargetPath}.lock`;
  let held = context.held.get(normalizedTargetPath);
  if (
    held &&
    options.reentrantOwner !== undefined &&
    held.reentrantOwner !== undefined &&
    options.reentrantOwner === held.reentrantOwner
  ) {
    // A final release may already have decremented the count to zero and be
    // removing the sidecar. Do not admit a new reentrant handle until that
    // cleanup settles: successful cleanup requires a fresh acquisition, while
    // failed cleanup leaves the existing sidecar held for a retry.
    if (held.releasePromise) {
      await held.releasePromise.catch(() => undefined);
      held = context.held.get(normalizedTargetPath);
    }
    if (
      held &&
      options.reentrantOwner !== undefined &&
      held.reentrantOwner !== undefined &&
      options.reentrantOwner === held.reentrantOwner
    ) {
      held.refCount += 1;
      return context.handleForHeldLock(normalizedTargetPath, held);
    }
  }

  const startedAt = Date.now();
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
      (retry.retries !== undefined && attempt >= retry.retries)
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
      let createdSnapshot: SidecarLockSnapshot | null = null;
      let lockFileCreateDenied = false;
      const payload = await options.payload();
      const { raw, ownershipToken } = serializeSidecarLockPayload(payload);
      try {
        if (options.lockRoot) {
          const lockRoot = options.lockRoot;
          const relativeLockPath = relativeSidecarLockPath(lockRoot, lockPath);
          const observation = fileObservation();
          try {
            await observation.run(() => lockRoot.create(relativeLockPath, raw, { mkdir: true, mode: 0o600 }));
          } catch (error) {
            // Only this invocation's failed exclusive open grants denial retry authority.
            lockFileCreateDenied = observation.has(error, `exclusive-create:${lockPath}`) &&
              isTransientLockFileDenial(error, lockPath);
            if (error instanceof FsSafeError && error.code === "already-exists") {
              throw Object.assign(new Error("sidecar lock exists"), { code: "EEXIST" });
            }
            throw error;
          }
          createdSnapshot = { raw, payload, ownershipToken };
          const opened = await openSidecarRoot(lockRoot, relativeLockPath, "unlinked");
          if (!opened) {
            await waitForRetry();
            continue;
          }
          try {
            // Root.open admits the current file, not necessarily the one we created.
            const currentRaw = await readFileHandleBounded(opened.handle, Buffer.byteLength(raw));
            if (!currentRaw.equals(Buffer.from(raw))) {
              throw new FsSafeError("path-mismatch", "created sidecar lock changed before admission");
            }
          } catch (error) {
            await opened.handle.close().catch(() => undefined);
            throw error;
          }
          handle = opened.handle;
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
        if (snapshot.stat.nlink === 0) {
          await handle.close();
          handle = null;
          await waitForRetry();
          continue;
        }
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
            void returnedHandle
              .verifyStillHeld()
              .catch(() => false)
              .then((stillHeld) => {
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
        try {
          if (handle) {
            const failedSnapshot: SidecarLockSnapshot = createdSnapshot ?? { payload: null };
            try {
              failedSnapshot.stat = await handle.stat();
            } catch {
              // Best-effort cleanup of a failed exclusive create.
            }
            const current = context.held.get(normalizedTargetPath);
            if (current?.handle === handle) {
              context.held.delete(normalizedTargetPath);
            }
            await handle.close().catch(() => undefined);
            // Root-created records retain the creator's byte/token receipt;
            // partial direct writes use the exclusive descriptor's identity.
            await removeSidecarLockIfUnchanged(lockPath, failedSnapshot, {
              lockRoot: options.lockRoot,
              parsePayload: options.parsePayload,
            });
          } else if (createdSnapshot) {
            await removeSidecarLockIfUnchanged(lockPath, createdSnapshot, {
              lockRoot: options.lockRoot,
              parsePayload: options.parsePayload,
            });
          }
        } catch (cleanupError) {
          throw createSuppressedError(
            cleanupError,
            err,
            "file lock acquisition and cleanup both failed",
          );
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
          await waitForRetry();
          continue;
        }
        const nowMs = Date.now();
        let rawSnapshot: Awaited<ReturnType<typeof readSidecarLockRawSnapshot>>;
        let lockFileOpenDenied = false;
        try {
          rawSnapshot = await readSidecarLockRawSnapshot(lockPath, {
            lockRoot: options.lockRoot,
            rejectNonFile: true,
            discardObservation: "changed",
            onOpenFailure: (error) => { lockFileOpenDenied = isTransientLockFileDenial(error, lockPath); },
          });
        } catch (readErr) {
          if (!lockFileOpenDenied || !withinDenialBudget()) throw readErr;
          await retryOrRethrowDenial(readErr);
          continue;
        }
        const snapshot = parseSidecarLockSnapshot(rawSnapshot, options.parsePayload);
        if (!snapshot) {
          await waitForRetry();
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
            await waitForRetry();
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
              if (removal === "changed") await waitForRetry();
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
