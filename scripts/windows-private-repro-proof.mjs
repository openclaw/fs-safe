// Run the historical probe unchanged. Its final assertions expect the old
// failure; the receipt, not that deliberately stale assertion, proves the fix.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32");
const child = spawnSync(process.execPath, [fileURLToPath(new URL(
  "../test/fixtures/windows-private-directory-repro.mjs", import.meta.url,
))], { encoding: "utf8", timeout: 30_000, env: { ...process.env, FS_SAFE_NATIVE_MODE: "require" } });
assert.equal(child.error, undefined);
const runtime = process.versions.bun ? "bun" : "node";
const receipt = path.join(".proof-results", `private-directory-${runtime}.json`);
const result = JSON.parse(fs.readFileSync(receipt, "utf8"));
assert.equal(result.rows.length, 24);
for (const row of result.rows) {
  assert.equal(row.result, "success", JSON.stringify(row));
  assert.deepEqual(row.remainingEntries, []);
}
assert.equal(child.status, 1, "the unchanged probe still asserts the old error outcome");
assert.match(child.stderr, /AssertionError/);
assert.match(child.stderr, /success/);
assert.match(child.stderr, /error/);
fs.mkdirSync("artifacts-windows-long-path", { recursive: true });
fs.renameSync(receipt, `artifacts-windows-long-path/historical-${runtime}-${process.arch}.json`);
fs.writeFileSync(`artifacts-windows-long-path/historical-${runtime}-${process.arch}.stderr.txt`, child.stderr);
console.log(JSON.stringify({ runtime, arch: process.arch, operations: result.rows.length,
  success: true, unchangedProbeExit: child.status, reason: "historical assertions expect the repaired failure" }));
