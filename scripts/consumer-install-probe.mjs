import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

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
assert.equal(typeof expected.rootPkg.dependencies.jszip, "string", "portable ZIP is a required dependency");
insideConsumer(rootRequire.resolve("jszip"));
assert.throws(() => rootRequire.resolve("tar"), { code: "MODULE_NOT_FOUND" });
for (const subpath of Object.keys(expected.rootPkg.exports)) {
  if (subpath !== "./package.json") {
    await import(subpath === "." ? expected.rootPkg.name : expected.rootPkg.name + subpath.slice(1));
  }
}

const { resolvePathPrefixSync } = await import("@openclaw/fs-safe/advanced");
const prefixFixture = join(consumer, "path-prefix-proof");
mkdirSync(prefixFixture);
const canonicalPrefixFixture = realpathSync.native(prefixFixture);
const prefixLive = join(canonicalPrefixFixture, "live.txt");
writeFileSync(prefixLive, "path-prefix-live");
assert.deepEqual(resolvePathPrefixSync(prefixLive), {
  absolutePath: prefixLive,
  existingPath: realpathSync.native(prefixLive),
  unresolvedSegments: [],
});
const prefixMissing = join(canonicalPrefixFixture, "missing");
const rawMissingInput = `${canonicalPrefixFixture}${sep}missing${sep}..${sep}live.txt`;
function assertMissingPrefix(input, expectedAbsolutePath) {
  assert.deepEqual(resolvePathPrefixSync(input), {
    absolutePath: expectedAbsolutePath,
    existingPath: canonicalPrefixFixture,
    unresolvedSegments: ["missing", "..", "live.txt"],
  });
}
assertMissingPrefix(rawMissingInput, rawMissingInput);
if (process.platform === "win32") {
  const driveRoot = parse(rawMissingInput).root;
  assert.match(driveRoot, /^[A-Za-z]:\\$/);
  const rootRelativeInput = rawMissingInput.slice(driveRoot.length - sep.length);
  const currentDriveRoot = resolve(sep);
  const rootedAbsoluteInput = `${currentDriveRoot}${currentDriveRoot.endsWith(sep) ? "" : sep}${rootRelativeInput.slice(sep.length)}`;
  assertMissingPrefix(rootRelativeInput, rootedAbsoluteInput);
  assertMissingPrefix(rootRelativeInput.replaceAll("\\", "/"), rootedAbsoluteInput);
}
assert.equal(readFileSync(prefixLive, "utf8"), "path-prefix-live");
assert.equal(existsSync(prefixMissing), false);

writeFileSync("installed.json", JSON.stringify({
  root: expected.rootPkg.name, version: expected.rootPkg.version,
  nativePackages: [...physical], binary,
}));

// The bundled TAR parser works even in an install with every optional omitted.
const { configureFsSafeNative } = await import("@openclaw/fs-safe/config");
const { extractArchive, readArchiveEntry } = await import("@openclaw/fs-safe/archive");
configureFsSafeNative({ mode: "off" });
const header = Buffer.alloc(512);
header.write("雪.txt");
header.write("0000644\0", 100);
header.write("00000000003\0", 124);
header[156] = 48;
header.fill(32, 148, 156);
header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
const archivePath = join(consumer, "bundled.tar");
const destDir = join(consumer, "bundled-out");
writeFileSync(archivePath, Buffer.concat([header, Buffer.from("TAR"), Buffer.alloc(509 + 1024)]));
mkdirSync(destDir);
await extractArchive({ archivePath, destDir, timeoutMs: 10000 });
assert.equal(readFileSync(join(destDir, "雪.txt"), "utf8"), "TAR");
assert.equal((await readArchiveEntry(archivePath, "雪.txt", { maxBytes: 3 })).toString(), "TAR");
