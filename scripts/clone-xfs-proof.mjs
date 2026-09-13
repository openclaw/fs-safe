import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { copyTree, createCloneSource, probeTreeClone } from "../dist/copy.js";

const [mountArgument, mode = "reflink", ...extra] = process.argv.slice(2);
assert(
  mountArgument && ["reflink", "no-reflink"].includes(mode) && extra.length === 0,
  "Usage: node scripts/clone-xfs-proof.mjs MOUNT [no-reflink]",
);
assert.equal(process.platform, "linux", "XFS proof requires Linux");
const mount = await fs.realpath(mountArgument);
assert.equal(probeTreeClone(mount), "xfs", "Mount must have native XFS support");

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extents(filename) {
  // filefrag -b1 reports FIEMAP offsets in bytes; -s requests FIEMAP_FLAG_SYNC.
  // https://github.com/tytso/e2fsprogs/blob/master/misc/filefrag.c
  // https://www.kernel.org/doc/html/latest/filesystems/fiemap.html
  const output = execFileSync("filefrag", ["-b1", "-e", "-s", filename], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10_000,
  });
  const mapped = [];
  for (const line of output.split("\n")) {
    if (!/^\s*\d+:/.test(line)) continue;
    const match = /^\s*\d+:\s*(\d+)\.\.\s*(\d+):\s*(\d+)\.\.\s*(\d+):\s*(\d+):\s*(.*)$/.exec(line);
    assert(match, "Unrecognized filefrag extent format");
    const [, logicalStart, logicalLast, physicalStart, physicalLast, length, flags] = match;
    const logical = BigInt(logicalStart);
    const physical = BigInt(physicalStart);
    const bytes = BigInt(length);
    assert.equal(BigInt(logicalLast) + 1n - logical, bytes, "Invalid logical extent length");
    assert.equal(BigInt(physicalLast) + 1n - physical, bytes, "Invalid physical extent length");
    assert(
      !/unknown_loc|delalloc|unwritten|not_aligned|inline|encoded|hole/.test(flags),
      "Proof requires initialized, physically mapped file data",
    );
    mapped.push({ logical, end: logical + bytes, physical, shared: /\bshared\b/.test(flags) });
  }
  assert(mapped.length > 0, "No physical extents reported");
  return mapped;
}

function assertSharedData(source, destination, size) {
  const original = extents(source);
  const copied = extents(destination);
  let sourceIndex = 0;
  let copyIndex = 0;
  let offset = 0n;
  const end = BigInt(size);
  while (offset < end) {
    const left = original[sourceIndex];
    const right = copied[copyIndex];
    assert(left && right, "Extent maps do not cover the entire file");
    assert(left.logical <= offset && left.end > offset, "Source extent map has a gap");
    assert(right.logical <= offset && right.end > offset, "Copy extent map has a gap");
    assert(left.shared && right.shared, "FIEMAP_EXTENT_SHARED is missing");
    assert.equal(
      left.physical + offset - left.logical,
      right.physical + offset - right.logical,
      "Source and copy data occupy different physical bytes",
    );
    offset = left.end < right.end ? left.end : right.end;
    if (offset >= left.end) sourceIndex++;
    if (offset >= right.end) copyIndex++;
  }
  return size;
}

function assertSeparateData(source, destination, size) {
  const original = extents(source);
  const copied = extents(destination);
  let covered = 0n;
  for (const right of copied) {
    assert.equal(right.logical, covered, "Byte-copy extent map has a gap");
    assert(!right.shared, "Byte copy unexpectedly reports shared storage");
    covered = right.end;
    const rightEnd = right.physical + right.end - right.logical;
    for (const left of original) {
      const leftEnd = left.physical + left.end - left.logical;
      assert(
        rightEnd <= left.physical || leftEnd <= right.physical,
        "Byte copy overlaps the source's physical storage",
      );
    }
  }
  assert(covered >= BigInt(size), "Byte-copy extent map does not cover the file");
  return size;
}

