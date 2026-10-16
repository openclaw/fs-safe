export type FsSafeNativeMode = "auto" | "off" | "require";

export type FsSafeNativeConfig = {
  mode: FsSafeNativeMode;
};

let overrideConfig: Partial<FsSafeNativeConfig> = {};

function parseMode(value: string | undefined): FsSafeNativeMode | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "never") {
    return "off";
  }
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "auto") {
    return "auto";
  }
  if (normalized === "required" || normalized === "require") {
    return "require";
  }
  return undefined;
}

export function configureFsSafeNative(config: Partial<FsSafeNativeConfig>): void {
  overrideConfig = { ...overrideConfig, ...config };
}

function rejectLegacyMode(): "auto" {
  for (const source of ["FS_SAFE_PYTHON_MODE", "OPENCLAW_FS_SAFE_PYTHON_MODE"] as const) {
    if (process.env[source] === undefined) continue;
    const mode = parseMode(process.env[source]) ?? "auto";
    throw new Error(
      `${source} has been removed. Set FS_SAFE_NATIVE_MODE=${mode} or ` +
        `configureFsSafeNative({ mode: "${mode}" }) before using fs-safe, then remove ${source}. ` +
        "Legacy mode settings no longer select native policy.",
    );
  }
  return "auto";
}

export function getFsSafeNativeConfig(): FsSafeNativeConfig {
  return {
    mode:
      overrideConfig.mode ??
      parseMode(process.env.FS_SAFE_NATIVE_MODE) ??
      parseMode(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE) ??
      rejectLegacyMode(),
  };
}

/** Internal provenance; keep the public configuration shape unchanged. */
export function getNativeModeSetting(): {
  mode: FsSafeNativeMode;
  source: "programmatic configuration" | "FS_SAFE_NATIVE_MODE" | "OPENCLAW_FS_SAFE_NATIVE_MODE" | "default";
} {
  if (overrideConfig.mode !== undefined) return { mode: overrideConfig.mode, source: "programmatic configuration" };
  for (const source of ["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"] as const) {
    const mode = parseMode(process.env[source]);
    if (mode !== undefined) return { mode, source };
  }
  return { mode: rejectLegacyMode(), source: "default" };
}

export function isFsSafeNativeRequired(): boolean {
  return (overrideConfig.mode ??
    parseMode(process.env.FS_SAFE_NATIVE_MODE) ??
    parseMode(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE) ??
    rejectLegacyMode()) === "require";
}

export function __resetFsSafeNativeConfigForTest(): void {
  overrideConfig = {};
}
