import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { root } from "../../dist/root.js";
import { configureFsSafeNative } from "../../dist/config.js";
import { getNativeBinding, __setNativeLoaderForTest } from "../../dist/native.js";

configureFsSafeNative({ mode: "require" });
const binding = getNativeBinding("openBeneath", "closeOwnedFd");
assert(binding);
const warnings = [];
process.on("warning", warning => warnings.push(warning.message));
const sentinel = fs.openSync(path.join(workerData.directory, "sentinel"), "r");
parentPort.postMessage({ kind: "sentinel", fd: sentinel });
const safe = await root(workerData.directory);
let nativeCloses = 0;
let transferred;
__setNativeLoaderForTest(() => ({ ...binding,
  verifyRootDirectory() {
    const parent = fs.openSync(workerData.directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try { transferred = binding.openBeneath(parent, "", fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0)).fd; }
    finally { fs.closeSync(parent); }
    return { fallbackFd: transferred };
  },
  closeOwnedFd(fd) {
    if (fd === transferred) nativeCloses++;
    return binding.closeOwnedFd(fd);
  },
}));
await safe.ensureRoot();
assert.equal(fs.readFileSync(sentinel, "utf8"), "node-owned");
await new Promise(resolve => setImmediate(resolve));
parentPort.postMessage({ nativeCloses, warnings });
// Worker exit must still close its own sentinel through Node's fd tracker.
