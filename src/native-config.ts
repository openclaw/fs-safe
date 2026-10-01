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

export function getFsSafeNativeConfig(): FsSafeNativeConfig {
  return {
    mode:
      overrideConfig.mode ??
      parseMode(process.env.FS_SAFE_NATIVE_MODE) ??
      parseMode(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE) ??
      "auto",
  };
}

export function isFsSafeNativeRequired(): boolean {
  return (overrideConfig.mode ??
    parseMode(process.env.FS_SAFE_NATIVE_MODE) ??
    parseMode(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE) ??
    "auto") === "require";
}

export function __resetFsSafeNativeConfigForTest(): void {
  overrideConfig = {};
}
