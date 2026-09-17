import { defaultSidecarLockShouldReclaim, isTransientLockFileDenial } from "./sidecar-lock-policy.js";
import {
  readSidecarLockRawSnapshot,
  releaseSidecarReclaimGuard,
  removeStaleSidecarLockIfAllowed,
  sidecarLockSnapshotStillPresent,
  tryAcquireSidecarReclaimGuard,
} from "./sidecar-lock-reclaim.js";
import {
  observeSidecarLockParser,
  parseSidecarLockSnapshotUnderAdmission,
  scopedSidecarLockParser,
  type SidecarLockParserState,
} from "./sidecar-lock-admission-parser.js";
import type { Root } from "./root-impl.js";
import type { SidecarLockAcquireOptions } from "./sidecar-lock-types.js";

type SidecarAdmissionRunner = {
  hasToken(): boolean;
  run<T>(callback: () => T): T;
};

type StaleOptions = Pick<
  SidecarLockAcquireOptions<Record<string, unknown>>,
  "shouldReclaim" | "shouldRemoveStaleLock" | "staleRecovery"
>;

export type SidecarLockStaleOptionsState = {
  shouldReclaimObserved?: boolean;
  shouldReclaim?: StaleOptions["shouldReclaim"];
  shouldRemoveObserved?: boolean;
  shouldRemove?: StaleOptions["shouldRemoveStaleLock"];
  staleRecoveryObserved?: boolean;
  staleRecovery?: StaleOptions["staleRecovery"];
};

