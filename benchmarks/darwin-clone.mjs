import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ACL_ENTRY = "everyone allow readattr";
const CLONE_ROWS = [
  ["native.cloneFileExclusive/no-acl/4KiB", 4 * 1024, false],
  ["native.cloneFileExclusive/no-acl/1MiB", 1024 * 1024, false],
  ["native.cloneFileExclusive/no-acl/64MiB", 64 * 1024 * 1024, false],
  ["native.cloneFileExclusive/source-acl/4KiB", 4 * 1024, true],
];
const INSPECT_ROWS = [
  "native.inspectDarwinAcl/no-acl-file",
  "native.inspectDarwinAcl/acl-file",
];
const VERIFY_CHUNK_BYTES = 251 * 4096;
const EOF_BUFFER = Buffer.allocUnsafe(1);

function removeAcl(targetPath) {
  execFileSync("chmod", ["-N", targetPath]);
}

function addAcl(targetPath) {
  execFileSync("chmod", ["+a", ACL_ENTRY, targetPath]);
}

function listedAcl(targetPath) {
  return /\n\s*\d+:/.test(execFileSync("ls", ["-lde", targetPath], { encoding: "utf8" }));
}

function fixtureChunk(bytes, seed) {
  const chunk = Buffer.allocUnsafe(Math.min(bytes, VERIFY_CHUNK_BYTES));
  for (let index = 0; index < chunk.length; index += 1) {
    chunk[index] = (seed + index) % 251 + 1;
  }
  return chunk;
}

