import { expect, it } from "vitest";
import { creationProbeTimeoutMs } from "../scripts/consumer-install-smoke.mjs";

it.each(["off", "auto"])("allows measured headroom for omitted creation in x64 emulation (%s)", mode => {
  expect(creationProbeTimeoutMs(true, mode, { platform: "win32", arch: "x64", emulated: true })).toBe(600_000);
});

it.each([
  { platform: "win32", arch: "x64", emulated: false },
  { platform: "win32", arch: "arm64", emulated: true },
  { platform: "linux", arch: "x64", emulated: true },
  { platform: "darwin", arch: "x64", emulated: true },
])("keeps the 120-second bound outside Windows x64 emulation: %j", runtime => {
  for (const mode of ["off", "auto", "require"]) {
    expect(creationProbeTimeoutMs(true, mode, runtime)).toBe(120_000);
  }
});

it("keeps installed-addon and missing-required creation at 120 seconds even in emulation", () => {
  const runtime = { platform: "win32", arch: "x64", emulated: true };
  for (const mode of ["off", "auto", "require"]) {
    expect(creationProbeTimeoutMs(false, mode, runtime)).toBe(120_000);
  }
  expect(creationProbeTimeoutMs(true, "require", runtime)).toBe(120_000);
});
