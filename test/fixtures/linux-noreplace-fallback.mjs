import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { root } from "../../dist/root.js";
import { stageFileInDirectory } from "../../dist/advanced.js";
import { movePathWithCopyFallback } from "../../dist/atomic.js";
import { __setNativeLoaderForTest } from "../../dist/native.js";

const native = createRequire(import.meta.url)(process.argv[2]);
let renames = 0;
__setNativeLoaderForTest(() => ({ ...native, renameNoReplace(...args) {
  renames++;
  return native.renameNoReplace(...args);
} }));
const base = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-noreplace-"));
try {
  const scoped = await root(base);
  // Exact issue #828 repro: replacement still works; create needs no-replace.
  await scoped.write("b.md", "x");
  if (process.env.FS_SAFE_NATIVE_MODE === "require") {
    await assert.rejects(scoped.create("a.md", "x"), error => {
      assert.equal(error.code, "helper-unavailable");
      assert.match(error.message, /renameat2 RENAME_NOREPLACE: (EINVAL|ENOSYS)/);
      return true;
    });
    assert.deepEqual(fs.readdirSync(base), ["b.md"]);
  } else {
    // Exercise a one-shot stream as the first rejected publication.
    let consumed = 0;
    await scoped.create("a.md", (async function* () { consumed++; yield Buffer.from("x"); })());
    assert.equal(consumed, 1);
    assert.equal(await scoped.readText("a.md"), "x");
    await scoped.create("cached.md", "cached");
    assert.equal(renames, 1);
    await assert.rejects(scoped.create("a.md", "clobber"), { code: "already-exists" });
    assert.equal(await scoped.readText("a.md"), "x");
    assert.deepEqual(fs.readdirSync(base).sort(), ["a.md", "b.md", "cached.md"]);
  }
  fs.mkdirSync(path.join(base, "directory"));
  fs.writeFileSync(path.join(base, "directory", "child"), "directory content");
  if (process.env.FS_SAFE_NATIVE_MODE === "require") {
    await assert.rejects(scoped.move("b.md", "moved.md"), { code: "helper-unavailable" });
    await assert.rejects(scoped.move("directory", "moved-directory"), { code: "helper-unavailable" });
    assert.equal(await scoped.readText("b.md"), "x");
  } else {
    const before = fs.lstatSync(path.join(base, "b.md"), { bigint: true });
    await scoped.move("b.md", "moved.md");
    const after = fs.lstatSync(path.join(base, "moved.md"), { bigint: true });
    assert.equal(before.ino, after.ino);
    assert.equal(after.nlink, 1n);
    await scoped.move("directory", "moved-directory");
    assert.equal(await scoped.readText("moved-directory/child"), "directory content");
    assert.equal(renames, 1); // moves reuse the publication device cache
    await assert.rejects(scoped.move("moved.md", "a.md"), { code: "already-exists" });
  }
  // The standalone public move API has a replacing-rename contract and does
  // not use NOREPLACE; the syscall filter must leave it available in both modes.
  fs.mkdirSync(path.join(base, "standalone"));
  fs.writeFileSync(path.join(base, "standalone", "child"), "standalone content");
  await movePathWithCopyFallback({ from: path.join(base, "standalone"), to: path.join(base, "standalone-moved") });
  assert.equal(fs.readFileSync(path.join(base, "standalone-moved", "child"), "utf8"), "standalone content");
  // Native-only publication contracts must still reject.
  const staged = await stageFileInDirectory({ directory: base, content: "stage" });
  await assert.rejects(staged.publish("published.md", { overwrite: false }), { code: "helper-unavailable" });
  assert.equal((await staged.cleanup()).status, "removed");
  assert(!fs.readdirSync(base).some(name => name.startsWith(".fs-safe-")));
  console.log("renameat2 fallback: passed");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
