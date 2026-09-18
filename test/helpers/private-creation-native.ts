import { __loadBundledNativeForTest } from "../../src/native.js";

export function hasPrivateCreationNative(): boolean {
  try {
    const native = __loadBundledNativeForTest();
    const available = process.platform !== "win32" || [
      native.createPrivateDirectoryWithParentIdentity,
      native.inspectWindowsDirectory,
      native.protectPrivateWindowsFile,
      native.verifyPrivateWindowsFile,
    ].every(capability => typeof capability === "function");
    if (!available && process.env.FS_SAFE_NATIVE_MODE === "require") {
      throw new Error("required native addon lacks private creation capabilities");
    }
    return available;
  } catch (error) {
    if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
    return false;
  }
}
