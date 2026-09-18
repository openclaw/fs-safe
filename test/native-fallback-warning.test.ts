import { afterEach, expect, it, vi } from "vitest";
import { __resetNativeFallbackWarningsForTest, warnNativeFallback } from "../src/native-fallback-warning.js";

afterEach(() => { __resetNativeFallbackWarningsForTest(); vi.restoreAllMocks(); });

it("reports a stable warning code once per affected feature", () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  warnNativeFallback("file moves", "Publication and source removal are separate operations.");
  warnNativeFallback("file moves", "Publication and source removal are separate operations.");
  warnNativeFallback("file staging", "Cleanup preserves files when directory identity changes.");
  expect(warning).toHaveBeenCalledTimes(2);
  expect(warning).toHaveBeenNthCalledWith(1,
    "file moves is using its portable fallback because native support is unavailable. Publication and source removal are separate operations.",
    { code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning" },
  );
  expect(warning).toHaveBeenNthCalledWith(2,
    "file staging is using its portable fallback because native support is unavailable. Cleanup preserves files when directory identity changes.",
    { code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning" },
  );
});
