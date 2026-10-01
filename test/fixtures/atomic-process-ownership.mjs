import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { replaceFileAtomic, replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";

const [directory, flavor, action] = process.argv.slice(2);
assert.ok(directory && ["async", "sync"].includes(flavor));
assert.ok([
  "fd-zero-success", "fd-zero-refusal", "exit-staged", "exit-substituted",
  "exit-published", "exit-after-cleanup-failure",
].includes(action));
const target = path.join(directory, "target");
const original = "original";
const replacement = "replacement";
const refusal = new Error("synthetic publication refusal");
const zero = action.startsWith("fd-zero-");
const inheritedZero = zero && process.platform === "win32";
const seed = path.join(directory, "stdin-stage");
const descriptorSetup = inheritedZero ? "inherited-regular-file-adapter"
  : zero ? "builtin-open-after-stdin-close" : "builtin-open";
let inheritedIdentity;
let stage, stageFd, stageCloses = 0, unlinkAttempts = 0;
const statIdentity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const identity = pathname => statIdentity(fsSync.lstatSync(pathname, { bigint: true }));
const originalIdentity = identity(target);
const report = extra => fsSync.writeSync(1, JSON.stringify({
  flavor, action, stage: path.basename(stage), stageFd, stageCloses, unlinkAttempts,
  originalIdentity, descriptorSetup, inheritedIdentity, ...extra,
}) + "\n");

function claimInheritedStage(pathname) {
  assert.equal(stageFd, undefined, "The inherited stage can only be claimed once");
  assert.equal(path.dirname(pathname), directory);
  fsSync.linkSync(seed, pathname);
  fsSync.unlinkSync(seed);
  const retained = fsSync.fstatSync(0, { bigint: true });
  assert.deepEqual(statIdentity(retained), inheritedIdentity);
  assert.deepEqual(identity(pathname), inheritedIdentity);
  assert.equal(retained.nlink, 1n);
  stageFd = 0;
}

// This adapter owns the inherited fd itself; it does not relabel another FileHandle.
const inheritedHandle = {
  fd: 0,
  stat: options => promisify(fsSync.fstat)(0, options),
  chmod: mode => promisify(fsSync.fchmod)(0, mode),
  sync: () => promisify(fsSync.fsync)(0),
  writeFile: data => promisify(fsSync.writeFile)(0, data),
  async close() {
    stageCloses++;
    await promisify(fsSync.close)(0);
  },
};
const beforeRename = ({ tempPath }) => {
  stage = tempPath;
  assert.equal(fsSync.readFileSync(stage, "utf8"), replacement);
  if (zero) assert.equal(stageFd, 0, "The real staged descriptor must be zero");
  if (action === "exit-staged") {
    report({ stageIdentity: identity(stage) });
    process.exit(0);
  }
  if (action === "exit-substituted") {
    const stageIdentity = identity(stage);
    fsSync.renameSync(stage, path.join(directory, "retained"));
    fsSync.writeFileSync(stage, "substitute", { flag: "wx" });
    report({ stageIdentity, substituteIdentity: identity(stage) });
    process.exit(0);
  }
  if (action === "fd-zero-refusal" || action === "exit-after-cleanup-failure") throw refusal;
};
const onDestinationState = receipt => {
  if (action === "exit-published" && receipt.state === "published") {
    report({ publishedIdentity: { dev: String(receipt.dev), ino: String(receipt.ino) } });
    process.exit(0);
  }
};
const promises = {
  ...fs,
  async open(...args) {
    if (inheritedZero && args[1] === "wx") {
      claimInheritedStage(args[0]);
      return inheritedHandle;
    }
    const handle = await fs.open(...args);
    if (args[1] === "wx") {
      stageFd = handle.fd;
      const close = handle.close.bind(handle);
      handle.close = async () => { stageCloses++; await close(); };
    }
    return handle;
  },
  writeFile(file, ...args) {
    return file === inheritedHandle ? inheritedHandle.writeFile(...args) : fs.writeFile(file, ...args);
  },
  async unlink(pathname) {
    unlinkAttempts++;
    if (action === "exit-after-cleanup-failure") throw new Error("synthetic unlink failure");
    await fs.unlink(pathname);
  },
};
const synchronous = {
  ...fsSync,
  openSync(...args) {
    if (inheritedZero && args[1] === "wx") {
      claimInheritedStage(args[0]);
      return 0;
    }
    const fd = fsSync.openSync(...args);
    if (args[1] === "wx") stageFd = fd;
    return fd;
  },
  closeSync(fd) {
    if (fd === stageFd) stageCloses++;
    fsSync.closeSync(fd);
  },
  unlinkSync(pathname) {
    unlinkAttempts++;
    if (action === "exit-after-cleanup-failure") throw new Error("synthetic unlink failure");
    fsSync.unlinkSync(pathname);
  },
};

if (inheritedZero) {
  const pathname = fsSync.lstatSync(seed, { bigint: true });
  const retained = fsSync.fstatSync(0, { bigint: true });
  assert.ok(pathname.isFile() && !pathname.isSymbolicLink() && retained.isFile(), "fd-zero setup must inherit a regular file");
  assert.deepEqual(statIdentity(retained), statIdentity(pathname), "fd-zero setup inherited a different file");
  assert.equal(retained.nlink, 1n);
  assert.equal(retained.size, 0n);
  fsSync.ftruncateSync(0, 0);
  inheritedIdentity = statIdentity(retained);
} else if (zero) {
  // Only this POSIX child's stdin is closed, after lazy fs/entropy initialization.
  randomUUID();
  await fs.lstat(target);
  fsSync.closeSync(0);
}
let outcome;
try {
  const options = { filePath: target, content: replacement, onDestinationState };
  const result = flavor === "sync"
    ? replaceFileAtomicSync({ ...options, beforeRename, fileSystem: synchronous })
    : await replaceFileAtomic({ ...options, beforeRename: async value => beforeRename(value), fileSystem: { promises } });
  assert.equal(action, "fd-zero-success", "An exit/refusal case unexpectedly completed");
  assert.deepEqual(result, { method: "rename" });
  outcome = "published";
} catch (error) {
  if (error !== refusal) throw error;
  assert.ok(action === "fd-zero-refusal" || action === "exit-after-cleanup-failure");
  outcome = "refused";
}
assert.equal(stageCloses, 1);
let descriptorSettlement;
if (inheritedZero) {
  // Windows libuv deliberately leaves fd 0–2 open after fs.close; exit ends their lifetime.
  assert.deepEqual(statIdentity(fsSync.fstatSync(0, { bigint: true })), inheritedIdentity);
  descriptorSettlement = { descriptorState: "stdio-retained-until-process-exit" };
} else {
  assert.throws(() => fsSync.fstatSync(stageFd), { code: "EBADF" });
  descriptorSettlement = { descriptorClosed: true };
}
assert.equal(fsSync.readFileSync(target, "utf8"), outcome === "published" ? replacement : original);
if (action === "exit-after-cleanup-failure") {
  assert.equal(unlinkAttempts, 1);
  assert.equal(fsSync.readFileSync(stage, "utf8"), replacement);
  report({ outcome, stageIdentity: identity(stage), descriptorClosed: true });
  process.exit(0);
}
const intermediateEntries = fsSync.readdirSync(directory).sort();
if (inheritedZero) {
  const setupSeedVisible = intermediateEntries.includes("stdin-stage");
  assert.deepEqual(intermediateEntries, setupSeedVisible ? ["stdin-stage", "target"] : ["target"]);
  descriptorSettlement = { ...descriptorSettlement, intermediateEntries, setupSeedVisible };
} else {
  assert.deepEqual(intermediateEntries, ["target"]);
}
report({ outcome, ...descriptorSettlement });
