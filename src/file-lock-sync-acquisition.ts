import type { FileLockSyncHandle } from "./file-lock-sync.js";
import { getSyncLockAdmissions } from "./file-lock-sync-admission.js";
import {
  isTransientLockFileDenial,
  maxTransientLockDenials,
  sidecarLockRetryDelay,
  sidecarLockTimeout,
} from "./sidecar-lock-policy.js";
import type { SidecarLockCompromisedInfo, SidecarLockRetryOptions } from "./sidecar-lock-types.js";
import { sleepSync } from "./timing.js";

/** Owns local arbitration and retry state, independently of filesystem authority. */
export class SyncLockAcquisition {
  readonly #admissions = getSyncLockAdmissions();
  readonly #token = {};
  #owns = false;
  readonly #startedAt = performance.now();
  #attempt = 0;
  #transientDenials = 0;

  constructor(
    readonly lockPath: string,
    readonly normalizedTargetPath: string,
    private readonly retry: SidecarLockRetryOptions,
    private readonly timeoutMs: number | undefined,
  ) {}

  get owns(): boolean { return this.#owns; }
  hasToken(): boolean { return this.#admissions.get(this.normalizedTargetPath) === this.#token; }
  assert(): void {
    if (!this.hasToken()) throw sidecarLockTimeout(this.lockPath, this.normalizedTargetPath);
  }
  reserve(): void {
    if (this.#owns) return;
    // An existing synchronous owner can finish only after this stack unwinds.
    if (this.#admissions.has(this.normalizedTargetPath)) {
      throw sidecarLockTimeout(this.lockPath, this.normalizedTargetPath);
    }
    this.#admissions.set(this.normalizedTargetPath, this.#token);
    this.#owns = true;
  }
  release(): void {
    if (this.#owns && this.hasToken()) this.#admissions.delete(this.normalizedTargetPath);
    this.#owns = false;
  }
  run<T>(callback: () => T): T {
    this.assert();
    try { return callback(); }
    finally { this.assert(); }
  }
  waitForRetry(): void {
    this.release();
    const delay = sidecarLockRetryDelay(this.retry, this.timeoutMs, performance.now() - this.#startedAt, this.#attempt);
    if (delay === undefined) throw sidecarLockTimeout(this.lockPath, this.normalizedTargetPath);
    sleepSync(delay);
    this.#attempt += 1;
  }
  retryDenial(error: unknown): boolean {
    if (!isTransientLockFileDenial(error, this.lockPath) ||
      ++this.#transientDenials > maxTransientLockDenials) return false;
    try {
      this.waitForRetry();
    } catch (waitError) {
      // Exhausted backoff must preserve the filesystem denial diagnosis.
      if ((waitError as NodeJS.ErrnoException).code === "file_lock_timeout") throw error;
      throw waitError;
    }
    return true;
  }

  monitor(
    held: { timer?: NodeJS.Timeout },
    handle: FileLockSyncHandle,
    callback: ((info: SidecarLockCompromisedInfo) => void) | undefined,
    interval: number | undefined,
    receiver: object,
    recordTimer?: (timer: NodeJS.Timeout) => void,
  ): void {
    if (!callback || (interval ?? 0) <= 0) return;
    const { lockPath, normalizedTargetPath } = this;
    const timer = setInterval(() => {
      let stillHeld: boolean;
      try { stillHeld = handle.verifyStillHeld(); }
      catch { stillHeld = false; }
      if (!stillHeld && held.timer) {
        clearInterval(held.timer);
        held.timer = undefined;
        Reflect.apply(callback, receiver, [{ lockPath, normalizedTargetPath }]);
      }
    }, interval);
    // Root cleanup retains a separate provisional receipt before unref can fail.
    recordTimer?.(timer);
    held.timer = timer;
    timer.unref();
  }
}
