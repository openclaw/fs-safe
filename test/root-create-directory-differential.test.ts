import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadTestNative } from "./helpers/native-probe.js";

const nativeAvailable = Boolean(loadTestNative("required-env"));

it("classifies existing directories consistently in isolated public-API processes", () => {
  const script = fileURLToPath(new URL("../scripts/root-create-directory-proof.mjs", import.meta.url));
  const reports: unknown[] = [];
  for (const mode of nativeAvailable ? ["off", "auto", "require"] : ["off"]) {
    const child = spawnSync(process.execPath, [script, mode], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, FS_SAFE_NATIVE_MODE: mode },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr || child.stdout).toBe(0);
    reports.push(JSON.parse(child.stdout).cases);
  }
  for (const report of reports.slice(1)) expect(report).toEqual(reports[0]);
}, 100_000);
