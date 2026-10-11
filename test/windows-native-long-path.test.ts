import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTestNative } from "./helpers/native-probe.js";

const native = process.platform === "win32" ? loadTestNative("required-env") : undefined;
describe.runIf(native)("Windows native long paths", () => {
  it("creates privately, copies and removes across MAX_PATH on the main thread and in a Worker", () => {
    const proof = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL(
      "./fixtures/windows-long-path-proof.mjs", import.meta.url,
    ))], { encoding: "utf8", timeout: 30_000 }));
    expect(proof.rows).toHaveLength(24);
    expect(proof.rows.reduce((count: number, row: { operations: number }) => count + row.operations, 0)).toBe(96);
  }, 35_000);
});
