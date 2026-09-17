import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.status, 0, `source binding git ${args[0]} failed`);
  return result.stdout.trim();
}

export function assertPathPrefixSourceBinding(binding, expected) {
  assert.equal(binding.commit, expected.commit, "live source commit mismatch");
  assert.equal(binding.tree, expected.tree, "live source tree mismatch");
  assert.equal(binding.status, "", "checkout has tracked or untracked modifications");
  assert.equal(binding.source.blob, expected.pathPrefixSourceBlob, "live path-prefix blob mismatch");
  assert.equal(binding.source.sha256, expected.pathPrefixSourceHash, "live path-prefix bytes mismatch");
  assert.equal(binding.source.nlink, "1", "live path-prefix source is hardlinked");
  assert(Number.isSafeInteger(binding.source.size) && binding.source.size > 0,
    "live path-prefix source size is invalid");
  for (const key of ["dev", "ino", "mtimeNs", "ctimeNs"]) {
    assert(/^[0-9]+$/u.test(binding.source[key]), `live source ${key} is invalid`);
  }
  assert(BigInt(binding.source.ino) > 0n, "live source file identity is unavailable");
  return binding;
}

export function assertPathPrefixSourceLifecycle(bindings, expected) {
  assert.equal(bindings.length, 3, "source lifecycle requires before-build, after-build, and after-measurement");
  for (const binding of bindings) assertPathPrefixSourceBinding(binding, expected);
  assert.deepEqual(bindings[1], bindings[0], "source identity changed during build");
  assert.deepEqual(bindings[2], bindings[0], "source identity changed during measurement");
  return bindings[0];
}

export function collectPathPrefixSourceBinding(root, expected) {
  const statusArgs = ["status", "--porcelain=v1", "--untracked-files=all"];
  assert.equal(git(root, statusArgs), "", "checkout has tracked or untracked modifications");
  const commit = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const listing = git(root, ["ls-tree", "HEAD", "--", "src/path-prefix.ts"]);
  const match = /^(100644|100755) blob ([0-9a-f]{40})\tsrc\/path-prefix\.ts$/u.exec(listing);
  assert(match, "path-prefix source must be a tracked regular file");
  const file = path.join(root, "src", "path-prefix.ts");
  const key = value => process.platform === "win32" ? value.toLowerCase() : value;
  assert.equal(key(fs.realpathSync.native(file)), key(file), "path-prefix source must have a physical path");
  const descriptor = fs.openSync(file, "r");
  let source;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assert(before.isFile() && before.ino > 0n && before.nlink === 1n && before.size > 0n && before.size <= 1024n * 1024n,
      "path-prefix source is not a bounded independent regular file");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      assert(count > 0, "short read while binding path-prefix source");
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathname = fs.lstatSync(file, { bigint: true });
    const fields = ["dev", "ino", "size", "nlink", "mtimeNs", "ctimeNs"];
    assert(pathname.isFile(), "path-prefix source pathname is no longer a regular file");
    for (const field of fields) {
      assert.equal(after[field], before[field], `path-prefix source ${field} changed during read`);
      assert.equal(pathname[field], after[field], `path-prefix source ${field} changed at pathname`);
    }
    assert.equal(bytes.length, Number(after.size), "path-prefix source read size mismatch");
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(blob, match[2], "live path-prefix source differs from the tracked blob");
    source = { blob, sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length, ...Object.fromEntries(fields.filter(key => key !== "size")
        .map(key => [key, String(after[key])])) };
  } finally {
    fs.closeSync(descriptor);
  }
  assert.equal(git(root, ["rev-parse", "HEAD"]), commit, "source HEAD changed during binding");
  const binding = { commit, tree, status: git(root, statusArgs), source };
  return assertPathPrefixSourceBinding(binding, expected ?? {
    commit, tree, pathPrefixSourceBlob: match[2], pathPrefixSourceHash: source.sha256,
  });
}
