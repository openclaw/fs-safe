import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTestNative } from "./helpers/native-probe.js";

const nativeAvailable = process.platform === "win32" && Boolean(loadTestNative("required-env"));
const cases = ["off", "require"].flatMap(mode => ["main", "worker"].flatMap(thread =>
  ["collision", "directory-denied", "file-denied"].map(scenario => ({ mode, thread, scenario })),
));

it("imports the Windows errno fixture's package API on every platform", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./fixtures/windows-creation-errno.mjs", import.meta.url)), "imports",
  ], { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ imports: true });
});

describe.runIf(process.platform === "win32")("Windows creation errno at the OS boundary", () => {
  for (const { mode, thread, scenario } of cases) {
    it.runIf(mode === "off" || nativeAvailable)(`${mode}: ${scenario} on ${thread}`, () => {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL("./fixtures/windows-creation-errno.mjs", import.meta.url)), thread, scenario,
      ], { encoding: "utf8", env: { ...process.env, FS_SAFE_NATIVE_MODE: mode }, timeout: 30_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(scenario === "collision"
        ? { scenario, errno: [183, 183], preflightErrno: null }
        : { scenario, errno: [5, 5], preserved: true });
    }, 35_000);
  }
});
