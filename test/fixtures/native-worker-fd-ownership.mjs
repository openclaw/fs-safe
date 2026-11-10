import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { root } from "../../dist/root.js";
import { createRootFileOpenBatchSync, stageFileInDirectory, writeSiblingTempFile } from "../../dist/advanced.js";
import { configureFsSafeNative } from "../../dist/config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../../dist/native.js";

const { directory } = workerData;
const warnings = [];
const completed = [];
let failure;
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

await scoped.write("policy/nested/write.txt", "policy", { mutationSymlinks: "reject" });
assert.equal(await fs.readFile(path.join(directory, "policy/nested/write.txt"), "utf8"), "policy");
await assert.rejects(scoped.write("denied/nested/write.txt", "denied", {
  denyMutations: { paths: [path.join(directory, "denied")] },
}));
assert.equal(fsSync.existsSync(path.join(directory, "denied")), false);
completed.push("policy-parent-create", "policy-parent-denial");

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

if (process.platform === "win32") {
  const native = __loadBundledNativeForTest();
  assert.equal(typeof native.openBeneath, "function");
  const binary = createRequire(import.meta.url).resolve(`@openclaw/fs-safe-win32-${process.arch}-msvc`);
  const nativeIdentity = {
    node: process.version, napi: process.versions.napi, modules: process.versions.modules,
    binarySha256: createHash("sha256").update(fsSync.readFileSync(binary)).digest("hex"),
    nativeLoaded: process.report.getReport().sharedObjects.some(file => file.endsWith(".node") &&
      fsSync.realpathSync.native(file) === fsSync.realpathSync.native(binary)),
  };
  assert.equal(nativeIdentity.nativeLoaded, true);
  let leaf;
  let disableAfterOpen = false;
  const binding = {
    ...native,
    openBeneath(...args) {
      const opened = native.openBeneath(...args);
      assert.equal(args[1], "sentinel.txt");
      assert.equal(leaf, undefined);
      leaf = { fd: opened.fd, closes: 0 };
      if (disableAfterOpen) configureFsSafeNative({ mode: "off" });
      return opened;
    },
    closeOwnedFd(fd) {
      assert.equal(this, binding);
      assert.equal(fd, leaf.fd);
      assert.equal(++leaf.closes, 1);
      native.closeOwnedFd(fd);
    },
  };
  __setNativeLoaderForTest(() => binding);
  const options = { rootPath: directory, absolutePath: path.join(directory, "sentinel.txt"), boundaryLabel: "Worker read" };
  const reportLeaf = scenario => {
    let leafClosed = false;
    try { fsSync.fstatSync(leaf.fd); }
    catch (error) { if (error.code !== "EBADF") throw error; leafClosed = true; }
    parentPort.postMessage({ kind: "batch-read", scenario, originCloses: leaf.closes, leafClosed, ...nativeIdentity });
  };
  try {
    if (workerData.batchReadScenario !== "rejection") {
      const batch = createRootFileOpenBatchSync();
      try {
        const opened = batch.openFile(options);
        assert.equal(opened.ok, true);
        assert.equal(opened.fd, leaf.fd); // A fallback cannot supply this native receipt.
        configureFsSafeNative({ mode: "off" });
        batch.close();
        batch[Symbol.dispose]();
        assert.equal(leaf.closes, 0);
        assert.equal(fsSync.readFileSync(opened.fd, "utf8"), "node-owned");
        if (opened.close) { opened.close(); opened.close(); }
        else fsSync.closeSync(opened.fd); // Exercise the existing consumer on the pre-fix base.
        reportLeaf("transfer");
        assert.equal(leaf.closes, 1, "native batch-read transfer bypassed originating closer");
        assert.throws(() => fsSync.fstatSync(opened.fd), { code: "EBADF" });
      } finally { batch.close(); }
      completed.push("batch-read-transfer");
    }

    if (workerData.batchReadScenario !== "transfer") {
      configureFsSafeNative({ mode: "require" });
      leaf = undefined;
      disableAfterOpen = true;
      const rejectedBatch = createRootFileOpenBatchSync();
      try {
        const rejected = rejectedBatch.openFile({ ...options, maxBytes: 0 });
        assert.equal(rejected.ok, false);
        assert.equal(rejected.reason, "validation");
        assert.equal(rejected.error.code, "too-large");
        reportLeaf("rejection");
        assert.equal(leaf.closes, 1, "native batch-read rejection bypassed originating closer");
        assert.throws(() => fsSync.fstatSync(leaf.fd), { code: "EBADF" });
        rejectedBatch.close();
        assert.equal(leaf.closes, 1);
      } finally { rejectedBatch.close(); }
      completed.push("batch-read-rejection");
    }
  } catch (error) {
    if (!workerData.batchReadScenario) throw error;
    failure = { code: error.code, message: error.message };
    process.exitCode = 1;
  } finally {
    __resetNativeLoaderForTest();
    configureFsSafeNative({ mode: "require" });
  }
}

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
parentPort.postMessage({ kind: "result", completed, warnings, failure });
// Intentionally leave the Node-owned sentinel to the default Worker fd tracker.
