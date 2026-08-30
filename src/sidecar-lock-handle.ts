import type { Root } from "./root-impl.js";
import {
  sidecarLockSnapshotStillPresent,
  type SidecarLockSnapshot,
} from "./sidecar-lock-reclaim.js";
import type { SidecarLockHandle } from "./sidecar-lock-types.js";

export function createSidecarLockHandle(params: {
  lockPath: string;
  normalizedTargetPath: string;
  verifyStillHeld: () => Promise<boolean>;
  release: (options?: { retry?: boolean }) => Promise<unknown>;
}): SidecarLockHandle {
  let released = false;
  let releasePromise: Promise<void> | undefined;
  let releaseStarted = false;
  const release = async (): Promise<void> => {
    if (released) return;
    if (!releasePromise) {
      const retry = releaseStarted;
      releaseStarted = true;
      releasePromise = (async () => {
        await params.release({ retry });
        released = true;
      })();
    }
    try {
      await releasePromise;
    } finally {
      releasePromise = undefined;
    }
  };
  return {
    lockPath: params.lockPath,
    normalizedTargetPath: params.normalizedTargetPath,
    verifyStillHeld: params.verifyStillHeld,
    release,
    [Symbol.asyncDispose]: release,
  };
}

export function createHeldSidecarLockHandle(params: {
  normalizedTargetPath: string;
  held: {
    lockPath: string;
    snapshot: SidecarLockSnapshot;
    lockRoot?: Root;
    parsePayload?: (raw: string) => unknown;
  };
  release: (options?: { retry?: boolean }) => Promise<unknown>;
}): SidecarLockHandle {
  return createSidecarLockHandle({
    lockPath: params.held.lockPath,
    normalizedTargetPath: params.normalizedTargetPath,
    verifyStillHeld: async () =>
      await sidecarLockSnapshotStillPresent(params.held.lockPath, params.held.snapshot, {
        lockRoot: params.held.lockRoot,
        parsePayload: params.held.parsePayload,
      }),
    release: (options) => params.release(options),
  });
}
