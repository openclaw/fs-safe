import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMainThread, parentPort } from "node:worker_threads";
import { __loadBundledNativeForTest } from "../dist/native.js";

export async function proveCanonicalization() {
  const native = __loadBundledNativeForTest();
  if (process.platform === "freebsd") {
    assert.deepEqual(Object.keys(native).sort(), ["canonicalizePath", "closeOwnedFd", "createPipe"]);
  }
  const directory = await fs.mkdtemp(path.join(tmpdir(), "fs-safe-canonical-proof-"));
  try {
    const file = path.join(directory, "file");
    const link = path.join(directory, "link");
    await fs.writeFile(file, "canonical fixture");
    await fs.symlink("file", link);
    for (const ordinary of [false, true]) {
      assert.equal(native.canonicalizePath(link, ordinary).path, await fs.realpath(file));
      assert.equal(native.canonicalizePath(path.join(directory, "missing"), ordinary).errno, 2);
    }
    return ["canonicalize-link", "canonicalize-missing"];
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
if (!isMainThread) parentPort.postMessage(await proveCanonicalization());
