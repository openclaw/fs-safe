import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { root } from "../../dist/root.js";
import { configureFsSafeNative } from "../../dist/config.js";
import { __loadBundledNativeForTest } from "../../dist/native.js";
import { copyTree, probeTreeClone } from "../../dist/copy.js";
import { readWindowsFileExtents } from "../../dist/test-hooks.js";

function assertClonedData(source, destination, clusterSize) {
  const expected = fs.readFileSync(source);
  assert.deepEqual(fs.readFileSync(destination), expected);
  assert.equal(fs.statSync(destination).size, expected.length);
  const original = readWindowsFileExtents(source);
  const copied = readWindowsFileExtents(destination);
  const lcnAt = (extents, vcn) => {
    const extent = extents.find(value => value.vcn <= vcn && vcn < value.vcn + value.clusters);
    assert.ok(extent && extent.lcn >= 0n, `missing allocated cluster ${vcn}`);
    return extent.lcn + vcn - extent.vcn;
  };
  // ReFS may copy the final partial cluster even after a rounded clone request.
  // Check every complete cluster, independently of extent coalescing or fragmentation.
  for (let vcn = 0n; vcn < BigInt(Math.floor(expected.length / clusterSize)); vcn++) {
    assert.equal(lcnAt(copied, vcn), lcnAt(original, vcn), `${path.basename(source)} full cluster ${vcn}`);
  }
}

