import type { FsSafeNativeStatus } from "./native-status.js";

export {
  configureFsSafeNative,
  getFsSafeNativeConfig,
  type FsSafeNativeConfig,
  type FsSafeNativeMode,
} from "./native-config.js";
export type {
  FsSafeNativeStatus,
  FsSafeNativeStatusReason,
} from "./native-status.js";
export {
  configureFsSafeLocks,
  getFsSafeLockConfig,
  type FsSafeLockConfig,
} from "./lock-config.js";

/** Read native status without loading the native module on config import. */
export async function getFsSafeNativeStatus(options?: { probe?: boolean }): Promise<FsSafeNativeStatus> {
  const { readFsSafeNativeStatus } = await import("./native-status.js");
  return readFsSafeNativeStatus(options);
}
