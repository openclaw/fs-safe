import type { getNativeModeSetting } from "./native-config.js";

/** Shared, path-free next steps for status reports and fallback warnings. */
export function nativeGuidance(
  reason: string,
  modeSource: ReturnType<typeof getNativeModeSetting>["source"],
): string | undefined {
  switch (reason) {
    case "disabled": {
      const enable = modeSource === "programmatic configuration"
        ? 'call configureFsSafeNative({ mode: "auto" }) or configureFsSafeNative({ mode: "require" })'
        : `set ${modeSource}=auto or ${modeSource}=require`;
      return `If native loading is intended, ${enable}; keep intentional off settings.`;
    }
    case "unsupported-target":
      return "Portable mode is expected on this target.";
    case "package-missing":
      return "Reinstall with optional dependencies included: npm --include=optional, or pnpm without --no-optional / optional=false. Check the lockfile and registry mirror.";
    case "load-failed":
      return "Check Node architecture, Linux libc compatibility, package dependencies, and OS code-integrity policy. Reinstalling identical bytes may not help.";
    case "capability-missing":
      return "Use matching fs-safe and platform-package versions; some targets intentionally provide only a subset of capabilities.";
    default:
      return undefined;
  }
}
