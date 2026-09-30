import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { configureFsSafeNative } from "../dist/index.js";
import { retainEntryForPublication } from "../dist/advanced.js";
assert.equal(process.platform, "win32");
configureFsSafeNative({ mode: "require" });
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.argv[2], "publication-")));
const source = path.join(root, "source"), target = path.join(root, "target");
const stat = name => fs.lstatSync(name, { bigint: true });
try {
  fs.mkdirSync(source); fs.mkdirSync(target); fs.writeFileSync(path.join(source, "entry"), "preserved");
  const original = stat(path.join(source, "entry"));
  assert.throws(() => retainEntryForPublication({
    source: { parent: { path: source, identity: stat(source) }, basename: "entry", expected: { ...original, kind: "file" } },
    destination: { parent: { path: target, identity: stat(target) }, basename: "entry" }, assertBeforeMutation() { throw new Error("must not dispatch"); },
  }), error => {
    assert.equal(error.details.result.transition, "not-published"); assert.equal(error.details.result.resources, "closed");
    // FAT may not expose a known exact inode at all. Both original-identity and
    // native filesystem refusal are required pre-effect admission, never success.
    assert.ok(error.code === "path-mismatch" || error.cause?.code === "ENOTSUP"); return true;
  });
  assert.equal(fs.readFileSync(path.join(source, "entry"), "utf8"), "preserved"); assert.deepEqual(fs.readdirSync(target), []);
  console.log(JSON.stringify({ filesystem: "FAT", transition: "not-published", resources: "closed", sourcePreserved: true }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
