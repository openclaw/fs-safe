const windows = process.platform === "win32";

export const DEFAULT_SIDECAR_CHILD_TIMEOUT_MS = 4_000;

export const SIDECAR_PACKAGE_COPY_TIMINGS = {
  childTimeoutMs: windows ? 10_000 : DEFAULT_SIDECAR_CHILD_TIMEOUT_MS,
  testTimeoutMs: windows ? 15_000 : 5_000,
  slowCopyDelayMs: windows ? 16_000 : 6_000,
  hookTimeoutMs: windows ? 60_000 : 30_000,
} as const;
