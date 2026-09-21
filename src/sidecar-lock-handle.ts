import type { SidecarLockHandle } from "./sidecar-lock-types.js";

export function stopSidecarLockMonitoring(held: { compromiseTimer?: NodeJS.Timeout }): void {
  const timer = held.compromiseTimer;
  held.compromiseTimer = undefined;
  if (timer) clearInterval(timer);
}

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
