import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Run against a built baseline and candidate, or pass the same dist twice for A/A.
const [baseline = "dist", candidate = baseline] = process.argv.slice(2);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-watch-budget-"));
let directories = 1, files = 0;
function populate(parent, depth) {
  if (!depth) return;
  for (let branch = 0; branch < 5; branch++) {
    const child = path.join(parent, `branch-${branch}`);
    fs.mkdirSync(child);
    directories++;
    for (let leaf = 0; leaf < 4; leaf++) {
      fs.writeFileSync(path.join(child, `file-${leaf}`), "synthetic fixture");
      files++;
    }
    populate(child, depth - 1);
  }
}
const load = async dist => {
  const module = name => import(pathToFileURL(path.resolve(dist, `${name}.js`)));
  const { root } = await module("root");
  const { watch } = await module("watch");
  const { configureFsSafeNative } = await module("native-config");
  configureFsSafeNative({ mode: "require" });
  return { capability: await root(directory), watch };
};
const originalRealpath = fs.realpathSync.native, originalLstat = fs.lstatSync;
let realpath = 0, lstat = 0;
try {
  populate(directory, 5);
  const libraries = { A: await load(baseline), B: await load(candidate) };
  fs.realpathSync.native = (...args) => { realpath++; return originalRealpath(...args); };
  fs.lstatSync = (...args) => { lstat++; return originalLstat(...args); };
  console.log(JSON.stringify({ node: process.version, platform: process.platform, directories, files }));
  for (const arm of "ABBA") {
    const { capability, watch } = libraries[arm];
    const owner = watch(capability, {
      mode: "poll", scopes: [{ path: "", kind: "tree" }],
      pollIntervalMs: 2_147_483_647, onInvalidate() {},
    });
    try {
      await owner.ready;
      for (let tick = 0; tick < 2; tick++) {
        realpath = 0; lstat = 0;
        const start = performance.now(), cpu = process.cpuUsage();
        await owner.reconcile();
        const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
        assert.equal(owner.health().directories, directories);
        assert.equal(owner.health().state, "ready");
        console.log(JSON.stringify({ arm, tick, realpath, lstat, elapsedMs,
          cpuMs: (used.user + used.system) / 1000 }));
      }
    } finally { await owner.close(); }
  }
} finally {
  fs.realpathSync.native = originalRealpath;
  fs.lstatSync = originalLstat;
  fs.rmSync(directory, { recursive: true, force: true });
}
