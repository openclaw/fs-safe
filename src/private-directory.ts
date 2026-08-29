import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";

export type CreatePrivateDirectoryOptions = {
  platform?: NodeJS.Platform;
};

export async function createPrivateDirectory(
  targetPath: string,
  options?: CreatePrivateDirectoryOptions,
): Promise<void> {
  const platform = options?.platform ?? process.platform;
  if (platform !== "win32") {
    throw new FsSafeError(
      "helper-unavailable",
      "private-directory creation is supported only on Windows",
    );
  }

  const native = getNativeBinding();
  if (!native) {
    throw new FsSafeError(
      "helper-unavailable",
      "private Windows directory creation requires the matching optional native platform package; " +
        "install @openclaw/fs-safe with optional dependencies enabled on a supported platform and use FS_SAFE_NATIVE_MODE=auto or require",
    );
  }
  native.createPrivateDirectory(targetPath);
}
