import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { publishFileExclusive, pinDirectory } from "../../dist/durability.js";
import { isNoReplaceUnsupported } from "../../dist/errors.js";
import { __setNativeLoaderForTest } from "../../dist/native.js";

const native = createRequire(import.meta.url)(process.argv[2]);
const scenario = process.argv[3];
// Parent owns cleanup even on ARM, where unlink uses the denied unlinkat.
const directory = process.argv[4];
assert(directory);
fs.mkdirSync(directory);
fs.mkdirSync(path.join(directory, "payload"));
const sourcePath = path.join(directory, "source");
const targetPath = path.join(directory, "payload", "0");
fs.writeFileSync(sourcePath, "complete snapshot");
const before = fs.lstatSync(sourcePath, { bigint: true });
if (scenario === "collision") fs.writeFileSync(targetPath, "competitor");
__setNativeLoaderForTest(() => ({ ...native, renameNoReplace(...args) {
  try { return native.renameNoReplace(...args); }
  catch (error) {
    if (scenario === "source-swap") {
      fs.renameSync(sourcePath, path.join(directory, "saved"));
      fs.writeFileSync(sourcePath, "replacement");
    }
    throw error;
  }
} }));
const parent = await pinDirectory(path.dirname(targetPath));
try {
  const publish = () => publishFileExclusive({ sourcePath, targetPath, expectedSourceIdentity: before,
    parentReceipt: parent.receipt, strategy: "rename-noreplace" });
  if (scenario === "auto") {
    const result = await publish();
    assert.equal(result.method, "rename-noreplace");
    assert.equal(result.fallback, "link-unlink");
    assert.equal(result.directorySync.status, "synced");
    assert(!fs.existsSync(sourcePath));
    assert.equal(fs.readFileSync(targetPath, "utf8"), "complete snapshot");
    const after = fs.lstatSync(targetPath, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.nlink, 1n);
    // The manifest seal uses a sibling rename instead of crossing parents.
    const seal = await publishFileExclusive({ sourcePath: targetPath, targetPath: path.join(directory, "payload", "manifest.json"),
      expectedSourceIdentity: after, parentReceipt: parent.receipt, strategy: "rename-noreplace" });
    assert.equal(seal.fallback, "link-unlink");
    assert(!fs.existsSync(targetPath));
    // Link strategies do not depend on renameat2, and keep their source name.
    for (const strategy of ["link-required", "link-or-copy"]) {
      const source = path.join(directory, strategy);
      fs.writeFileSync(source, strategy);
      const result = await publishFileExclusive({ sourcePath: source, targetPath: `${source}.target`, strategy });
      assert.equal(result.method, "hardlink");
      assert.equal(result.fallback, undefined);
      assert.equal(fs.lstatSync(source).nlink, 2);
    }
  } else {
    await assert.rejects(publish(), error => {
      if (scenario === "require" || scenario === "linkat") {
        assert(isNoReplaceUnsupported(error));
        assert.equal(error.code, "helper-unavailable");
        if (scenario === "linkat") {
          assert.equal(error.details.fallbackCapability, "linkat");
          assert.match(error.message, /RENAME_NOREPLACE.*linkat/);
        }
        assert(!fs.existsSync(targetPath));
      } else if (scenario === "collision") {
        assert.equal(error.code, "already-exists");
        assert.equal(fs.readFileSync(targetPath, "utf8"), "competitor");
      } else if (scenario === "source-swap") {
        assert.equal(error.code, "path-mismatch");
        assert(!fs.existsSync(targetPath));
        assert.equal(fs.readFileSync(sourcePath, "utf8"), "replacement");
        assert.equal(fs.readFileSync(path.join(directory, "saved"), "utf8"), "complete snapshot");
      } else {
        assert.equal(error.code, "helper-failed");
        assert.equal(error.details.fallback, "link-unlink");
        assert.equal(error.details.publication, "published");
        assert.equal(error.details.sourceRemoval, "still-linked");
        assert.equal(error.details.targetCreated, true);
        assert.equal(error.details.cleanup, "preserved");
        assert.match(error.message, /source still linked/);
        for (const name of [sourcePath, targetPath]) {
          const current = fs.lstatSync(name, { bigint: true });
          assert.equal(current.ino, before.ino);
          assert.equal(current.nlink, 2n);
        }
      }
      return true;
    });
    if (scenario !== "source-swap") assert.equal(fs.readFileSync(sourcePath, "utf8"), "complete snapshot");
  }
  console.log("publication fallback: passed");
} finally { await parent.close(); }