/** Handle one historical EEXIST attempt while its canonical admission is held. */
export async function handleStaleSidecarAdmission<TPayload extends Record<string, unknown>>(
  params: {
    admission: SidecarAdmissionRunner;
    assertToken(): void;
    currentHeld(): unknown;
    lockPath: string;
    lockRoot?: Root;
    normalizedTargetPath: string;
    options: SidecarLockAcquireOptions<TPayload>;
    parserState: SidecarLockParserState;
    reclaimGuardPath: string;
    reclaimGuards: Set<string>;
    setOwnsReclaimGuard(owns: boolean): void;
    staleOptionsState: SidecarLockStaleOptionsState;
    staleMs: number;
    withinDenialBudget(): boolean;
    retryOrRethrowDenial(error: unknown): Promise<void>;
    waitForRetry(): Promise<void>;
  },
): Promise<void> {
  const { admission, lockPath, normalizedTargetPath, options } = params;
  const holderChanged = {};
  const assertUnheld = () => {
    params.assertToken();
    if (params.currentHeld()) throw holderChanged;
  };
  const retryHolderChange = async (error: unknown): Promise<boolean> => {
    if (error !== holderChanged) return false;
    await params.waitForRetry();
    return true;
  };
  const retryChangedBoundary = async (): Promise<boolean> => {
    try {
      assertUnheld();
      return false;
    } catch (error) {
      if (await retryHolderChange(error)) return true;
      throw error;
    }
  };
  const nowMs = Date.now();
  let rawSnapshot: Awaited<ReturnType<typeof readSidecarLockRawSnapshot>>;
  let lockFileOpenDenied = false;
  try {
    rawSnapshot = await admission.run(async () => await readSidecarLockRawSnapshot(lockPath, {
      lockRoot: params.lockRoot,
      rejectNonFile: true,
      discardObservation: "changed",
      onOpenFailure: (error) => {
        lockFileOpenDenied = isTransientLockFileDenial(error, lockPath);
      },
    }));
  } catch (error) {
    if (await retryChangedBoundary()) return;
    if (!lockFileOpenDenied || !params.withinDenialBudget()) throw error;
    await params.retryOrRethrowDenial(error);
    return;
  }
  params.assertToken();
  if (params.currentHeld()) { await params.waitForRetry(); return; }
  let snapshot: ReturnType<typeof parseSidecarLockSnapshotUnderAdmission>;
  try {
    observeSidecarLockParser(
      params.parserState,
      admission,
      () => options.parsePayload,
      assertUnheld,
    );
    snapshot = parseSidecarLockSnapshotUnderAdmission(
      rawSnapshot,
      params.parserState,
      admission,
      assertUnheld,
    );
    assertUnheld();
  } catch (error) {
    if (await retryHolderChange(error)) return;
    if (await retryChangedBoundary()) return;
    throw error;
  }
  if (!snapshot) {
    await params.waitForRetry();
    return;
  }
  const staleOptions = params.staleOptionsState;
  try {
    if (!staleOptions.shouldReclaimObserved) {
      assertUnheld();
      staleOptions.shouldReclaim = admission.run(() => options.shouldReclaim);
      staleOptions.shouldReclaimObserved = true;
      assertUnheld();
    }
    if (!staleOptions.shouldRemoveObserved) {
      assertUnheld();
      staleOptions.shouldRemove = admission.run(() => options.shouldRemoveStaleLock);
      staleOptions.shouldRemoveObserved = true;
      assertUnheld();
    }
    if (!staleOptions.staleRecoveryObserved) {
      assertUnheld();
      staleOptions.staleRecovery = admission.run(() => options.staleRecovery);
      staleOptions.staleRecoveryObserved = true;
      assertUnheld();
    }
  } catch (error) {
    if (await retryHolderChange(error)) return;
    if (await retryChangedBoundary()) return;
    throw error;
  }
  const shouldReclaim = staleOptions.shouldReclaim ?? defaultSidecarLockShouldReclaim;
  let reclaim: boolean;
  try {
    reclaim = await admission.run(async () => {
      assertUnheld();
      try {
        return await Reflect.apply(shouldReclaim, undefined, [{
          lockPath,
          normalizedTargetPath,
          payload: snapshot.payload ?? null,
          staleMs: params.staleMs,
          nowMs,
          heldByThisProcess: false,
        }]);
      } finally {
        assertUnheld();
      }
    });
    assertUnheld();
  } catch (error) {
    if (await retryHolderChange(error)) return;
    if (await retryChangedBoundary()) return;
    throw error;
  }
  if (!reclaim) {
    await params.waitForRetry();
    return;
  }
  let stillPresent: boolean;
  try {
    stillPresent = await sidecarLockSnapshotStillPresent(lockPath, snapshot, {
      lockRoot: params.lockRoot,
      parsePayload: scopedSidecarLockParser(params.parserState, admission, assertUnheld),
    });
    assertUnheld();
  } catch (error) {
    if (await retryHolderChange(error)) return;
    if (await retryChangedBoundary()) return;
    throw error;
  }
  if (!stillPresent) {
    await params.waitForRetry();
    return;
  }
  if ((staleOptions.staleRecovery ?? "fail-closed") === "remove-if-unchanged") {
    const acquiredGuard = await tryAcquireSidecarReclaimGuard(
      params.reclaimGuards,
      params.reclaimGuardPath,
    );
    if (acquiredGuard) params.setOwnsReclaimGuard(true);
    params.assertToken();
    if (params.currentHeld()) {
      if (acquiredGuard) {
        await releaseSidecarReclaimGuard(params.reclaimGuards, params.reclaimGuardPath);
        params.setOwnsReclaimGuard(false);
      }
      await params.waitForRetry();
      return;
    }
    if (!acquiredGuard) {
      await params.waitForRetry();
      return;
    }
    const shouldRemove = staleOptions.shouldRemove;
    const assertRemovalAuthorized = assertUnheld;
    const guardedShouldRemove = shouldRemove && function (
      this: unknown,
      staleSnapshot: Parameters<NonNullable<typeof shouldRemove>>[0],
    ) {
      return admission.run(async () => {
        assertRemovalAuthorized();
        try {
          return await Reflect.apply(shouldRemove, this, [staleSnapshot]);
        } finally {
          assertRemovalAuthorized();
        }
      });
    };
    let removal: Awaited<ReturnType<typeof removeStaleSidecarLockIfAllowed>>;
    try {
      removal = await removeStaleSidecarLockIfAllowed({
        lockPath,
        normalizedTargetPath,
        snapshot,
        shouldRemoveStaleLock: guardedShouldRemove,
        lockRoot: params.lockRoot,
        parsePayload: scopedSidecarLockParser(
          params.parserState,
          admission,
          assertRemovalAuthorized,
        ),
        assertAuthorized: assertRemovalAuthorized,
      });
    } catch (error) {
      if (error !== holderChanged) {
        try {
          assertRemovalAuthorized();
        } catch (boundaryError) {
          if (boundaryError !== holderChanged) throw boundaryError;
        }
        if (!params.currentHeld()) throw error;
      }
      await releaseSidecarReclaimGuard(params.reclaimGuards, params.reclaimGuardPath);
      params.setOwnsReclaimGuard(false);
      await params.waitForRetry();
      return;
    }
    params.assertToken();
    if (params.currentHeld()) {
      await releaseSidecarReclaimGuard(params.reclaimGuards, params.reclaimGuardPath);
      params.setOwnsReclaimGuard(false);
      await params.waitForRetry();
      return;
    }
    if (removal === "removed") return;
    if (removal === "changed") {
      await params.waitForRetry();
      return;
    }
    await releaseSidecarReclaimGuard(params.reclaimGuards, params.reclaimGuardPath);
    params.setOwnsReclaimGuard(false);
  }
  throw Object.assign(new Error(`file lock stale for ${normalizedTargetPath}`), {
    code: "file_lock_stale",
    lockPath,
    normalizedTargetPath,
  });
}
