import path from "node:path";
import { FsSafeError } from "./errors.js";
import { requireNativeBinding } from "./native.js";

function call<T>(operation: () => T): T {
  if (process.platform !== "win32") {
    throw new FsSafeError("unsupported-platform", "Windows test fixtures require Windows");
  }
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof FsSafeError) throw cause;
    throw new FsSafeError("helper-failed", "Windows test fixture operation failed", { cause });
  }
}

/** Test-only handle that omits delete sharing. */
export function holdWindowsSharingLock(filePath: string): Disposable & { close(): void } {
  return call(() => {
    const native = requireNativeBinding();
    if (!native.holdWindowsSharingLock) throw new FsSafeError("helper-unavailable", "Windows sharing fixture unavailable");
    const owner = native.holdWindowsSharingLock(path.toNamespacedPath(filePath));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      call(() => owner.close());
    };
    return Object.freeze({ close, [Symbol.dispose]: close });
  });
}

/** Test-only attribute updates preserve unspecified bits on the opened object. */
export function setWindowsFileAttributes(filePath: string, attrs: { readOnly?: boolean; hidden?: boolean; system?: boolean }): void {
  call(() => {
    const native = requireNativeBinding();
    if (!native.setWindowsFileAttributes) throw new FsSafeError("helper-unavailable", "Windows attribute fixture unavailable");
    native.setWindowsFileAttributes(path.toNamespacedPath(filePath), attrs);
  });
}

/** Test-only physical mapping reader; lcn -1 represents sparse clusters. */
export function readWindowsFileExtents(filePath: string): { vcn: bigint; lcn: bigint; clusters: bigint }[] {
  return call(() => {
    const native = requireNativeBinding();
    if (!native.readWindowsFileExtents) throw new FsSafeError("helper-unavailable", "Windows extent fixture unavailable");
    return native.readWindowsFileExtents(path.toNamespacedPath(filePath));
  });
}
