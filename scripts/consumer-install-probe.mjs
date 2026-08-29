import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";

// Copied into each external consumer; all package resolution starts there.
const expected = JSON.parse(readFileSync("expected.json", "utf8"));
const require = createRequire(import.meta.url);
const consumer = realpathSync(process.cwd());
function insideConsumer(file) {
  const rel = relative(consumer, realpathSync(file));
  assert.ok(rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel),
    "package resolved outside consumer");
}
const rootManifest = require.resolve("@openclaw/fs-safe/package.json");
insideConsumer(rootManifest);
assert.deepEqual(JSON.parse(readFileSync(rootManifest, "utf8")), expected.rootPkg);
const rootRequire = createRequire(rootManifest);
const entry = require.resolve("@openclaw/fs-safe");
insideConsumer(entry);
assert.equal(createHash("sha256").update(readFileSync(entry)).digest("hex"), expected.entryHash);
const physical = new Set();
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) inspect(file);
    if (entry.isFile() && entry.name === "package.json") {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (expected.platforms.includes(pkg.name)) physical.add(pkg.name);
    }
  }
}
inspect(join(consumer, "node_modules"));
assert.deepEqual([...physical].sort(), expected.omitted ? [] : [expected.host.package]);
let binary;
for (const name of expected.platforms) {
  if (!expected.omitted && name === expected.host.package) {
    binary = rootRequire.resolve(name);
    insideConsumer(binary);
    const pkg = JSON.parse(readFileSync(join(dirname(binary), "package.json"), "utf8"));
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, expected.rootPkg.version);
    assert.equal(expected.rootPkg.optionalDependencies[name], pkg.version);
    assert.deepEqual(pkg.os, [process.platform]);
    assert.deepEqual(pkg.cpu, [process.arch]);
    if (expected.host.libc) assert.deepEqual(pkg.libc, [expected.host.libc]);
  } else {
    assert.throws(() => rootRequire.resolve(name), { code: "MODULE_NOT_FOUND" });
  }
}
if (expected.omitted) {
  for (const name of ["jszip", "tar"]) {
    assert.throws(() => rootRequire.resolve(name), { code: "MODULE_NOT_FOUND" });
  }
} else {
  for (const name of ["jszip", "tar"]) insideConsumer(rootRequire.resolve(name));
}
for (const subpath of Object.keys(expected.rootPkg.exports)) {
  if (subpath !== "./package.json") {
    await import(subpath === "." ? expected.rootPkg.name : expected.rootPkg.name + subpath.slice(1));
  }
}
writeFileSync("installed.json", JSON.stringify({
  root: expected.rootPkg.name, version: expected.rootPkg.version,
  nativePackages: [...physical], binary,
}));
