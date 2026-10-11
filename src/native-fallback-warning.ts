import { getNativeFallbackDiagnostic, type NativeBinding } from "./native.js";
import { getNativeModeSetting } from "./native-config.js";
import { nativeGuidance } from "./native-guidance.js";

const warnedFeatures = new Set<string>();

function fallbackReason(capabilities: (keyof NativeBinding)[]): string {
  const diagnostic = getNativeFallbackDiagnostic(...capabilities);
  const expected = diagnostic.packageName === undefined
    ? `No native package is published for ${diagnostic.target}.`
    : `Expected ${diagnostic.packageName}@${diagnostic.packageVersion}.`;
  const guidance = nativeGuidance(diagnostic.reason, getNativeModeSetting().source);
  switch (diagnostic.reason) {
    case "disabled":
      return `native support is disabled by ${diagnostic.source} (disabled). ${expected} ${guidance}`;
    case "unsupported-target":
      return `the target ${diagnostic.target} is unsupported (unsupported-target). ${expected} ${guidance}`;
    case "package-missing":
      return `the selected native package could not be resolved (package-missing). ${expected} ${guidance}`;
    case "load-failed":
      return `the native package could not be loaded (load-failed: ${diagnostic.code}). ${expected} ${guidance}`;
    case "capability-missing":
      return `the native package lacks requested functions (capability-missing: ${diagnostic.capabilities.join(", ")}). ${expected} ${guidance}`;
    default:
      return `the requested native operation is unavailable (${diagnostic.reason}). ${expected}`;
  }
}

/** Warn once per capability, without including caller paths or native error text. */
export function warnNativeFallback(feature: string, limitation: string, ...capabilities: (keyof NativeBinding)[]): void {
  if (warnedFeatures.has(feature)) return;
  warnedFeatures.add(feature);
  process.emitWarning(
    `${feature} is using its portable fallback because ${fallbackReason(capabilities)} ${limitation}`,
    { code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning" },
  );
}

export function __resetNativeFallbackWarningsForTest(): void {
  warnedFeatures.clear();
}
