import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "../dist/root.js";
import { watch } from "../dist/watch.js";
import { getNativeBinding } from "../dist/native.js";

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-events-")));
assert.ok(!directory.includes("/claude-501/"), "event proof requires normal temporary storage");
await fs.writeFile(path.join(directory, "file"), "before");
// Separate fixture creation from the edits being measured; FSEvents coalesces creation records.
if (process.platform === "darwin") await new Promise(resolve => setTimeout(resolve, 3000));
const admitted = await root(directory);
const relative = "file";
let deliver;
const owner = watch(admitted, { mode: "auto", scopes: [{ path: relative, kind: "entry" }], intervalMs: 60_000,
  onInvalidate: value => { if (!value.changes || value.changes.some(change => change.path === relative)) deliver?.(); } });
try {
  await owner.ready;
  assert.equal(owner.health().mode, "events");
  const latencyMs = [];
  for (let i = 0; i < 3; i++) {
    let timer;
    const event = new Promise((resolve, reject) => {
      deliver = resolve;
      timer = setTimeout(() => reject(new Error("native event exceeded one second")), 1000);
    });
    void event.catch(() => {});
    const started = performance.now();
    try {
      await fs.writeFile(path.join(directory, "file"), "edit-" + i);
      await event;
      latencyMs.push(performance.now() - started);
      assert.ok(latencyMs.at(-1) < 1000);
      assert.equal(await admitted.readText(relative), "edit-" + i);
    } finally { clearTimeout(timer); deliver = undefined; }
  }
  await owner.close();
  assert.equal(getNativeBinding().watchThreadCount(), 0);
  console.log(JSON.stringify({ proof: "native-watch-edits", platform: process.platform, mode: "events", latencyMs, hubThreadsAfterClose: 0 }));
} finally { await owner.close(); await fs.rm(directory, { recursive: true, force: true }); }
