import fsSync from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { fileObservation } from "./file-observation.js";
import { readFileHandleBounded } from "./bounded-read.js";
import { openSidecarRoot } from "./sidecar-lock-root.js";
import { createNativeExclusiveFile } from "./native-operations.js";
import {
  computeSidecarLockDelayMs,
  isTransientLockFileDenial,
  maxTransientLockDenials,
  validateSidecarLockStaleMs,
  validateSidecarLockRetryOptions,
  validateSidecarLockCompromiseCheckIntervalMs,
  validateSidecarLockTimeoutMs,
} from "./sidecar-lock-policy.js";
import {
  relativeSidecarLockPath,
  removeSidecarLockIfUnchanged,
  serializeSidecarLockPayload,
  sidecarReclaimGuardExists,
  type SidecarLockSnapshot,
  type SidecarReclaimGuard,
} from "./sidecar-lock-reclaim.js";
import {
  awaitSidecarAdmissionBoundary,
  conditionalSidecarLockParser,
  observeHeldSidecarParser,
  observeSidecarLockParser,
  runSidecarAdmissionBoundary,
  type SidecarLockParserState,
} from "./sidecar-lock-admission-parser.js";
import {
  handleStaleSidecarAdmission,
  type SidecarLockStaleOptionsState,
} from "./sidecar-lock-stale-admission.js";
import type { SidecarLockAcquireOptions, SidecarLockHandle } from "./sidecar-lock-types.js";
import {
  ancestryHasSidecarAdmission,
  captureSidecarAdmissionAncestry,
  createSidecarAdmissionController,
} from "./sidecar-lock-admission-context.js";
import { sidecarLockTimeout, type HeldSidecarLock, type SidecarLockAcquisitionContext } from "./sidecar-lock-admission.js";
import { resolveSidecarLockPaths } from "./sidecar-lock-target.js";
import { createSuppressedError } from "./suppressed-error.js";
import { sleep } from "./timing.js";
import { sidecarExclusiveCreate } from "./root-create-input.js";

export type { HeldSidecarLock } from "./sidecar-lock-admission.js";

