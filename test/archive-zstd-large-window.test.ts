import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("streams a valid maximum zstd history window within bounded child memory", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("./fixtures/archive-zstd-large-window.mjs", import.meta.url))],
    { timeout: 45_000, maxBuffer: 64 * 1024 });
  expect(stderr).toBe("");
  const proof = JSON.parse(stdout) as { total: number; expected: number; maxChunk: number; maxRssBytes: number };
  expect(proof.expected).toBe(134_348_800);
  expect(proof.total).toBe(proof.expected);
  expect(proof.maxChunk).toBeLessThanOrEqual(65536);
  // Includes the bounded WASM history transition, Node, and its loaded code.
  expect(proof.maxRssBytes).toBeLessThan(1024 * 1024 * 1024);
}, 60_000);
