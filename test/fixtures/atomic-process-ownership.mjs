import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
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
let stage, stageFd, stageCloses = 0, unlinkAttempts = 0;
const identity = pathname => {
  const stat = fsSync.lstatSync(pathname, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
};
const originalIdentity = identity(target);
const report = extra => fsSync.writeSync(1, JSON.stringify({
  flavor, action, stage: path.basename(stage), stageFd, stageCloses, unlinkAttempts,
  originalIdentity, ...extra,
}) + "\n");
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
    const handle = await fs.open(...args);
    if (args[1] === "wx") {
      stageFd = handle.fd;
      const close = handle.close.bind(handle);
      handle.close = async () => { stageCloses++; await close(); };
    }
    return handle;
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

// Only this child's stdin is closed, after imports and fixture inspection finish.
if (zero) {
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
  assert.equal(error, refusal);
  assert.ok(action === "fd-zero-refusal" || action === "exit-after-cleanup-failure");
  outcome = "refused";
}
assert.equal(stageCloses, 1);
assert.throws(() => fsSync.fstatSync(stageFd), { code: "EBADF" });
assert.equal(fsSync.readFileSync(target, "utf8"), outcome === "published" ? replacement : original);
if (action === "exit-after-cleanup-failure") {
  assert.equal(unlinkAttempts, 1);
  assert.equal(fsSync.readFileSync(stage, "utf8"), replacement);
  report({ outcome, stageIdentity: identity(stage), descriptorClosed: true });
  process.exit(0);
}
assert.deepEqual(fsSync.readdirSync(directory), ["target"]);
report({ outcome, descriptorClosed: true });
