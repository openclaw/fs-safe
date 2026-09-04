import type { BigIntStats, Stats } from "node:fs";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";

export type DirectoryModeChecks = {
  check?: () => void;
  beforeChmod?: () => Promise<void>;
};
export type DirectoryModeOwner = {
  verify(check?: () => void): Promise<void>;
  apply(mode: number, checks?: DirectoryModeChecks): Promise<void>;
  close(): Promise<void>;
};

export function assertOwnedDirectory(expected: Stats | BigIntStats, actual: Stats | BigIntStats): void {
  if (actual.isSymbolicLink() || !actual.isDirectory()) {
    throw new FsSafeError("not-file", "directory mode target must be a real directory");
  }
  if (!sameFileIdentityForCleanup(expected, actual)) {
    throw new FsSafeError("path-mismatch", "directory changed before its mode could be applied");
  }
}

/** Serializes use and close: even a queued path-based fd operation retains its descriptor. */
export function ownDirectoryMode(params: {
  inspect: () => Promise<number>;
  chmod: (mode: number) => Promise<void>;
  prepareChmod?: () => Promise<void>;
  verifyChmod?: () => Promise<void>;
  close: () => Promise<void>;
  ignoreChmodError?: boolean;
}): DirectoryModeOwner {
  let pending = Promise.resolve();
  let closing: Promise<void> | undefined;
  const enqueue = (run: () => Promise<void>): Promise<void> => {
    if (closing) return Promise.reject(new FsSafeError("path-mismatch", "directory mode owner is closed"));
    const operation = pending.then(run);
    pending = operation.catch(() => undefined);
    return operation;
  };
  return {
    verify: (check) => enqueue(async () => {
      check?.();
      await params.inspect();
      check?.();
    }),
    apply: (mode, checks = {}) => enqueue(async () => {
      // inspect() reports permission bits only; chmod ignores file-type bits,
      // so tolerate raw stat modes (e.g. S_IFDIR | 0o755) by masking up front.
      mode &= 0o7777;
      checks.check?.();
      const currentMode = await params.inspect();
      checks.check?.();
      if (currentMode !== mode) {
        await params.prepareChmod?.();
        checks.check?.();
      }
      await checks.beforeChmod?.();
      checks.check?.();
      // Hooks/ancestor checks can yield; recheck the original named association.
      await params.inspect();
      checks.check?.();
      let dispatchDeadlineError: unknown;
      if (currentMode !== mode) {
        try {
          checks.check?.();
          await params.chmod(mode);
        } catch (error) {
          if (!params.ignoreChmodError) throw error;
        }
        // Expiry cannot release the fd while post-dispatch verification is pending.
        try { checks.check?.(); } catch (error) { dispatchDeadlineError = error; }
        await params.verifyChmod?.();
      }
      const finalMode = await params.inspect();
      if (dispatchDeadlineError) throw dispatchDeadlineError;
      checks.check?.();
      if (!params.ignoreChmodError && finalMode !== mode) {
        throw new FsSafeError("path-mismatch", "directory final mode could not be verified");
      }
    }),
    close() {
      closing ??= pending.then(params.close);
      return closing;
    },
  };
}