export async function acquireSidecarLock<TPayload extends Record<string, unknown>>(
  options: SidecarLockAcquireOptions<TPayload>,
  context: SidecarLockAcquisitionContext,
): Promise<SidecarLockHandle> {
  const admissionAncestry = captureSidecarAdmissionAncestry();
  const retainOnExit = options.retainOnExit;
  context.assertRetainOnExitSupported(retainOnExit);
  const retry = options.retry ?? {};
  const timeoutMs = options.timeoutMs;
  const staleMs = options.staleMs;
  const compromiseCheckIntervalMs = options.compromiseCheckIntervalMs;
  validateSidecarLockRetryOptions(retry);
  validateSidecarLockTimeoutMs(timeoutMs);
  validateSidecarLockStaleMs(staleMs);
  validateSidecarLockCompromiseCheckIntervalMs(compromiseCheckIntervalMs);
  const targetPath = options.targetPath;
  const explicitLockPath = options.lockPath;
  const lockRoot = options.lockRoot;
  const requestedReentrantOwner = options.reentrantOwner;
  const { lockPath, normalizedTargetPath } = await resolveSidecarLockPaths(
    targetPath, explicitLockPath, lockRoot,
  );
  const activeDescendant = ancestryHasSidecarAdmission(admissionAncestry, context.admissions, normalizedTargetPath);
  let held = context.held.get(normalizedTargetPath);
  if (
    held &&
    requestedReentrantOwner !== undefined &&
    held.reentrantOwner !== undefined &&
    requestedReentrantOwner === held.reentrantOwner
  ) {
    // Join a final release before deciding whether this completed owner remains.
    // Successful cleanup requires a fresh acquisition; failed cleanup can retry.
    if (held.releasePromise) {
      if (activeDescendant) throw sidecarLockTimeout(lockPath, normalizedTargetPath);
      await held.releasePromise.catch(() => undefined);
      held = context.held.get(normalizedTargetPath);
    }
    if (
      held &&
      requestedReentrantOwner !== undefined &&
      held.reentrantOwner !== undefined &&
      requestedReentrantOwner === held.reentrantOwner
    ) {
      const lifecycle = context.ensureExitCleanupRegistered();
      context.assertRetainOnExitSupported(retainOnExit);
      if (context.held.get(normalizedTargetPath) === held && !held.releasePromise) {
        held.refCount = (held.refCount ?? 1) + 1;
        // Retention is monotonic: any same-owner request to keep the sidecar on
        // exit upgrades the held lock; a later default acquisition never revokes it.
        if (retainOnExit === true) {
          held.retainOnExit = true;
        }
        const returnedHandle = context.handleForHeldLock(normalizedTargetPath, held);
        context.armExitCleanup(lifecycle);
        return returnedHandle;
      }
    }
  }
  if (activeDescendant) throw sidecarLockTimeout(lockPath, normalizedTargetPath);

  const admission = createSidecarAdmissionController(admissionAncestry, context.admissions, normalizedTargetPath);
  const startedAt = Date.now();
  const reclaimGuardPath = `${lockPath}.reclaim`;
  let reclaimGuard: SidecarReclaimGuard | undefined;
  const releaseReclaimGuard = async (): Promise<void> => {
    if (!reclaimGuard) return;
    await admission.run(() => reclaimGuard!.release());
    reclaimGuard = undefined;
  };
  let attempt = 0;
  // Bounded so a genuine denial still surfaces as EPERM, not a lock timeout.
  let transientDenials = 0;
  let payloadCallback: typeof options.payload | undefined;
  let metadata: typeof options.metadata = undefined;
  let metadataObserved = false;
  let onCompromised: typeof options.onCompromised = undefined;
  let onCompromisedObserved = false;
  const staleOptionsState: SidecarLockStaleOptionsState = {};
  const withinDenialBudget = (): boolean => ++transientDenials <= maxTransientLockDenials;
  const waitForRetry = async (): Promise<void> => {
    admission.release();
    const elapsed = Date.now() - startedAt;
    if (
      (timeoutMs !== undefined &&
        timeoutMs !== Number.POSITIVE_INFINITY &&
        elapsed >= timeoutMs) ||
      (retry.retries !== undefined && attempt >= retry.retries)
    ) {
      throw sidecarLockTimeout(lockPath, normalizedTargetPath);
    }
    const remaining =
      timeoutMs === undefined || timeoutMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(0, timeoutMs - elapsed);
    const delay = Math.min(computeSidecarLockDelayMs(retry, attempt), remaining);
    attempt += 1;
    await sleep(delay);
  };
  // Preserve a denial diagnosis if contention backoff has no remaining budget.
  const retryOrRethrowDenial = async (denial: unknown): Promise<void> => {
    try {
      await waitForRetry();
    } catch (waitError) {
      if ((waitError as NodeJS.ErrnoException).code === "file_lock_timeout") throw denial;
      throw waitError;
    }
  };
  const assertAdmissionToken = (): void => {
    if (!admission.hasToken()) throw sidecarLockTimeout(lockPath, normalizedTargetPath);
  };

  try {
    while (true) {
      if (!admission.owns) {
        held = context.held.get(normalizedTargetPath);
        if (
          held &&
          requestedReentrantOwner !== undefined &&
          held.reentrantOwner !== undefined &&
          requestedReentrantOwner === held.reentrantOwner
        ) {
          if (held.releasePromise) {
            await held.releasePromise.catch(() => undefined);
            held = context.held.get(normalizedTargetPath);
          }
          if (
            held &&
            requestedReentrantOwner !== undefined &&
            held.reentrantOwner !== undefined &&
            requestedReentrantOwner === held.reentrantOwner
          ) {
            const lifecycle = context.ensureExitCleanupRegistered();
            context.assertRetainOnExitSupported(retainOnExit);
            if (context.held.get(normalizedTargetPath) !== held || held.releasePromise) {
              continue;
            }
            held.refCount = (held.refCount ?? 1) + 1;
            if (retainOnExit === true) held.retainOnExit = true;
            const returnedHandle = context.handleForHeldLock(normalizedTargetPath, held);
            context.armExitCleanup(lifecycle);
            return returnedHandle;
          }
        }
        if (context.admissions.has(normalizedTargetPath)) {
          await waitForRetry();
          continue;
        }
        admission.reserve();
      }
      const attemptHeld = context.held.get(normalizedTargetPath);
      const holderWasReplaced = (): boolean => {
        const current = context.held.get(normalizedTargetPath);
        return current !== undefined && current !== attemptHeld;
      };
      const lifecycle = admission.run(() => context.ensureExitCleanupRegistered());
      assertAdmissionToken();
      if (holderWasReplaced()) { await waitForRetry(); continue; }
      admission.run(() => context.assertRetainOnExitSupported(retainOnExit));
      assertAdmissionToken();
      if (holderWasReplaced()) { await waitForRetry(); continue; }
      if (reclaimGuard?.assertHeld) await admission.run(() => reclaimGuard!.assertHeld!());
      const reclaimGuardExists = !reclaimGuard && (await (lockRoot
        ? admission.run(() => sidecarReclaimGuardExists(reclaimGuardPath, lockRoot))
        : sidecarReclaimGuardExists(reclaimGuardPath)));
      assertAdmissionToken();
      if (holderWasReplaced()) { await waitForRetry(); continue; }
      if (reclaimGuardExists) {
        await waitForRetry();
        continue;
      }
      let handle: HeldSidecarLock["handle"] | null = null;
      let createdSnapshot: SidecarLockSnapshot | null = null, createdHeld: HeldSidecarLock | undefined;
      let admissionConflict = false;
      let exclusiveCreateConflict = false;
      let lockFileCreateDenied = false;
      const parserState: SidecarLockParserState = { observed: false };
      if (!payloadCallback) payloadCallback = runSidecarAdmissionBoundary(
        admission, assertAdmissionToken, () => options.payload);
      if (holderWasReplaced()) { await waitForRetry(); continue; }
      const { value: payload } = await awaitSidecarAdmissionBoundary(
        admission, assertAdmissionToken, () => Reflect.apply(payloadCallback!, options, []));
      if (holderWasReplaced()) { await waitForRetry(); continue; }
      const { raw, ownershipToken } = runSidecarAdmissionBoundary(
        admission, assertAdmissionToken, () => serializeSidecarLockPayload(payload));
      if (holderWasReplaced()) { await waitForRetry(); continue; }
      held = context.held.get(normalizedTargetPath);
      if (held?.releasePromise) {
        // Release cleanup never acquires this admission; retaining it here lets
        // the serialized attempt continue without another callback or retry.
        await held.releasePromise.catch(() => undefined);
        assertAdmissionToken();
        held = context.held.get(normalizedTargetPath);
      }
      if (held?.lockPath === lockPath) {
        const observedHeld = held;
        const observation = await observeHeldSidecarParser({
          admission, assertToken: assertAdmissionToken,
          currentHeld: () => context.held.get(normalizedTargetPath), held: observedHeld,
          lockPath, lockRoot, parserState,
          parserAccessor: () => options.parsePayload,
          isTransientDenial: (error) => isTransientLockFileDenial(error, lockPath),
        });
        assertAdmissionToken();
        held = context.held.get(normalizedTargetPath);
        if (held !== observedHeld || observedHeld.releasePromise) {
          await waitForRetry();
          continue;
        }
        if (observation.kind === "read-error") {
          if (!observation.transientDenial || !withinDenialBudget()) throw observation.error;
          await retryOrRethrowDenial(observation.error);
          continue;
        }
      }
      if (held) { await waitForRetry(); continue; }
      if (!metadataObserved) {
        metadata = runSidecarAdmissionBoundary(
          admission, assertAdmissionToken, () => options.metadata);
        metadataObserved = true;
        if (context.held.has(normalizedTargetPath)) { await waitForRetry(); continue; }
      }
      if (!onCompromisedObserved) {
        onCompromised = runSidecarAdmissionBoundary(
          admission, assertAdmissionToken, () => options.onCompromised);
        onCompromisedObserved = true;
        if (context.held.has(normalizedTargetPath)) { await waitForRetry(); continue; }
      }
      assertAdmissionToken();
      if (context.held.has(normalizedTargetPath)) {
        await waitForRetry();
        continue;
      }
      try {
        if (lockRoot) {
          const relativeLockPath = relativeSidecarLockPath(lockRoot, lockPath);
          const observation = fileObservation();
          try {
            await observation.run(() => lockRoot.create(relativeLockPath, raw, { ...sidecarExclusiveCreate, mkdir: true, mode: 0o600 }));
          } catch (error) {
            // Only this invocation's failed exclusive open grants denial retry authority.
            lockFileCreateDenied = observation.has(error, `exclusive-create:${lockPath}`) &&
              isTransientLockFileDenial(error, lockPath);
            if (error instanceof FsSafeError && error.code === "already-exists") {
              exclusiveCreateConflict = true;
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
              (await fs.open(lockPath, "wx", 0o600));
          } catch (createError) {
            lockFileCreateDenied = isTransientLockFileDenial(createError, lockPath);
            exclusiveCreateConflict = (createError as NodeJS.ErrnoException).code === "EEXIST";
            throw createError;
          }
          await handle.writeFile(raw, "utf8");
        }
        const snapshot = { raw, payload, stat: fsSync.fstatSync(handle.fd), ownershipToken };
        createdSnapshot = snapshot;
        if (snapshot.stat.nlink === 0) {
          await handle.close();
          handle = null;
          await waitForRetry();
          continue;
        }
        observeSidecarLockParser(
          parserState,
          admission,
          () => options.parsePayload,
          assertAdmissionToken,
        );
        if (context.held.has(normalizedTargetPath)) {
          admissionConflict = true;
          throw Object.assign(new Error("sidecar lock admission changed"), { code: "EEXIST" });
        }
        createdHeld = {
          refCount: 1,
          reentrantOwner: requestedReentrantOwner,
          handle,
          lockPath,
          snapshot,
          acquiredAt: Date.now(),
          metadata: metadata ?? {},
          lockRoot,
          retainOnExit,
          parsePayload: parserState.parser,
        };
        const candidateHeld = createdHeld;
        if (reclaimGuard) await releaseReclaimGuard();
        const returnedHandle = admission.run(() =>
          context.handleForHeldLock(normalizedTargetPath, candidateHeld));
        if (
          onCompromised &&
          compromiseCheckIntervalMs !== undefined &&
          compromiseCheckIntervalMs > 0
        ) {
          const compromisedCallback = onCompromised;
          let compromiseCheckInFlight = false;
          candidateHeld.compromiseTimer = admission.run(() => setInterval(() => {
            if (compromiseCheckInFlight) return;
            compromiseCheckInFlight = true;
            void returnedHandle
              .verifyStillHeld()
              .catch(() => false)
              .then((stillHeld) => {
                if (!stillHeld && candidateHeld.compromiseTimer) {
                  clearInterval(candidateHeld.compromiseTimer);
                  candidateHeld.compromiseTimer = undefined;
                  Reflect.apply(compromisedCallback, options, [{ lockPath, normalizedTargetPath }]);
                }
              })
              .finally(() => {
                compromiseCheckInFlight = false;
              });
          }, compromiseCheckIntervalMs));
          admission.run(() => candidateHeld.compromiseTimer?.unref());
        }
        if (
          !admission.hasToken() ||
          context.held.has(normalizedTargetPath)
        ) {
          admissionConflict = true;
          throw Object.assign(new Error("sidecar lock admission changed"), { code: "EEXIST" });
        }
        context.held.set(normalizedTargetPath, candidateHeld);
        admission.release();
        context.armExitCleanup(lifecycle);
        return returnedHandle;
      } catch (err) {
        try {
          if (createdHeld?.compromiseTimer) {
            clearInterval(createdHeld.compromiseTimer);
            createdHeld.compromiseTimer = undefined;
          }
          if (handle) {
            const failedSnapshot: SidecarLockSnapshot = createdSnapshot ?? { payload: null };
            try {
              failedSnapshot.stat = fsSync.fstatSync(handle.fd);
            } catch {
              // Best-effort cleanup of a failed exclusive create.
            }
            const current = context.held.get(normalizedTargetPath);
            if (createdHeld && current === createdHeld) {
              context.held.delete(normalizedTargetPath);
            }
            await handle.close().catch(() => undefined);
            // Root records use the creator receipt; partial raw writes use fd identity.
            await removeSidecarLockIfUnchanged(lockPath, failedSnapshot, {
              lockRoot,
              parsePayload: conditionalSidecarLockParser(
                parserState,
                admission,
                () => admission.hasToken() && !context.held.has(normalizedTargetPath),
              ),
            });
          } else if (createdSnapshot) {
            await removeSidecarLockIfUnchanged(lockPath, createdSnapshot, {
              lockRoot,
              parsePayload: conditionalSidecarLockParser(
                parserState,
                admission,
                () => admission.hasToken() && !context.held.has(normalizedTargetPath),
              ),
            });
          }
        } catch (cleanupError) {
          throw createSuppressedError(
            cleanupError,
            err,
            "file lock acquisition and cleanup both failed",
          );
        }
        if (admissionConflict) {
          await waitForRetry();
          continue;
        }
        if (lockFileCreateDenied) {
          assertAdmissionToken();
          if (context.held.has(normalizedTargetPath)) {
            await waitForRetry();
            continue;
          }
          if (withinDenialBudget()) {
            await retryOrRethrowDenial(err);
            continue;
          }
          throw err;
        }
        if (!exclusiveCreateConflict) throw err;
        assertAdmissionToken();
        if (context.held.has(normalizedTargetPath)) {
          await waitForRetry();
          continue;
        }
        if (reclaimGuard) {
          await releaseReclaimGuard();
          await waitForRetry();
          continue;
        }
        await handleStaleSidecarAdmission({
          admission,
          assertToken: assertAdmissionToken,
          currentHeld: () => context.held.get(normalizedTargetPath),
          lockPath,
          lockRoot,
          normalizedTargetPath,
          options,
          parserState,
          reclaimGuardPath,
          reclaimGuards: context.reclaimGuards,
          setReclaimGuard: (guard) => { reclaimGuard = guard; },
          releaseReclaimGuard,
          staleOptionsState,
          staleMs,
          withinDenialBudget,
          retryOrRethrowDenial,
          waitForRetry,
        });
        continue;
      }
    }
  } finally {
    if (reclaimGuard) await releaseReclaimGuard().catch(() => undefined);
    admission.release();
  }
}
