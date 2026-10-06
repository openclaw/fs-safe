import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { root, isNoReplaceUnsupported } from "../../dist/index.js";
import { __setNativeLoaderForTest } from "../../dist/native.js";

__setNativeLoaderForTest(() => createRequire(import.meta.url)(process.argv[2]));
const fault = process.argv[3];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-move-partial-"));
try {
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  fs.writeFileSync(source, "source");
  const before = fs.lstatSync(source, { bigint: true });
  await assert.rejects((await root(directory)).move("source", "target"), error => {
    if (fault === "linkat") {
      assert(isNoReplaceUnsupported(error));
      assert.equal(error.details.fallbackCapability, "linkat");
      assert.match(error.message, /RENAME_NOREPLACE.*linkat/);
      assert(!fs.existsSync(target));
    } else {
      assert(!isNoReplaceUnsupported(error));
      assert.equal(error.code, "helper-failed");
      assert.equal(error.details.publication, "published");
      assert.equal(error.details.sourceRemoval, "still-linked");
      assert.match(error.message, /source still linked/);
      const published = fs.lstatSync(target, { bigint: true });
      assert.equal(published.ino, before.ino);
      assert.equal(published.nlink, 2n);
    }
    assert.equal(fs.lstatSync(source, { bigint: true }).ino, before.ino);
    assert.equal(fs.readFileSync(source, "utf8"), "source");
    return true;
  });
  console.log("move fallback partial state: passed");
} finally {
  // unlink(2), not the denied descriptor-relative unlinkat(2).
  for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
  fs.rmdirSync(directory);
}