async function prove() {
  assert.equal(process.platform, "win32");
  configureFsSafeNative({ mode: "require" });
  assert.equal(typeof __loadBundledNativeForTest().copyFileExclusive, "function");
  const parent = process.env.FS_SAFE_CLONE_TEST_ROOT;
  assert.ok(parent, "explicit real ReFS volume required");
  assert.equal(probeTreeClone(parent), "refs");
  const directory = fs.mkdtempSync(path.join(parent, "copy-in-"));
  const ordinary = fs.mkdtempSync(path.join(os.tmpdir(), "copy-in-ntfs-"));
  let cases = 0;
  try {
    const sourceDir = path.join(directory, "source");
    const targetDir = path.join(directory, "target");
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(targetDir);
    const target = await root(targetDir);
    const sourceRoot = await root(sourceDir);
    const source = path.join(sourceDir, "payload");
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    fs.writeFileSync(source, bytes);
    let receipt;
    await target.copyIn("cloned", { root: sourceRoot, relativePath: "payload" }, {
      clone: "always", overwrite: false, maxBytes: bytes.length,
      onDestinationPublished(value) { receipt = value; },
    });
    const cloned = path.join(targetDir, "cloned");
    assert.deepEqual(fs.readFileSync(cloned), bytes);
    const sourceExtents = readWindowsFileExtents(source);
    assert.ok(sourceExtents.some(extent => extent.lcn >= 0n));
    assert.deepEqual(readWindowsFileExtents(cloned), sourceExtents);
    const stat = fs.statSync(cloned, { bigint: true });
    assert.notEqual(stat.ino, fs.statSync(source, { bigint: true }).ino);
    assert.ok(Object.isFrozen(receipt));
    assert.deepEqual(receipt, { path: cloned, dev: stat.dev, ino: stat.ino });
    cases++;

    const fd = fs.openSync(cloned, "r+");
    try { fs.writeSync(fd, Buffer.from([0x11]), 0, 1, 0); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    assert.deepEqual(fs.readFileSync(source), bytes);
    assert.notDeepEqual(readWindowsFileExtents(cloned), readWindowsFileExtents(source));
    await assert.rejects(target.copyIn("cloned", source, { clone: "always", overwrite: false }), { code: "already-exists" });
    assert.equal(fs.readFileSync(cloned)[0], 0x11);
    cases++;

    const clusterSize = fs.statfsSync(parent).bsize;
    assert.ok(Number.isSafeInteger(clusterSize) && clusterSize > 0);
    for (const size of [0, 1, clusterSize - 1, clusterSize + 1, 4 * 1024 * 1024 + 1]) {
      const partial = path.join(sourceDir, `partial-${size}`);
      const content = Buffer.alloc(size, 0x37);
      fs.writeFileSync(partial, content);
      await target.copyIn(`partial-${size}`, partial, { clone: "always", overwrite: false });
      assertClonedData(partial, path.join(targetDir, `partial-${size}`), clusterSize);
    }
    const tree = path.join(directory, "tree");
    await copyTree(sourceDir, tree, { clone: "always" });
    for (const name of fs.readdirSync(sourceDir)) {
      assertClonedData(path.join(sourceDir, name), path.join(tree, name), clusterSize);
    }
    cases++;

    await assert.rejects(target.copyIn("too-large", source, { clone: "always", maxBytes: bytes.length - 1 }), { code: "too-large" });
    assert.equal(fs.existsSync(path.join(targetDir, "too-large")), false);
    cases++;

    await assert.rejects(target.copyIn("cancelled", source, { clone: "always", signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
    assert.equal(fs.existsSync(path.join(targetDir, "cancelled")), false);
    cases++;

    // Refuse publication after native data transfer has completed, and remove its stage.
    const cancelDir = path.join(directory, "cancel");
    fs.mkdirSync(cancelDir);
    const cancelRoot = await root(cancelDir);
    const controller = new AbortController();
    await assert.rejects(cancelRoot.copyIn("cancelled", source, {
      clone: "always", signal: controller.signal,
      assertBeforeMutation() {
        if (fs.readdirSync(cancelDir).some(name => name.startsWith(".fs-safe-"))) controller.abort(new Error("cancel after clone"));
      },
    }), /cancel after clone/);
    assert.deepEqual(fs.readdirSync(cancelDir), []);
    cases++;

    const guardedDir = path.join(directory, "guarded");
    fs.mkdirSync(guardedDir);
    const guarded = await root(guardedDir);
    let revoked = false;
    const guard = () => { if (revoked) throw new Error("authority revoked"); };
    await guarded.copyIn("first", source, { clone: "always", assertBeforeMutation: guard, onDestinationPublished() { revoked = true; } });
    await assert.rejects(guarded.copyIn("second", source, { clone: "always", assertBeforeMutation: guard }), /authority revoked/);
    assert.deepEqual(fs.readdirSync(guardedDir), ["first"]);
    cases++;

    const streams = path.join(sourceDir, "streams");
    fs.writeFileSync(streams, "unnamed");
    fs.writeFileSync(`${streams}:secret`, "must not lose this stream");
    for (const clone of ["auto", "always"]) {
      await assert.rejects(target.copyIn(`streams-${clone}`, streams, { clone }), { code: "helper-failed" });
      assert.equal(fs.existsSync(path.join(targetDir, `streams-${clone}`)), false);
    }
    cases++;

    const ntfsSource = path.join(ordinary, "source");
    fs.writeFileSync(ntfsSource, bytes);
    assert.equal(probeTreeClone(ordinary), undefined);
    const ntfsRoot = await root(ordinary);
    await assert.rejects(ntfsRoot.copyIn("unsupported", ntfsSource, { clone: "always" }), { code: "unsupported-platform" });
    await ntfsRoot.copyIn("automatic", ntfsSource, { clone: "auto" });
    assert.deepEqual(fs.readFileSync(path.join(ordinary, "automatic")), bytes);
    await target.copyIn("cross-volume", ntfsSource, { clone: "auto" });
    assert.deepEqual(fs.readFileSync(path.join(targetDir, "cross-volume")), bytes);
    await assert.rejects(target.copyIn("cross-always", ntfsSource, { clone: "always" }), { code: "unsupported-platform" });
    assert.equal(fs.existsSync(path.join(targetDir, "cross-always")), false);
    cases++;
    assert.ok(!fs.readdirSync(targetDir).some(name => name.startsWith(".fs-safe-")));
    return { platform: process.platform, arch: process.arch, mode: isMainThread ? "main" : "worker", cases, clusterSize, sharedPrefixBytes: 4 * 1024 * 1024, sharedExtents: sourceExtents.length };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(ordinary, { recursive: true, force: true });
  }
}

if (isMainThread && process.argv[2] === "worker") {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", result => console.log(JSON.stringify(result)));
  worker.on("error", error => { throw error; });
  worker.on("exit", code => { if (code) process.exitCode = code; });
} else {
  const result = await prove();
  if (parentPort) parentPort.postMessage(result);
  else console.log(JSON.stringify(result));
}
