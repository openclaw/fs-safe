import { getNativeModeSetting, type FsSafeNativeMode } from "./native-config.js";
import { nativeGuidance } from "./native-guidance.js";
import { getNativeBinding, getNativeFallbackDiagnostic } from "./native.js";

export type FsSafeNativeStatusReason =
  | "not-probed" | "loaded" | "disabled" | "unsupported-target"
  | "package-missing" | "load-failed" | "capability-missing";

export type FsSafeNativeStatus = {
  mode: FsSafeNativeMode;
  modeSource: "programmatic configuration" | "FS_SAFE_NATIVE_MODE" | "OPENCLAW_FS_SAFE_NATIVE_MODE" | "default";
  reason: FsSafeNativeStatusReason;
  loaded: boolean;
  target: string;
  packageName?: string;
  packageVersion?: string;
  loadErrorCode?: string;
  guidance?: string;
};

/** Read this module instance's cached native outcome, optionally probing once. */
export function readFsSafeNativeStatus(options?: { probe?: boolean }): FsSafeNativeStatus {
  const { mode, source: modeSource } = getNativeModeSetting();
  if (options?.probe && mode !== "off") {
    try {
      getNativeBinding();
    } catch {
      // Required-mode load failures are cached; health checks report them.
    }
  }
  const diagnostic = getNativeFallbackDiagnostic();
  const guidance = nativeGuidance(diagnostic.reason, modeSource);
  return {
    mode,
    modeSource,
    reason: diagnostic.reason,
    loaded: diagnostic.reason === "loaded",
    target: diagnostic.target,
    ...(diagnostic.packageName === undefined ? {} : {
      packageName: diagnostic.packageName,
      packageVersion: diagnostic.packageVersion,
    }),
    ...(diagnostic.reason === "load-failed" ? { loadErrorCode: diagnostic.code } : {}),
    ...(guidance === undefined ? {} : { guidance }),
  };
}
