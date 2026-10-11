import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTestNative } from "./helpers/native-probe.js";

const native = process.platform === "win32" ? loadTestNative("required-env") : undefined;
describe.runIf(native)("Windows native admitted path spellings", () => {
  it("preserves drive and UNC namespaces and rejects device inputs on main and Worker", () => {
    const proof = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL(
      "./fixtures/windows-native-path-spelling.mjs", import.meta.url,
    ))], { encoding: "utf8", timeout: 30_000 }));
    expect(proof.rows).toHaveLength(22);
    expect(proof.rows.filter((row: { result: string }) => row.result === "accepted")).toHaveLength(16);
    expect(proof.rows.filter((row: { result: string }) => row.result === "rejected-by-admission")).toHaveLength(6);
  }, 35_000);
});
