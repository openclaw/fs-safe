import { getNativeFallbackDiagnostic, type NativeBinding } from "./native.js";

const warnedFeatures = new Set<string>();

function fallbackReason(capabilities: (keyof NativeBinding)[]): string {
  const diagnostic = getNativeFallbackDiagnostic(...capabilities);
  const expected = diagnostic.packageName === undefined
    ? `No native package is published for ${diagnostic.target}.`
    : `Expected ${diagnostic.packageName}@${diagnostic.packageVersion}.`;
  switch (diagnostic.reason) {
    case "disabled": {
      const enable = diagnostic.source === "programmatic configuration"
        ? 'call configureFsSafeNative({ mode: "auto" }) or configureFsSafeNative({ mode: "require" })'
        : `set ${diagnostic.source}=auto or ${diagnostic.source}=require`;
      return `native support is disabled by ${diagnostic.source} (disabled). ${expected} ` +
        `If native loading is intended, ${enable}; keep intentional off settings.`;
    }
    case "unsupported-target":
      return `the target ${diagnostic.target} is unsupported (unsupported-target). ${expected} Portable mode is expected on this target.`;
    case "package-missing":
      return `the selected native package could not be resolved (package-missing). ${expected} ` +
        `Reinstall with optional dependencies included: npm --include=optional, or pnpm without --no-optional / optional=false. Check the lockfile and registry mirror.`;
    case "load-failed":
      return `the native package could not be loaded (load-failed: ${diagnostic.code}). ${expected} ` +
        `Check Node architecture, Linux libc compatibility, package dependencies, and OS code-integrity policy. Reinstalling identical bytes may not help.`;
    case "capability-missing":
      return `the native package lacks requested functions (capability-missing: ${diagnostic.capabilities.join(", ")}). ${expected} ` +
        `Use matching fs-safe and platform-package versions; some targets intentionally provide only a subset of capabilities.`;
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
