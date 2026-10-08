// Run with a built checkout path; compare interleaved processes against the same fixture shape.
import { createHook } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const checkout = path.resolve(process.argv[2] ?? ".");
const { createDirectoryIdentityGuard, assertDirectoryIdentityGuard } = await import(pathToFileURL(path.join(checkout, "dist/archive-staging.js")));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-guard-benchmark-"));
try {
  const guard = await createDirectoryIdentityGuard(dir);
  const iterations = 10000;
  async function run() {
    for (let i = 0; i < iterations; i++) {
      const pending = assertDirectoryIdentityGuard(guard);
      if (pending) await pending;
    }
  }
  await run();
  const start = performance.now();
  await run();
  const ms = performance.now() - start;
  let promises = 0, lstats = 0, realpaths = 0;
  const lstat = fs.lstatSync, realpath = fs.realpathSync.native;
  fs.lstatSync = (...args) => { lstats++; return lstat(...args); };
  fs.realpathSync.native = (...args) => { realpaths++; return realpath(...args); };
  const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
  hook.enable();
  await run();
  hook.disable();
  fs.lstatSync = lstat;
  fs.realpathSync.native = realpath;
  console.log(JSON.stringify({ iterations, ms, promises: promises - 2, lstats, realpaths }));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
