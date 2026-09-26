import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "../dist/root.js";
import { watch } from "../dist/watch.js";
import { getNativeBinding } from "../dist/native.js";

if (!process.argv.includes("--child")) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  process.stdout.write(child.stdout);
} else {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-joined-")));
  const owners = [];
  try {
    const admitted = await root(directory);
    for (let cycle = 0; cycle < 3; cycle++) {
      await fs.mkdir(path.join(directory, "a/b"), { recursive: true });
      const pair = [0, 1].map(() => watch(admitted, { mode: "events", scopes: [{ path: "a/b", kind: "tree" }], onInvalidate() {} }));
      owners.push(...pair); await Promise.all(pair.map(owner => owner.ready));
      assert.equal(getNativeBinding().watchThreadCount(), 1);
      for (let n = 0; n < 20; n++) fsSync.writeFileSync(path.join(directory, "a/b", String(n)), "queued");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      await Promise.all([fs.rm(path.join(directory, "a"), { recursive: true }), ...pair.map(owner => owner.close())]);
      assert.equal(getNativeBinding().watchThreadCount(), 0);
    }
    console.log(JSON.stringify({ proof: "watch-joined-process-exit", platform: process.platform, mode: "events", cycles: 3, hubThreadsAfterClose: 0 }));
  } finally {
    await Promise.all(owners.map(owner => owner.close()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
