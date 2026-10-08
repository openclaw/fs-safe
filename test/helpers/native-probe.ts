import { fstatSync } from "node:fs";
import { __loadBundledNativeForTest, type NativeBinding } from "../../src/native.js";

export function loadTestNative(
  policy: "optional" | "required-env",
  load = __loadBundledNativeForTest,
): NativeBinding | undefined {
  try {
    return load();
  } catch (error) {
    if (policy === "required-env" && process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
    return undefined;
  }
}

/** POSIX-hosted Windows branch simulations still need Windows-only identity facts. */
export function loadWindowsSimulationNative(): NativeBinding {
  const binding = __loadBundledNativeForTest();
  if (typeof binding.fstatIdentity === "function") return binding;
  return {
    ...binding,
    fstatIdentity(fd) {
      const stat = fstatSync(fd);
      return {
        dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size,
        isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink(),
      };
    },
  };
}
