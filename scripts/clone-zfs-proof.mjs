import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { copyTree, createCloneSource, probeTreeClone } from "../dist/copy.js";
import { root } from "../dist/index.js";

const [mountArgument, pool, mode = "reflink", ...extra] = process.argv.slice(2);
assert(
  mountArgument && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(pool ?? "") &&
    ["reflink", "no-reflink"].includes(mode) && extra.length === 0,
  "Usage: node scripts/clone-zfs-proof.mjs MOUNT POOL [no-reflink]",
);
assert.equal(process.platform, "linux", "ZFS proof requires Linux");
const mount = await fs.realpath(mountArgument);
assert.equal(probeTreeClone(mount), "zfs", "Mount must have native ZFS support");
const command = (file, args) => execFileSync(file, args, {
  encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 30_000,
}).trim();
const dataset = command("findmnt", ["-n", "-T", mount, "-o", "SOURCE"]);
assert(dataset === pool || dataset.startsWith(`${pool}/`), "Mount must belong to the supplied pool");
for (const property of ["compression", "dedup"]) {
  assert.equal(command("zfs", ["get", "-Hp", "-o", "value", property, dataset]), "off",
    `Proof requires ${property}=off`);
}

function savedBytes() {
  // Use a dedicated, otherwise idle pool. zpool sync commits the pool's
  // pending changes before reading OpenZFS's documented block-clone counters.
  command("zpool", ["sync", pool]);
  const value = command("zpool", ["get", "-Hp", "-o", "value", "bclonesaved", pool]);
  return value === "-" ? 0n : BigInt(value);
}

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const owned = await fs.mkdtemp(path.join(mount, "fs-safe-zfs-proof-"));
try {
  const source = path.join(owned, "source");
  await createCloneSource(source);
  await fs.mkdir(path.join(source, "nested"));
  await fs.mkdir(path.join(source, "empty-directory"));
  const files = new Map([
    ["payload", Buffer.alloc(1024 * 1024, 0x5a)],
    ["nested/unaligned", Buffer.from(Array.from({ length: 4097 }, (_, i) => (i % 251) + 1))],
    ["empty-file", Buffer.alloc(0)],
  ]);
  for (const [name, bytes] of files) await fs.writeFile(path.join(source, name), bytes);
  await fs.symlink("nested/unaligned", path.join(source, "literal-link"));

  async function verify(directory) {
    assert.deepEqual((await fs.readdir(directory)).sort(), [
      "empty-directory", "empty-file", "literal-link", "nested", "payload",
    ]);
    assert.deepEqual(await fs.readdir(path.join(directory, "empty-directory")), []);
    assert.deepEqual(await fs.readdir(path.join(directory, "nested")), ["unaligned"]);
    assert.equal(await fs.readlink(path.join(directory, "literal-link")), "nested/unaligned");
    for (const [name, bytes] of files) {
      const target = path.join(directory, name);
      assert.equal(hash(await fs.readFile(target)), hash(bytes));
      if (directory !== source) {
        const original = await fs.stat(path.join(source, name), { bigint: true });
        const copied = await fs.stat(target, { bigint: true });
        assert.equal(original.dev, copied.dev);
        assert.notEqual(original.ino, copied.ino);
      }
    }
  }

  const results = [];
  if (mode === "no-reflink") {
    const rejected = path.join(owned, "strict-unavailable");
    await assert.rejects(copyTree(source, rejected, { clone: "always" }), { code: "unsupported-platform" });
    await assert.rejects(fs.access(rejected), { code: "ENOENT" });
    results.push({ policy: "always", unsupported: true, destinationAbsent: true });
  }
  const policies = mode === "reflink" ? ["always", "auto", "never"] : ["auto", "never"];
  for (const clone of policies) {
    const destination = path.join(owned, clone);
    const before = savedBytes();
    await copyTree(source, destination, { clone });
    const sharedDelta = savedBytes() - before;
    const expectsClone = mode === "reflink" && clone !== "never";
    if (expectsClone) assert(sharedDelta >= 1024n * 1024n, "Copy did not increase shared-block savings");
    else assert.equal(sharedDelta, 0n, "Byte copy unexpectedly increased shared-block savings");
    await verify(destination);
    const file = await fs.open(path.join(destination, "payload"), "r+");
    try {
      assert.equal((await file.write(Buffer.from("independent"), 0, 11, 0)).bytesWritten, 11);
    } finally { await file.close(); }
    const expected = Buffer.from(files.get("payload"));
    Buffer.from("independent").copy(expected);
    assert.equal(hash(await fs.readFile(path.join(destination, "payload"))), hash(expected));
    await verify(source);
    results.push({ policy: clone, bcloneSavedDelta: String(sharedDelta), hashesMatch: true, independentWrite: true });
  }

  // Exercise the independent guarded-file owner too; it already uses the
  // kernel's file-clone operation without a filesystem-name allowlist.
  const guardedDirectory = path.join(owned, "guarded");
  await fs.mkdir(guardedDirectory);
  const guarded = await root(guardedDirectory);
  if (mode === "no-reflink") {
    await assert.rejects(guarded.copyIn("strict-unavailable", path.join(source, "payload"), {
      clone: "always",
    }), { code: "unsupported-platform" });
    await assert.rejects(fs.access(path.join(guardedDirectory, "strict-unavailable")), { code: "ENOENT" });
    results.push({ operation: "Root.copyIn", policy: "always", unsupported: true, destinationAbsent: true });
  }
  for (const clone of policies) {
    const before = savedBytes();
    await guarded.copyIn(clone, path.join(source, "payload"), { clone });
    const sharedDelta = savedBytes() - before;
    if (mode === "reflink" && clone !== "never") assert(sharedDelta >= 1024n * 1024n);
    else assert.equal(sharedDelta, 0n);
    assert.equal(hash(await fs.readFile(path.join(guardedDirectory, clone))), hash(files.get("payload")));
    results.push({ operation: "Root.copyIn", policy: clone, bcloneSavedDelta: String(sharedDelta), hashesMatch: true });
  }
  console.log(JSON.stringify({ backend: "zfs", mode, results }));
} finally {
  assert.equal(path.dirname(owned), mount);
  assert(path.basename(owned).startsWith("fs-safe-zfs-proof-"));
  await fs.rm(owned, { recursive: true, force: true });
}
