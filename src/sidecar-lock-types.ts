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

export type SidecarLockAcquireOptions<TPayload extends Record<string, unknown>> = {
  targetPath: string;
  lockPath?: string;
  staleMs: number;
  timeoutMs?: number;
  retry?: SidecarLockRetryOptions;
  staleRecovery?: SidecarLockStaleRecovery;
  payload: () => TPayload | Promise<TPayload>;
  shouldReclaim?: (params: {
    lockPath: string;
    normalizedTargetPath: string;
    payload: unknown;
    staleMs: number;
    nowMs: number;
    heldByThisProcess: boolean;
  }) => boolean | Promise<boolean>;
  shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean | Promise<boolean>;
  metadata?: Record<string, unknown>;
  parsePayload?: (raw: string) => unknown;
  lockRoot?: Root;
  onCompromised?: (info: SidecarLockCompromisedInfo) => void;
  compromiseCheckIntervalMs?: number;
};

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
