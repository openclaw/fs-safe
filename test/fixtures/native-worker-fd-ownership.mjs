import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { root } from "../../dist/root.js";
import { stageFileInDirectory, writeSiblingTempFile } from "../../dist/advanced.js";
import { configureFsSafeNative } from "../../dist/config.js";

const { directory } = workerData;
const warnings = [];
const completed = [];
process.on("warning", (warning) => warnings.push(warning.message));
configureFsSafeNative({ mode: "require" });

// Node must retain and eventually close its own descriptors even as native
// operations repeatedly allocate and release descriptors in the same Worker.
const sentinel = fsSync.openSync(path.join(directory, "sentinel.txt"), "r");
parentPort.postMessage({ kind: "sentinel", fd: sentinel });
const scoped = await root(directory);

await scoped.write("deep/nested/write.txt", "write");
assert.equal(await fs.readFile(path.join(directory, "deep/nested/write.txt"), "utf8"), "write");
completed.push("write");

await scoped.create("created.txt", "create");
await scoped.create("stream.txt", (async function* () { yield Buffer.from("stream"); })());
assert.equal(await fs.readFile(path.join(directory, "stream.txt"), "utf8"), "stream");
completed.push("create", "create-stream");

await scoped.append("appended.txt", "a");
await scoped.append("appended.txt", "b");
assert.equal(await fs.readFile(path.join(directory, "appended.txt"), "utf8"), "ab");
completed.push("append");

const writable = await scoped.openWritable("writable.txt");
try {
  await writable.handle.writeFile("writable");
} finally {
  configureFsSafeNative({ mode: "off" });
  try { await writable.handle.close(); }
  finally { configureFsSafeNative({ mode: "require" }); }
}
assert.equal(await fs.readFile(path.join(directory, "writable.txt"), "utf8"), "writable");
completed.push("open-writable");

await scoped.copyIn("copied.txt", path.join(directory, "sentinel.txt"));
assert.equal(await fs.readFile(path.join(directory, "copied.txt"), "utf8"), "node-owned");
completed.push("copy-in");

await scoped.move("created.txt", "moved.txt");
assert.equal(await fs.readFile(path.join(directory, "moved.txt"), "utf8"), "create");
await assert.rejects(fs.stat(path.join(directory, "created.txt")), { code: "ENOENT" });
completed.push("move");

await writeSiblingTempFile({
  dir: directory,
  chmodDir: false,
  producerIsolation: "private-directory",
  writeTemp: (temporary) => fs.writeFile(temporary, "completion", { flag: "wx" }),
  resolveFinalPath: () => path.join(directory, "sibling.txt"),
});
assert.equal(await fs.readFile(path.join(directory, "sibling.txt"), "utf8"), "completion");
completed.push("private-sibling");

await assert.rejects(scoped.create("moved.txt", "replacement"), { code: "already-exists" });
assert.equal(await fs.readFile(path.join(directory, "moved.txt"), "utf8"), "create");
completed.push("create-collision");

if (process.platform !== "win32") {
  const staged = await stageFileInDirectory({ directory, content: "staged" });
  try {
    await staged.publish("staged.txt", { overwrite: false });
  } finally {
    configureFsSafeNative({ mode: "off" });
    try { assert.equal((await staged.cleanup()).resources, "closed"); }
    finally { configureFsSafeNative({ mode: "require" }); }
  }
  assert.equal(await fs.readFile(path.join(directory, "staged.txt"), "utf8"), "staged");
  completed.push("node-parent-staging");
}

assert.equal(fsSync.readFileSync(sentinel, "utf8"), "node-owned");
await new Promise((resolve) => setImmediate(resolve));
parentPort.postMessage({ kind: "result", completed, warnings });
// Intentionally leave the Node-owned sentinel to the default Worker fd tracker.
