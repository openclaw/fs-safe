import type { FileLockSyncAcquireOptions } from "./file-lock-sync.js";
import { getFsSafeLockConfig } from "./lock-config.js";
import { validateSidecarLockCompromiseCheckIntervalMs, validateSidecarLockRetryOptions,
  validateSidecarLockStaleMs, validateSidecarLockTimeoutMs } from "./sidecar-lock-policy.js";
import type { SidecarLockCompromisedInfo, SidecarLockRetryOptions,
  SidecarLockStaleRecovery } from "./sidecar-lock-types.js";

type CapturedRootSyncAcquireOptions<TPayload extends Record<string, unknown>> = Readonly<{
  compromiseCheckIntervalMs?: number;
  lockPath?: string;
  onCompromised?: (info: SidecarLockCompromisedInfo) => void;
  optionsReceiver: FileLockSyncAcquireOptions<TPayload>;
  parsePayload?: (raw: string) => unknown;
  payload: () => TPayload;
  reentrantOwner?: string;
  retry: Readonly<SidecarLockRetryOptions>;
  shouldReclaim?: FileLockSyncAcquireOptions<TPayload>["shouldReclaim"];
  shouldRemoveStaleLock?: FileLockSyncAcquireOptions<TPayload>["shouldRemoveStaleLock"];
  staleMs: number;
  staleRecovery?: SidecarLockStaleRecovery;
  timeoutMs?: number;
}>;

export function captureRootSyncAcquireOptions<TPayload extends Record<string, unknown>>(
  options: FileLockSyncAcquireOptions<TPayload>,
): CapturedRootSyncAcquireOptions<TPayload> {
  // Root authority is already validated and snapshotted before entering this
  // helper. Snapshot every remaining caller-owned property before validating
  // options; nested retry accessors must not be revisited by backoff or a
  // callback that mutates the original options object.
  const lockPath = options.lockPath;
  const staleMsInput = options.staleMs;
  const timeoutMsInput = options.timeoutMs;
  const retryInput = options.retry;
  const staleRecoveryInput = options.staleRecovery;
  const reentrantOwner = options.reentrantOwner;
  const payload = options.payload;
  const shouldReclaim = options.shouldReclaim;
  const shouldRemoveStaleLock = options.shouldRemoveStaleLock;
  const parsePayload = options.parsePayload;
  const onCompromised = options.onCompromised;
  const compromiseCheckIntervalMs = options.compromiseCheckIntervalMs;
  const retrySnapshot = retryInput === undefined ? undefined : Object.freeze({
    retries: retryInput.retries,
    factor: retryInput.factor,
    minTimeout: retryInput.minTimeout,
    maxTimeout: retryInput.maxTimeout,
    randomize: retryInput.randomize,
  });
  const defaults = getFsSafeLockConfig();
  const defaultRetry = defaults.retry;
  const retry = retrySnapshot ?? Object.freeze({
    retries: defaultRetry?.retries,
    factor: defaultRetry?.factor,
    minTimeout: defaultRetry?.minTimeout,
    maxTimeout: defaultRetry?.maxTimeout,
    randomize: defaultRetry?.randomize,
  });
  const timeoutMs = timeoutMsInput ?? defaults.timeoutMs;
  const staleMs = staleMsInput ?? defaults.staleMs ?? 30_000;
  const staleRecovery = staleRecoveryInput ?? defaults.staleRecovery;
  validateSidecarLockRetryOptions(retry);
  validateSidecarLockTimeoutMs(timeoutMs);
  validateSidecarLockStaleMs(staleMs);
  validateSidecarLockCompromiseCheckIntervalMs(compromiseCheckIntervalMs);
  return Object.freeze({
    compromiseCheckIntervalMs,
    lockPath,
    onCompromised,
    optionsReceiver: options,
    parsePayload,
    payload,
    reentrantOwner,
    retry,
    shouldReclaim,
    shouldRemoveStaleLock,
    staleMs,
    staleRecovery,
    timeoutMs,
  });
}
