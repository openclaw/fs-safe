import { describe, expect, it } from "vitest";
import { assertNativeCopyCompleted, createNativeCopyFile, type CopyFileInput } from "../src/copy-file-input.js";

// Regression: on bindings that do not normalize FICLONE capability errors
// (fs-safe < 0.23.1, e.g. the 0.21.1 that OpenClaw 2026.9.x bundles), a FICLONE
// denial with EPERM (seccomp/LSM policy, or a filesystem without the reflink
// feature) or ENOTTY reaches the JS layer as a rejected copyFileExclusive
// promise. The createNativeCopyFile catch path must classify that as a
// clone-capability miss so callers select the byte-copy fallback (auto) or
// report unsupported-platform (always) instead of hard-failing the operation
// with "native file copy failed".
//
// NOTE: this deliberately does NOT widen assertNativeCopyCompleted's
// completed-result list. Completed-result errorCodes carry genuine transfer
// failures (a denied pread/pwrite/fchmod can carry raw EPERM) that must stay
// helper-failed. FICLONE capability misses surface via the catch path, not the
// completed result.
function capabilityError(code: "EPERM" | "ENOTTY"): NodeJS.ErrnoException {
  const error = new Error(
    code === "EPERM"
      ? "FICLONE: Operation not permitted (os error 1)"
      : "FICLONE: Inappropriate ioctl for device (os error 25)",
  ) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function bindingFor(failure: NodeJS.ErrnoException | { errorCode: string; errorMessage: string }) {
  let copyFileExclusive: (fd: number, parentFd: number, name: string, clone: string, maxBytes?: number, signal?: AbortSignal) => Promise<unknown>;
  if ("code" in failure) {
    copyFileExclusive = () => Promise.reject(failure);
  } else {
    copyFileExclusive = () =>
      Promise.resolve({ fd: 9, method: "clone", errorCode: failure.errorCode, errorMessage: failure.errorMessage });
  }
  return { copyFileExclusive, closeOwnedFd: () => undefined } as never;
}

function input(clone: "auto" | "always"): CopyFileInput {
  return { kind: "file", handle: { fd: 3 } as never, size: 4, clone, verifySource: async () => undefined };
}

describe("native copy clone-capability miss classification (catch path)", () => {
  it.each(["EPERM", "ENOTTY"] as const)("%s in auto mode selects the byte-copy fallback", async code => {
    const binding = bindingFor(capabilityError(code));
    await expect(createNativeCopyFile(binding, input("auto"), 7, "stage", undefined)).resolves.toEqual(undefined);
  });

  it.each(["EPERM", "ENOTTY"] as const)("%s in always mode reports unsupported-platform, not helper-failed", async code => {
    const binding = bindingFor(capabilityError(code));
    await expect(createNativeCopyFile(binding, input("always"), 7, "stage", undefined)).rejects.toMatchObject({
      code: "unsupported-platform",
    });
  });

  it.each(["EPERM", "ENOTTY"] as const)("%s from a completed native result is NOT reclassified (stays helper-failed)", async code => {
    // A completed-result errorCode reflects the whole transfer, not just the
    // clone. A genuine transfer failure carrying this errno must stay
    // helper-failed: the completed-result list is intentionally not widened.
    const result = { fd: 9, method: "copy-file-range" as const, errorCode: code, errorMessage: "transfer denied" };
    expect(() => assertNativeCopyCompleted(input("always"), result)).toThrow(
      expect.objectContaining({ code: "helper-failed", message: "transfer denied" }),
    );
  });
});
