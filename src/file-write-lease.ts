import { FsSafeError } from "./errors.js";
import { requireNativeBinding } from "./native.js";

export type FileWriteLease = {
  readonly fd: number;
  /** False after release or when the kernel breaks or downgrades the lease. */
  isHeld(): boolean;
  release(): void;
  [Symbol.dispose](): void;
};

/** Linux kernel write lease. The caller retains the open fd and SIGIO handling. */
export function tryAcquireWriteLease(fd: number): FileWriteLease | null {
  if (process.platform !== "linux") {
    throw new FsSafeError("unsupported-platform", "File write leases require Linux");
  }
  if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) {
    throw new FsSafeError("invalid-path", "Expected an open file descriptor");
  }
  const native = requireNativeBinding();
  const acquire = native.tryAcquireWriteLease?.bind(native);
  const held = native.isFileWriteLeaseHeld?.bind(native);
  const unlock = native.releaseFileWriteLease?.bind(native);
  if (!acquire || !held || !unlock) {
    throw new FsSafeError("helper-unavailable", "Native file write leases are unavailable");
  }
  const call = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (cause) {
      throw new FsSafeError("helper-failed", "Native file write lease operation failed", { cause });
    }
  };
  if (!call(() => acquire(fd))) return null;
  let released = false;
  const release = () => {
    if (released) return;
    // Never retry an ambiguous settlement against a potentially recycled fd.
    released = true;
    call(() => unlock(fd));
  };
  return Object.freeze({
    fd,
    isHeld: () => !released && call(() => held(fd)),
    release,
    [Symbol.dispose]: release,
  });
}