function writeFixture(filePath, bytes, chunk) {
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    for (let position = 0; position < bytes;) {
      const chunkOffset = position % chunk.length;
      const length = Math.min(chunk.length - chunkOffset, bytes - position);
      const written = fs.writeSync(fd, chunk, chunkOffset, length, position);
      assert(written > 0, "Darwin clone fixture write made no progress");
      position += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
  removeAcl(filePath);
}

function assertDescriptorContents(fd, bytes, expectedChunk, scratch) {
  let position = 0;
  while (position < bytes) {
    const expectedLength = Math.min(scratch.length, bytes - position);
    let filled = 0;
    while (filled < expectedLength) {
      const read = fs.readSync(fd, scratch, filled, expectedLength - filled, position + filled);
      assert(read > 0, "Darwin clone verification reached an early EOF");
      filled += read;
    }
    assert(
      scratch.subarray(0, expectedLength).equals(expectedChunk.subarray(0, expectedLength)),
      "Darwin clone contents differ from the source fixture",
    );
    position += expectedLength;
  }
  assert.equal(fs.readSync(fd, EOF_BUFFER, 0, 1, position), 0, "Darwin clone verification found trailing bytes");
}

function readExpectedSequentialByte(fd, fixture, offset, buffer) {
  assert.equal(fs.readSync(fd, buffer, 0, 1, null), 1);
  assert.equal(
    buffer[0],
    fixture.expectedChunk[offset % fixture.expectedChunk.length],
    "clone changed the source descriptor position",
  );
}

function assertSourceCurrent(fixture) {
  const descriptorStat = fs.fstatSync(fixture.sourceFd, { bigint: true });
  const pathnameStat = fs.lstatSync(fixture.sourcePath, { bigint: true });
  assert(descriptorStat.isFile());
  assert(pathnameStat.isFile());
  for (const field of ["dev", "ino", "size", "mode", "uid", "gid", "nlink"]) {
    assert.equal(descriptorStat[field], fixture.sourceIdentity[field], `source descriptor ${field} changed`);
  }
  assert.equal(pathnameStat.dev, fixture.sourceIdentity.dev);
  assert.equal(pathnameStat.ino, fixture.sourceIdentity.ino);
  assert.equal(pathnameStat.size, fixture.sourceIdentity.size);
  assert.equal(pathnameStat.mode, fixture.sourceIdentity.mode);
  assert.equal(pathnameStat.uid, fixture.sourceIdentity.uid);
  assert.equal(pathnameStat.gid, fixture.sourceIdentity.gid);
  assert.equal(pathnameStat.nlink, 1n);
  assert.equal(descriptorStat.mode & 0o7777n, 0o600n);
  assert.equal(descriptorStat.nlink, 1n);
  assertDescriptorContents(
    fixture.sourceFd,
    fixture.bytes,
    fixture.expectedChunk,
    fixture.verifyBuffer,
  );
  assert.equal(listedAcl(fixture.sourcePath), fixture.sourceAcl, "clone changed the source ACL");
}

function safeClose(fd) {
  if (!Number.isInteger(fd) || fd < 0) return;
  try { fs.closeSync(fd); } catch (error) {
    if (error?.code !== "EBADF") throw error;
  }
}

function cleanOwnedDirectory(directory) {
  for (const entry of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
}

function cloneFailureReason(error) {
  const code = typeof error?.code === "string" ? error.code : "unknown";
  return `Darwin clone preflight failed (${code}); baseline and candidate success are not comparable.`;
}

export async function registerDarwinClone({ workspace, binding, register: add, onCleanup }) {
  const platformSkip = process.platform !== "darwin"
    ? "Darwin/APFS native clone benchmark."
    : typeof binding?.cloneFileExclusive !== "function"
      ? "Darwin native clone binding unavailable."
      : undefined;
  if (platformSkip) {
    for (const [name] of CLONE_ROWS) add(name, () => {}, { skip: platformSkip });
    for (const name of INSPECT_ROWS) add(name, () => {}, { skip: platformSkip });
    return;
  }

  const fixtureRoot = path.join(workspace, "darwin-file-clone");
  const sourceRoot = path.join(fixtureRoot, "sources");
  const targetRoot = path.join(fixtureRoot, "targets");
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(targetRoot, { mode: 0o700 });
  for (const directory of [fixtureRoot, sourceRoot, targetRoot]) {
    fs.chmodSync(directory, 0o700);
    removeAcl(directory);
  }

  const directoryFlags = fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY ?? 0) |
    (fs.constants.O_NOFOLLOW ?? 0);
  const targetRootFd = fs.openSync(targetRoot, directoryFlags);
  onCleanup(() => safeClose(targetRootFd));
  const callSourceFds = new Set();
  onCleanup(() => {
    for (const fd of callSourceFds) safeClose(fd);
    callSourceFds.clear();
  });

  const fixtures = new Map();
  for (const [, bytes, sourceAcl] of CLONE_ROWS) {
    const key = `${bytes}-${sourceAcl ? "acl" : "plain"}`;
    if (fixtures.has(key)) continue;
    const sourcePath = path.join(sourceRoot, `source-${key}`);
    const seed = sourceAcl ? 0xa7 : (bytes / 4096) % 251 + 1;
    const expectedChunk = fixtureChunk(bytes, seed);
    writeFixture(sourcePath, bytes, expectedChunk);
    if (sourceAcl) addAcl(sourcePath);
    assert.equal(listedAcl(sourcePath), sourceAcl, `unexpected source ACL state for ${key}`);
    const sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    onCleanup(() => safeClose(sourceFd));
    fixtures.set(key, {
      bytes,
      expectedChunk,
      sourceAcl,
      sourcePath,
      sourceFd,
      sourceIdentity: fs.fstatSync(sourceFd, { bigint: true }),
      verifyBuffer: Buffer.allocUnsafe(expectedChunk.length),
    });
  }

  const inspectAcl = typeof binding.inspectDarwinAcl === "function"
    ? (fd) => binding.inspectDarwinAcl(fd)
    : undefined;
  const plain4KiB = fixtures.get(`${4 * 1024}-plain`);
  assert(plain4KiB);

  let cloneSkip;
  const preflightName = "preflight";
  let preflightFd;
  try {
    preflightFd = binding.cloneFileExclusive(plain4KiB.sourceFd, targetRootFd, preflightName);
  } catch (error) {
    cloneSkip = cloneFailureReason(error);
  }
  try {
    if (!cloneSkip) {
      assert(Number.isInteger(preflightFd) && preflightFd >= 0, "clone preflight returned an invalid descriptor");
      assert.equal(fs.fstatSync(preflightFd).size, plain4KiB.bytes);
      assertDescriptorContents(
        preflightFd,
        plain4KiB.bytes,
        plain4KiB.expectedChunk,
        plain4KiB.verifyBuffer,
      );
    }
  } finally {
    safeClose(preflightFd);
    fs.rmSync(path.join(targetRoot, preflightName), { force: true });
    assert.deepEqual(fs.readdirSync(targetRoot), [], "clone preflight left a stage or target behind");
  }

  let counter = 0;
  for (const [name, bytes, sourceAcl] of CLONE_ROWS) {
    const fixture = fixtures.get(`${bytes}-${sourceAcl ? "acl" : "plain"}`);
    assert(fixture);
    add(name, (input) => {
      const output = binding.cloneFileExclusive(
        input.sourceFd,
        targetRootFd,
        input.targetName,
      );
      input.completed = true;
      return output;
    }, {
      sync: true,
      skip: cloneSkip,
      before: () => {
        const targetName = `clone-${counter++}`;
        const targetPath = path.join(targetRoot, targetName);
        assert.equal(fs.existsSync(targetPath), false);
        const sourceFd = fs.openSync(
          fixture.sourcePath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
        callSourceFds.add(sourceFd);
        const positionByte = Buffer.allocUnsafe(1);
        readExpectedSequentialByte(sourceFd, fixture, 0, positionByte);
        return { targetName, targetPath, sourceFd, positionByte, completed: false };
      },
      after: (output, input) => {
        try {
          if (!input.completed) return;
          assert(Number.isInteger(output) && output >= 0, "clone returned an invalid descriptor");
          const descriptorStat = fs.fstatSync(output, { bigint: true });
          const pathnameStat = fs.lstatSync(input.targetPath, { bigint: true });
          assert(descriptorStat.isFile());
          assert(pathnameStat.isFile());
          assert.equal(descriptorStat.size, BigInt(fixture.bytes));
          assert.equal(descriptorStat.uid, BigInt(process.geteuid()));
          assert.equal(descriptorStat.mode & 0o7777n, 0o600n);
          assert.equal(descriptorStat.nlink, 1n);
          assert.equal(descriptorStat.dev, pathnameStat.dev);
          assert.equal(descriptorStat.ino, pathnameStat.ino);
          assertDescriptorContents(
            output,
            fixture.bytes,
            fixture.expectedChunk,
            fixture.verifyBuffer,
          );
          assert.equal(listedAcl(input.targetPath), false, "cloned target retained an ACL entry");
          if (inspectAcl) assert(["absent", "empty"].includes(inspectAcl(output).state));
          assert.equal(fs.readdirSync(targetRoot).length, 1, "clone left a staging directory behind");
          readExpectedSequentialByte(input.sourceFd, fixture, 1, input.positionByte);
          const callSourceStat = fs.fstatSync(input.sourceFd, { bigint: true });
          assert.equal(callSourceStat.dev, fixture.sourceIdentity.dev);
          assert.equal(callSourceStat.ino, fixture.sourceIdentity.ino);
          assertSourceCurrent(fixture);
        } finally {
          safeClose(output);
          safeClose(input.sourceFd);
          callSourceFds.delete(input.sourceFd);
          fs.rmSync(input.targetPath, { force: true });
          assert.deepEqual(fs.readdirSync(targetRoot), [], "clone cleanup found an unexpected entry");
        }
      },
    });
  }

  const inspectorSkip = inspectAcl ? undefined : "Native binding lacks inspectDarwinAcl.";
  const inspectorPath = path.join(sourceRoot, "inspector-position");
  fs.writeFileSync(inspectorPath, "abcdef", { mode: 0o600, flag: "wx" });
  removeAcl(inspectorPath);
  const inspectorFd = fs.openSync(inspectorPath, fs.constants.O_RDONLY);
  onCleanup(() => safeClose(inspectorFd));
  if (inspectAcl) {
    const first = Buffer.alloc(2);
    const second = Buffer.alloc(2);
    assert.equal(fs.readSync(inspectorFd, first, 0, first.length, null), first.length);
    assert(["absent", "empty"].includes(inspectAcl(inspectorFd).state));
    assert.equal(fs.readSync(inspectorFd, second, 0, second.length, null), second.length);
    assert.equal(first.toString(), "ab");
    assert.equal(second.toString(), "cd");
    assert(fs.fstatSync(inspectorFd).isFile());
  }
  add(INSPECT_ROWS[0], () => inspectAcl(inspectorFd), {
    sync: true,
    batch: 100,
    skip: inspectorSkip,
    verify: (facts) => assert(["absent", "empty"].includes(facts.state)),
  });
  const acl4KiB = fixtures.get(`${4 * 1024}-acl`);
  assert(acl4KiB);
  add(INSPECT_ROWS[1], () => inspectAcl(acl4KiB.sourceFd), {
    sync: true,
    batch: 100,
    skip: inspectorSkip,
    verify: (facts) => assert.equal(facts.state, "present"),
  });

  if (inspectAcl) {
    const rejectedRoot = path.join(fixtureRoot, "acl-parent");
    fs.mkdirSync(rejectedRoot, { mode: 0o700 });
    fs.chmodSync(rejectedRoot, 0o700);
    removeAcl(rejectedRoot);
    addAcl(rejectedRoot);
    const rejectedFd = fs.openSync(rejectedRoot, directoryFlags);
    onCleanup(() => safeClose(rejectedFd));
    assert.equal(inspectAcl(rejectedFd).state, "present");
    let rejection;
    try {
      const unexpectedFd = binding.cloneFileExclusive(plain4KiB.sourceFd, rejectedFd, "copy");
      safeClose(unexpectedFd);
    } catch (error) {
      rejection = error;
    }
    assert(rejection, "ACL-bearing clone parent unexpectedly succeeded");
    assert.equal(rejection.code, "ENOTSUP");
    assert.deepEqual(fs.readdirSync(rejectedRoot), []);
    assertSourceCurrent(plain4KiB);
    assert.equal(listedAcl(plain4KiB.sourcePath), false);
    assert.equal(inspectAcl(rejectedFd).state, "present");
  }

  onCleanup(() => cleanOwnedDirectory(targetRoot));
}
