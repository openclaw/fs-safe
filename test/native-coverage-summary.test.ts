import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/summarize-native-coverage.mjs", import.meta.url));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run({ covered = 98, branches = 100, unitCovered = 30 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "native-coverage-summary-")); directories.push(dir);
  mkdirSync(path.join(dir, "coverage-rust"));
  const totals = (lines: number) => ({ lines: { count: 100, covered: lines, percent: lines }, branches: { count: branches, covered: branches / 2, percent: 50 } });
  for (const [name, lines] of [["unit-summary", unitCovered], ["coverage-summary", covered]] as const) {
    writeFileSync(path.join(dir, "coverage-rust", `${name}.json`), JSON.stringify({ data: [{ totals: totals(lines) }] }));
  }
  const summary = path.join(dir, "summary.md");
  const output = execFileSync(process.execPath, [script], { cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8", stdio: "pipe" });
  return { output, summary: readFileSync(summary, "utf8") };
}
it("reports both corpora and writes the GitHub summary", () => {
  const result = run();
  expect(result.output).toContain("| Unit tests | 30.00% | 50.00% |");
  expect(result.output).toContain("| Unit tests + TS addon suites | 98.00% | 50.00% |");
  expect(result.summary).toBe(result.output.trimEnd() + "\n");
});
it("rejects missing branch instrumentation", () => { expect(() => run({ branches: 0 })).toThrow("Missing Rust branches instrumentation"); });
it("rejects an addon that contributes no coverage", () => { expect(() => run({ unitCovered: 98 })).toThrow("Addon suites did not add Rust line coverage"); });

it("rejects Rust line coverage below the ratchet", () => { expect(() => run({ covered: 70 })).toThrow("below 71%"); });
