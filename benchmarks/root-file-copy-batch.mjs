// Run after pnpm build. Optional first argument: another built package's dist/advanced.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as candidate from "../dist/advanced.js";
import { configureFsSafeNative } from "../dist/config.js";

const count = 3000;
const rounds = 3;
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-copy-bench-")));
const sourceRoot = path.join(base, "source");
const content = Buffer.alloc(1024, 0x5a);
const files = Array.from({ length: count }, (_, i) => `packages/p${i % 30}/lib/nested/file${i}.js`);
const implementations = [];
if (process.argv[2]) {
  const url = pathToFileURL(path.resolve(process.argv[2]));
  const baseline = await import(url.href);
  const config = await import(new URL("config.js", url).href);
  config.configureFsSafeNative({ mode: "off" });
  implementations.push(["baseline-single", baseline]);
}
configureFsSafeNative({ mode: "off" });
implementations.push(["candidate-single", candidate], ["candidate-batch", candidate]);
try {
  for (const relative of files) {
    const file = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const timings = new Map(implementations.map(([name]) => [name, []]));
  for (let round = 0; round < rounds; round++) {
    // Rotate order to avoid always giving one implementation the warmer cache.
    const order = [...implementations.slice(round), ...implementations.slice(0, round)];
    for (const [name, api] of order) {
      const targetRoot = path.join(base, `${name}-${round}`);
      for (const relative of files) fs.mkdirSync(path.dirname(path.join(targetRoot, relative)), { recursive: true });
      const batch = name.endsWith("-batch") ? api.createRootFileCopyBatchSync() : undefined;
      const start = performance.now();
      try {
        for (const relative of files) {
          const options = {
            source: { rootPath: sourceRoot, absolutePath: path.join(sourceRoot, relative) },
            destination: { rootPath: targetRoot, absolutePath: path.join(targetRoot, relative) },
            maxBytes: content.length,
          };
          const copied = batch ? batch.copyFile(options) : api.copyRootFileSync(options);
          try { assert.equal(copied.bytes, content.length); } finally { copied.close(); }
        }
      } finally { batch?.close(); }
      timings.get(name).push(performance.now() - start);
      // Verify every result outside the timed copy loop.
      for (const relative of files) assert.deepEqual(fs.readFileSync(path.join(targetRoot, relative)), content);
      fs.rmSync(targetRoot, { recursive: true });
    }
  }
  console.log(JSON.stringify({
    platform: process.platform, arch: process.arch, node: process.version,
    files: count, bytesPerFile: content.length, leafParents: 30, directoryDepth: 4, rounds, native: "off",
    results: [...timings].map(([name, ms]) => ({ name, ms, medianMs: [...ms].sort((a, b) => a - b)[1], microsecondsPerFile: [...ms].sort((a, b) => a - b)[1] * 1000 / count })),
  }, null, 2));
} finally { fs.rmSync(base, { recursive: true, force: true }); }
