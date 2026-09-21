import type { NativeFileHandle } from "./native-operations.js";
import type { Root } from "./root-impl.js";
import type { SidecarLockSnapshot } from "./sidecar-lock-reclaim.js";
import type { SidecarLockHandle } from "./sidecar-lock-types.js";

export type HeldSidecarLock = {
  refCount: number;
  reentrantOwner?: string;
  handle: NativeFileHandle;
  lockPath: string;
  snapshot: SidecarLockSnapshot;
  acquiredAt: number;
  metadata: Record<string, unknown>;
  releasePromise?: Promise<void>;
  lockRoot?: Root;
  retainOnExit?: boolean;
  parsePayload?: (raw: string) => unknown;
  compromiseTimer?: NodeJS.Timeout;
};

export type SidecarLockAcquisitionContext = {
  held: Map<string, HeldSidecarLock>;
  admissions: Map<string, object>;
  reclaimGuards: Set<string>;
  ensureExitCleanupRegistered(): { armed: boolean };
  armExitCleanup(lifecycle: { armed: boolean }): void;
  assertRetainOnExitSupported(retainOnExit: boolean | undefined): void;
  handleForHeldLock(normalizedTargetPath: string, held: HeldSidecarLock): SidecarLockHandle;
};
