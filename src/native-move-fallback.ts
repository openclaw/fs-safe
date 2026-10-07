import type { BigIntStats } from "node:fs";
import { FsSafeError } from "./errors.js";
import type { NativeBinding } from "./native-binding.js";
import {
  cachedNoReplaceUnavailable, noReplaceUnavailable, rememberNoReplaceUnavailable,
} from "./native-noreplace.js";

function fallbackError(error: unknown, operation: string): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : "native no-replace move fallback failed";
  if (code === "FS_SAFE_INTERNAL_MOVE_LINK_UNSUPPORTED") {
    return new FsSafeError("helper-unavailable", message, { cause: error,
      details: { capability: "rename-noreplace", fallback: "link-unlink", fallbackCapability: "linkat" } });
  }
  const sourceRemoval = new Map([
    ["FS_SAFE_INTERNAL_MOVE_LINK_CHANGED", "not-attempted"],
    ["FS_SAFE_INTERNAL_MOVE_SOURCE_LINKED", "still-linked"],
    ["FS_SAFE_INTERNAL_MOVE_UNLINK_UNVERIFIED", "unverified"],
    ["FS_SAFE_INTERNAL_MOVE_PUBLISHED", "removed"],
  ]).get(code ?? "");
  if (sourceRemoval) {
    return new FsSafeError(code === "FS_SAFE_INTERNAL_MOVE_LINK_CHANGED" ? "path-mismatch" : "helper-failed",
      message, { cause: error, details: { operation, fallback: "link-unlink",
        publication: "published", sourceRemoval } });
  }
  // Keep collision and identity errors available to the Root normalizer.
  return error;
}

export function nativeMoveNoReplace(
  binding: NativeBinding, paths: Parameters<NativeBinding["renameNoReplace"]>, expected: BigIntStats | undefined, allowFallback: boolean,
  operation = "move",
): "link-unlink" | undefined {
  const [sourceFd, source, targetFd, target] = paths;
  let unavailable = cachedNoReplaceUnavailable(binding, sourceFd, operation);
  if (!unavailable) {
    try {
      binding.renameNoReplace(...paths);
      return;
    } catch (error) {
      unavailable = noReplaceUnavailable(error, operation, true);
      if (!unavailable) throw error;
      // As in sibling publication/quarantine, distinct sibling names cannot
      // have a directory-ancestry EINVAL. Cross-parent moves must not cache it.
      if (sourceFd === targetFd && source !== target) {
        rememberNoReplaceUnavailable(binding, sourceFd, unavailable);
      }
    }
  }
  if (!allowFallback || process.platform !== "linux" || !binding.moveNoReplaceFallback || !expected) throw unavailable;
  try {
    binding.moveNoReplaceFallback(...paths, expected.dev, expected.ino);
    return expected.isFile() ? "link-unlink" : undefined;
  } catch (error) {
    throw fallbackError(error, operation);
  }
}
