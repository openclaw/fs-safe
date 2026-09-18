import path from "node:path";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { createPrivateWindowsDirectoryCommand } from "./windows-security-command.js";

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

  assertNoWindowsPathAlias(
    targetPath,
    "filesystem",
    "private directory path uses a Windows filesystem namespace alias",
    platform,
  );

  const native = getNativeBinding();
  if (typeof native?.createPrivateDirectory === "function") {
    native.createPrivateDirectory(targetPath);
    return;
  }
  if (getFsSafeNativeConfig().mode === "require") {
    throw new FsSafeError("helper-unavailable", "private Windows directory creation requires an up-to-date native helper");
  }
  // Preserve the native parser's raw component restrictions before resolve()
  // could discard dot components or Win32 could trim trailing aliases.
  const components = targetPath.replaceAll("/", "\\").split("\\");
  if (components.some(component => component.endsWith(".") || component.endsWith(" "))) {
    throw Object.assign(new Error("private directory path has an ambiguous component"), { code: "EINVAL" });
  }
  warnNativeFallback("windows-private-directory", "Private Windows directory creation uses a slower built-in system command.");
  await createPrivateWindowsDirectoryCommand(path.win32.resolve(targetPath));
}
