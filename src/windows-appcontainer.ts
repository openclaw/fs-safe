import { FsSafeError } from "./errors.js";
import { getNativeBinding, type NativeBinding } from "./native.js";

/** The native owner caches immutable primary-token membership across Workers. */
export function isWindowsAppContainer(binding: NativeBinding): boolean | undefined {
  if (!binding.isWindowsAppContainer) return undefined;
  try {
    const membership = binding.isWindowsAppContainer();
    if (typeof membership !== "boolean") throw new Error("Invalid AppContainer membership");
    return membership;
  } catch (cause) {
    throw new FsSafeError("permission-unverified", "Windows process token membership could not be verified", { cause });
  }
}

export function assertWindowsHelperAllowed(): void {
  if (process.platform !== "win32") return;
  const binding = getNativeBinding();
  if (binding && isWindowsAppContainer(binding)) {
    // Current libuv can hang while creating child-process pipes in a lowbox.
    throw new FsSafeError("helper-unavailable", "External Windows security helpers are unavailable inside an AppContainer");
  }
}
