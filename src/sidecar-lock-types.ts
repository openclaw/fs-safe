import type { Root } from "./root-impl.js";
import type { SidecarLockStaleSnapshot } from "./sidecar-lock-reclaim.js";

export type SidecarLockRetryOptions = {
  retries?: number;
  factor?: number;
  minTimeout?: number;
  maxTimeout?: number;
  randomize?: boolean;
};

export type SidecarLockStaleRecovery = "fail-closed" | "remove-if-unchanged";

export type SidecarLockCompromisedInfo = {
  lockPath: string;
  normalizedTargetPath: string;
};

export type SidecarLockOptionFields<T> = { [K in keyof T]: T[K] };

export type SidecarLockCommonAcquireOptions = {
  lockPath?: string;
  timeoutMs?: number;
  retry?: SidecarLockRetryOptions;
  staleRecovery?: SidecarLockStaleRecovery;
  reentrantOwner?: string;
  parsePayload?: (raw: string) => unknown;
  lockRoot?: Root;
  onCompromised?: (info: SidecarLockCompromisedInfo) => void;
  compromiseCheckIntervalMs?: number;
};

export type SidecarLockReclaimParams<Held extends boolean = boolean> = {
  lockPath: string;
  normalizedTargetPath: string;
  payload: unknown;
  staleMs: number;
  nowMs: number;
  heldByThisProcess: Held;
};

export type SidecarLockAcquireOptions<TPayload extends Record<string, unknown>> =
  SidecarLockOptionFields<SidecarLockCommonAcquireOptions & {
    targetPath: string;
    staleMs: number;
    payload: () => TPayload | Promise<TPayload>;
    shouldReclaim?: (params: SidecarLockReclaimParams) => boolean | Promise<boolean>;
    shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean | Promise<boolean>;
    metadata?: Record<string, unknown>;
    /**
     * Keep the lock file when the process exits naturally. Default `false`:
     * process-exit handlers release held locks. Set only for deliberately
     * retained ownership records (for example, fail-closed build locks) whose
     * liveness is governed by the caller's own stale policy.
     */
    retainOnExit?: boolean;
  }>;

export type SidecarLockHandle = {
  lockPath: string;
  normalizedTargetPath: string;
  verifyStillHeld: () => Promise<boolean>;
  release: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type SidecarLockHeldEntry = {
  normalizedTargetPath: string;
  lockPath: string;
  acquiredAt: number;
  metadata: Record<string, unknown>;
  forceRelease: () => Promise<boolean>;
};

export type WithSidecarLockOptions<TPayload extends Record<string, unknown>> = Omit<
  SidecarLockAcquireOptions<TPayload>,
  "targetPath"
> & {
  managerKey?: string;
};
