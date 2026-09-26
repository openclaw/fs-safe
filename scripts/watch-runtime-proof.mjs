import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "../dist/root.js";
import { watch } from "../dist/watch.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "watch-runtime-"));
const owners = [];
try {
  const admitted = await root(directory);
  const invalidations = [];
  const owner = watch(admitted, { mode: "auto", intervalMs: 20,
    scopes: [{ path: "file", kind: "entry" }], onInvalidate: value => { invalidations.push(value); } });
  owners.push(owner);
  await owner.ready;
  const expected = process.platform === "linux" && !process.versions.bun ? "events" : "poll";
  assert.equal(owner.health().mode, expected);
  invalidations.length = 0;
  await fs.writeFile(path.join(directory, "file"), "runtime proof");
  await owner.reconcile();
  assert.ok(invalidations.some(value => value.changes?.some(change => change.path === "file")));
  if (expected === "poll") {
    const events = watch(admitted, { mode: "events", scopes: [], onInvalidate() {} });
    owners.push(events);
    await assert.rejects(events.ready, { code: "helper-unavailable" });
  }
  await owner.close();
  console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", version: process.versions.bun ?? process.version, platform: process.platform, mode: expected, guardedEdit: true, joinedClose: true }));
} finally {
  await Promise.all(owners.map(owner => owner.close()));
  await fs.rm(directory, { recursive: true, force: true });
}
