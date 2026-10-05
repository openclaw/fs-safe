import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { root } from "../../dist/root.js";
import { stageFileInDirectory } from "../../dist/advanced.js";
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
  // Native-only publication contracts must reject with the named capability.
  await assert.rejects(scoped.move("b.md", "moved.md"), { code: "helper-unavailable" });
  assert.equal(await scoped.readText("b.md"), "x");
  const staged = await stageFileInDirectory({ directory: base, content: "stage" });
  await assert.rejects(staged.publish("published.md", { overwrite: false }), { code: "helper-unavailable" });
  assert.equal((await staged.cleanup()).status, "removed");
  assert(!fs.readdirSync(base).some(name => name.startsWith(".fs-safe-")));
  console.log("renameat2 fallback: passed");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