const owned = await fs.mkdtemp(path.join(mount, "fs-safe-xfs-proof-"));
try {
  const source = path.join(owned, "source");
  await createCloneSource(source);
  await fs.mkdir(path.join(source, "nested"));
  await fs.mkdir(path.join(source, "empty-directory"));
  const files = new Map([
    ["payload", Buffer.alloc(1024 * 1024, 0x5a)],
    [
      "nested/unaligned",
      Buffer.from(Array.from({ length: 4097 }, (_, index) => (index % 251) + 1)),
    ],
    ["empty-file", Buffer.alloc(0)],
  ]);
  for (const [name, bytes] of files) await fs.writeFile(path.join(source, name), bytes);
  await fs.symlink("nested/unaligned", path.join(source, "literal-link"));

  async function verify(directory) {
    assert.deepEqual((await fs.readdir(directory)).sort(), [
      "empty-directory",
      "empty-file",
      "literal-link",
      "nested",
      "payload",
    ]);
    assert.deepEqual(await fs.readdir(path.join(directory, "nested")), ["unaligned"]);
    assert.deepEqual(await fs.readdir(path.join(directory, "empty-directory")), []);
    assert.equal(await fs.readlink(path.join(directory, "literal-link")), "nested/unaligned");
    for (const [name, bytes] of files) {
      assert.equal(
        hash(await fs.readFile(path.join(directory, name))),
        hash(bytes),
        `SHA-256 mismatch for ${name}`,
      );
    }
  }

  const results = [];
  if (mode === "no-reflink") {
    const rejected = path.join(owned, "strict-unavailable");
    await assert.rejects(copyTree(source, rejected, { clone: "always" }), {
      code: "unsupported-platform",
    });
    await assert.rejects(fs.access(rejected), { code: "ENOENT" });
    results.push({ policy: "always", unsupported: true, destinationAbsent: true });
  }
  const cases =
    mode === "reflink"
      ? [
          { label: "always-one-worker", clone: "always", concurrency: 1 },
          { label: "always-default-workers", clone: "always" },
          { label: "auto", clone: "auto" },
          { label: "never", clone: "never" },
        ]
      : [
          { label: "auto", clone: "auto" },
          { label: "never", clone: "never" },
        ];
  for (const { label, ...options } of cases) {
    const destination = path.join(owned, label);
    const started = performance.now();
    await copyTree(source, destination, options);
    const milliseconds = performance.now() - started;
    await verify(destination);
    let sharedBytes = 0;
    let separateBytes = 0;
    for (const [name, bytes] of files) {
      if (bytes.length === 0) continue;
      const [original, copied] = await Promise.all([
        fs.stat(path.join(source, name), { bigint: true }),
        fs.stat(path.join(destination, name), { bigint: true }),
      ]);
      assert.equal(original.dev, copied.dev, "Extent comparison requires the same device");
      assert.notEqual(original.ino, copied.ino, "Copy must have an independent inode");
      if (mode === "reflink" && options.clone !== "never") {
        sharedBytes += assertSharedData(
          path.join(source, name),
          path.join(destination, name),
          bytes.length,
        );
      } else {
        separateBytes += assertSeparateData(
          path.join(source, name),
          path.join(destination, name),
          bytes.length,
        );
      }
    }
    const edited = Buffer.alloc(4096, 0x31);
    const handle = await fs.open(path.join(destination, "payload"), "r+");
    try {
      await handle.write(edited, 0, edited.length, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const expectedEdit = Buffer.from(files.get("payload"));
    edited.copy(expectedEdit);
    assert.equal(hash(await fs.readFile(path.join(destination, "payload"))), hash(expectedEdit));
    await verify(source);
    results.push({
      policy: label,
      milliseconds,
      sharedBytes,
      separateBytes,
      hashesMatch: true,
      independentWrite: true,
    });
  }
  console.log(JSON.stringify({ backend: "xfs", mode, results }));
} finally {
  assert.equal(
    path.dirname(owned),
    mount,
    "Cleanup target must remain a direct child of the mount",
  );
  assert(path.basename(owned).startsWith("fs-safe-xfs-proof-"), "Unexpected cleanup target");
  await fs.rm(owned, { recursive: true, force: true });
}
