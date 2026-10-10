import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { root } from "../../dist/root.js";
import { configureFsSafeNative } from "../../dist/config.js";
import { copyTree, probeTreeClone } from "../../dist/copy.js";
import { readWindowsFileExtents } from "../../dist/test-hooks.js";

configureFsSafeNative({ mode: "require" });
const parent = process.env.FS_SAFE_CLONE_TEST_ROOT;
assert.equal(process.platform, "win32");
assert.ok(parent);
assert.equal(probeTreeClone(parent), "refs");
const directory = fs.mkdtempSync(path.join(parent, "tail-parity-"));
try {
  const source = path.join(directory, "source");
  const files = path.join(directory, "files");
  const tree = path.join(directory, "tree");
  fs.mkdirSync(source);
  fs.mkdirSync(files);
  const destination = await root(files);
  const cluster = fs.statfsSync(parent).bsize;
  for (const size of [1, cluster - 1, cluster + 1, 4 * 1024 * 1024 + 1]) {
    const name = `bytes-${size}`;
    fs.writeFileSync(path.join(source, name), Buffer.alloc(size, 0x37));
    await destination.copyIn(name, path.join(source, name), { clone: "always", overwrite: false });
  }
  await copyTree(source, tree, { clone: "always" });
  for (const name of fs.readdirSync(source)) {
    for (const copy of [files, tree]) {
      assert.deepEqual(fs.readFileSync(path.join(copy, name)), fs.readFileSync(path.join(source, name)));
    }
    console.log(JSON.stringify({
      arch: process.arch, cluster, name,
      source: readWindowsFileExtents(path.join(source, name)),
      copyIn: readWindowsFileExtents(path.join(files, name)),
      copyTree: readWindowsFileExtents(path.join(tree, name)),
    }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
