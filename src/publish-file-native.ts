import type { BigIntStats } from "node:fs";
import { FsSafeError } from "./errors.js";
import type { NativeBinding } from "./native-binding.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { nativeMoveNoReplace } from "./native-move-fallback.js";
import { rememberCreatedTarget, type PublishFailureState } from "./publish-file-failure.js";

export function publishFileNoReplaceNative(
  binding: NativeBinding, paths: Parameters<NativeBinding["renameNoReplace"]>,
  expected: BigIntStats, failure: PublishFailureState,
): "link-unlink" | undefined {
  try {
    const fallback = nativeMoveNoReplace(binding, paths, expected,
      getFsSafeNativeConfig().mode === "auto", "file publication");
    if (fallback) {
      failure.fallback = fallback;
      failure.sourceRemoval = "removed";
    }
    return fallback;
  } catch (error) {
    if (error instanceof FsSafeError && error.details?.publication === "published") {
      failure.targetCreated = true;
      failure.preserveTarget = true;
      failure.phase = "rename-verify";
      failure.fallback = "link-unlink";
      failure.sourceRemoval = error.details.sourceRemoval as PublishFailureState["sourceRemoval"];
      // Changed/unverified pairs cannot establish which inode was published.
      if (failure.sourceRemoval === "still-linked") rememberCreatedTarget(failure, expected, "rename-verify");
    }
    if (error instanceof FsSafeError) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "path-mismatch" || code === "hardlink") {
      throw new FsSafeError(code, "publication source changed before fallback", { cause: error });
    }
    if (code === "ELOOP") throw new FsSafeError("symlink", "publication source became a symlink", { cause: error });
    throw error;
  }
}
