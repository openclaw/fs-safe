import { describe, expect, it } from "vitest";
import { assertNativeCopyCompleted, createNativeCopyFile, type CopyFileInput } from "../src/copy-file-input.js";

// Regression: on filesystems/kernel builds where FICLONE is denied with EPERM
// (PVE LXC ext4 without the reflink feature, or a host kernel without
// CONFIG_EXT4_FS_REFLINK) or ENOTTY, the native layer classifies it as a clone
// capability miss. The JS layer must agree, so callers can fall back to a byte
// copy (auto) or report unsupported-platform (always) instead of hard-failing
// the whole operation with "native file copy failed".
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

describe("native copy clone-capability miss classification", () => {
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

  it.each(["EPERM", "ENOTTY"] as const)("%s from a completed native result is unsupported-platform", async code => {
    const result = { fd: 9, method: "clone" as const, errorCode: code, errorMessage: "FICLONE denied" };
    expect(() => assertNativeCopyCompleted(input("always"), result)).toThrow(
      expect.objectContaining({ code: "unsupported-platform", message: "FICLONE denied" }),
    );
  });
});
