import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isMainThread, parentPort } from "node:worker_threads";
import { configureFsSafeNative } from "../../dist/config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, getNativeBinding } from "../../dist/native.js";
import { createNativeExclusiveFile } from "../../dist/native-operations.js";
import { sha256File } from "../../dist/file-hash.js";
import { copyTree, probeTreeClone } from "../../dist/copy.js";
import { root } from "../../dist/root.js";
import { getPinnedWriteNativeBinding, runPinnedWriteNative } from "../../dist/native-pinned-write.js";

export async function partialBindingProof() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-partial-native-"));
  const input = path.join(directory, "input");
  const contents = "partial binding fixture";
  await fs.writeFile(input, contents);
  const completed = [];
  const partial = { closeOwnedFd() { throw new Error("no native descriptor was allocated"); } };
  try {
    configureFsSafeNative({ mode: "auto" });
    __setNativeLoaderForTest(() => partial);
    assert.equal(await createNativeExclusiveFile(path.join(directory, "unused"), 0o600), undefined);
    assert.equal(probeTreeClone(directory), undefined);
    assert.deepEqual(await sha256File(input), {
      bytes: Buffer.byteLength(contents), digest: createHash("sha256").update(contents).digest("hex"),
    });
    completed.push("auto-open", "auto-probe", "auto-hash");
    const scoped = await root(directory);
    await scoped.write("nested/output", contents);
    assert.equal(await fs.readFile(path.join(directory, "nested/output"), "utf8"), contents);
    completed.push("auto-write");
    const source = path.join(directory, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "file"), contents);
    await copyTree(source, path.join(directory, "copy"));
    assert.equal(await fs.readFile(path.join(directory, "copy/file"), "utf8"), contents);
    completed.push("auto-tree-copy");

    configureFsSafeNative({ mode: "require" });
    for (const [name, operation] of [
      ["open", () => createNativeExclusiveFile(path.join(directory, "must-not-exist"), 0o600)],
      ["probe", () => probeTreeClone(directory)],
      ["hash", () => sha256File(input)],
      ["write", () => scoped.write("must-not-exist", contents)],
      ["tree-copy", () => copyTree(source, path.join(directory, "must-not-exist"))],
    ]) {
      await assert.rejects(async () => operation(), { code: "helper-unavailable" });
      completed.push(`require-${name}`);
    }
    await assert.rejects(fs.stat(path.join(directory, "must-not-exist")), { code: "ENOENT" });

    for (const mode of ["auto", "require"]) {
      configureFsSafeNative({ mode });
      const sentinel = new Error("native operation failed after dispatch");
      __setNativeLoaderForTest(() => ({ ...partial, sha256File() { throw sentinel; } }));
      await assert.rejects(sha256File(input), error => error === sentinel);
      completed.push(`${mode}-terminal-error`);
    }
    configureFsSafeNative({ mode: "auto" });
    let called = false;
    __setNativeLoaderForTest(() => ({ ...partial, probeTreeClone() { called = true; return null; } }));
    assert.equal(getNativeBinding("probeTreeClone", "cloneTree"), undefined);
    assert.equal(called, false);
    completed.push("complete-capability-set");

    const unavailable = () => assert.fail("incomplete copy binding must not be dispatched");
    const writeOnly = {
      closeOwnedFd: unavailable, openBeneath: unavailable, mkdirBeneath: unavailable,
      renameNoReplace: unavailable, renameReplace: unavailable, fstatIdentity: unavailable,
      createStagedFile: unavailable, stagedFileMatches: unavailable, removeStagedFile: unavailable,
    };
    const handle = await fs.open(input, "r");
    try {
      const file = { kind: "file", handle, size: Buffer.byteLength(contents), clone: "never", async verifySource() {} };
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        for (const platform of ["win32", "linux"]) {
          Object.defineProperty(process, "platform", { value: platform });
          __setNativeLoaderForTest(() => writeOnly);
          configureFsSafeNative({ mode: "auto" });
          assert.equal(getPinnedWriteNativeBinding({ input: file }), undefined);
          assert.equal(getPinnedWriteNativeBinding({ input: { kind: "buffer", data: contents } }), writeOnly);
          assert.equal(getPinnedWriteNativeBinding({ input: { kind: "stream", stream: [] } }), writeOnly);
          assert.equal(getPinnedWriteNativeBinding({ input: file, private: true }), writeOnly);
          assert.equal(getPinnedWriteNativeBinding({ input: file, verifyPosixMode: true }), platform === "win32" ? undefined : writeOnly);
          configureFsSafeNative({ mode: "require" });
          assert.throws(() => getPinnedWriteNativeBinding({ input: file }), { code: "helper-unavailable" });
          await assert.rejects(runPinnedWriteNative(writeOnly, { input: file }, unavailable), { code: "helper-unavailable" });
          completed.push(`copy-capabilities-${platform}`);
        }
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
      }
      configureFsSafeNative({ mode: "auto" });
      __setNativeLoaderForTest(() => writeOnly);
      await scoped.copyIn("copy-parent/output", input, { mkdir: true, durable: false });
      assert.equal(await fs.readFile(path.join(directory, "copy-parent/output"), "utf8"), contents);
      completed.push("auto-copy-in");
      configureFsSafeNative({ mode: "require" });
      await assert.rejects(scoped.copyIn("missing-parent/output", input, { mkdir: true, durable: false }), { code: "helper-unavailable" });
      await assert.rejects(fs.stat(path.join(directory, "missing-parent")), { code: "ENOENT" });
      completed.push("require-copy-in");
    } finally {
      await handle.close();
    }
    return completed;
  } finally {
    __resetNativeLoaderForTest();
    configureFsSafeNative({ mode: "auto" });
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (!isMainThread) parentPort.postMessage(await partialBindingProof());
