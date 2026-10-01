import { __loadBundledNativeForTest, type NativeBinding } from "../../src/native.js";

export function loadTestNative(policy: "optional" | "required-env"): NativeBinding | undefined {
  try {
    return __loadBundledNativeForTest();
  } catch (error) {
    if (policy === "required-env" && process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
    return undefined;
  }
}
