export type FsSafeNativeMode = "auto" | "off" | "require";

export type FsSafeNativeConfig = {
  mode: FsSafeNativeMode;
};

/** @deprecated Compatibility bridge for 0.4 upgrades. Use {@link FsSafeNativeConfig}. */
export type FsSafePythonConfig = {
  mode: FsSafeNativeMode;
  pythonPath?: string;
};

let overrideConfig: Partial<FsSafeNativeConfig> = {};
let legacyWarningEmitted = false;

const legacyModeEnvKeys = ["FS_SAFE_PYTHON_MODE", "OPENCLAW_FS_SAFE_PYTHON_MODE"] as const;
const legacyPathEnvKeys = [
  "FS_SAFE_PYTHON",
  "OPENCLAW_FS_SAFE_PYTHON",
  "OPENCLAW_PINNED_PYTHON",
  "OPENCLAW_PINNED_WRITE_PYTHON",
] as const;

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

function warnLegacyPythonConfiguration(source: string, mappedMode: FsSafeNativeMode): void {
  if (legacyWarningEmitted) {
    return;
  }
  legacyWarningEmitted = true;
  process.emitWarning(
    `${source} is a deprecated 0.4 compatibility bridge; mapped to native mode ` +
      `"${mappedMode}". Use configureFsSafeNative({ mode: "${mappedMode}" }) or ` +
      `FS_SAFE_NATIVE_MODE=${mappedMode}. Python interpreter paths are no longer used.`,
    { code: "FS_SAFE_PYTHON_DEPRECATED", type: "DeprecationWarning" },
  );
}

function readLegacyPythonMode(): FsSafeNativeMode | undefined {
  const configuredKeys = [...legacyModeEnvKeys, ...legacyPathEnvKeys].filter(
    (key) => process.env[key] !== undefined,
  );
  if (configuredKeys.length === 0) {
    return undefined;
  }
  const rawMode = legacyModeEnvKeys.map((key) => process.env[key]).find((value) => value !== undefined);
  const mappedMode = parseMode(rawMode) ?? "auto";
  warnLegacyPythonConfiguration(`Legacy ${configuredKeys.join(", ")}`, mappedMode);
  return mappedMode;
}

/**
 * @deprecated Compatibility bridge for 0.4 upgrades. Use configureFsSafeNative.
 */
export function configureFsSafePython(config: Partial<FsSafePythonConfig>): void {
  const mappedMode = config.mode ?? "auto";
  warnLegacyPythonConfiguration("configureFsSafePython()", mappedMode);
  if (config.mode !== undefined) {
    configureFsSafeNative({ mode: config.mode });
  }
}

export function getFsSafeNativeConfig(): FsSafeNativeConfig {
  const legacyMode = readLegacyPythonMode();
  return {
    mode:
      overrideConfig.mode ??
      parseMode(process.env.FS_SAFE_NATIVE_MODE) ??
      parseMode(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE) ??
      legacyMode ??
      "auto",
  };
}

// Routing needs the selected mode, not the legacy-path warning scan. Keep
// environment precedence live without charging unrelated auto operations for diagnostics.
export function isFsSafeNativeRequired(): boolean {
  return (overrideConfig.mode ??
    parseMode(process.env.FS_SAFE_NATIVE_MODE) ??
    parseMode(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE) ??
    parseMode(process.env.FS_SAFE_PYTHON_MODE ?? process.env.OPENCLAW_FS_SAFE_PYTHON_MODE) ??
    "auto") === "require";
}

export function __resetFsSafeNativeConfigForTest(): void {
  overrideConfig = {};
  legacyWarningEmitted = false;
}
