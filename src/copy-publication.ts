import type { PinnedWriteParams, PublishedWriteIdentity } from "./pinned-write.js";
import { FsSafeError } from "./errors.js";

export type RootCopyPublicationReceipt = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
}>;

export function createCopyPublicationObserver(
  path: string,
  notify?: (receipt: RootCopyPublicationReceipt) => void,
) {
  let rejected: { error: unknown } | undefined;
  return {
    onPublished(identity: PublishedWriteIdentity): void {
      const receipt = Object.freeze({ path, dev: identity.dev, ino: identity.ino });
      try {
        const result: unknown = notify?.(receipt);
        if (result !== null && (typeof result === "object" || typeof result === "function") &&
          "then" in result && typeof result.then === "function") {
          void Promise.resolve(result).catch(() => undefined);
          throw new TypeError("onDestinationPublished must be synchronous");
        }
      } catch (error) {
        rejected = { error };
        throw error;
      }
    },
    rethrowObserverFailure(error: unknown): void {
      if (rejected && (error === rejected.error ||
        (error instanceof FsSafeError && error.cause === rejected.error && error.details?.phase === "publish"))) {
        throw rejected.error;
      }
    },
  };
}

// Internal composition hook; the descriptor is borrowed until the callback returns.
// Kept off RootCopyOptions and all public package exports.
export const onCopyPublication = Symbol("onCopyPublication");
export type CopyPublicationOptions = {
  [onCopyPublication]?: PinnedWriteParams["verifyPublished"];
};
