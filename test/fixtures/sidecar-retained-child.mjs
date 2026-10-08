import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { root } from "../../dist/root.js";
import { acquireFileLock, createFileLockManager } from "../../dist/file-lock.js";
import { getNativeBinding, __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../../dist/native.js";

const [base, kind, action] = process.argv.slice(2);
const parent = path.join(base, "parent"), directory = path.join(parent, "data");
fs.mkdirSync(directory, { recursive: true });
const capability = await root(directory);
const target = path.join(directory, "state");
const options = { lockRoot: capability, payload: () => ({ owner: "child" }), timeoutMs: 1000 };
if (action === "leaks") {
  const manager = createFileLockManager(base);
  const warm = await manager.acquire(target, options);
  await warm.release();
  const count = () => fs.readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;
  const before = count();
  for (let i = 0; i < 30; i++) {
    const lock = await manager.acquire(target, options);
    if (i % 3 === 1) {
      fs.renameSync(lock.lockPath, `${lock.lockPath}.old`);
      fs.writeFileSync(lock.lockPath, "replacement");
      await assert.rejects(lock.release(), { code: "path-mismatch" });
      fs.unlinkSync(lock.lockPath);
      fs.unlinkSync(`${lock.lockPath}.old`);
    } else if (i % 3 === 2) manager.reset();
    else await lock.release();
  }
  const failure = new Error("post-create admission failed");
  const open = capability.open;
  capability.open = async () => { throw failure; };
  for (let i = 0; i < 20; i++) await assert.rejects(manager.acquire(target, options), error => error === failure);
  capability.open = open;
  const native = getNativeBinding();
  const ioFailure = Object.assign(new Error("retained unlink failed"), { code: "EIO" });
  __setNativeLoaderForTest(() => ({ ...native, removeStagedFile() { throw ioFailure; } }));
  for (let i = 0; i < 20; i++) {
    const lock = await manager.acquire(target, options);
    await assert.rejects(lock.release(), error => error === ioFailure);
    assert.equal(fs.existsSync(lock.lockPath), true);
    fs.unlinkSync(lock.lockPath);
  }
  __resetNativeLoaderForTest();
  assert.equal(count(), before, "retained sidecar descriptors leaked");
  assert.equal(manager.heldEntries().length, 0);
  console.log("no-leaks");
} else {
  const lock = await acquireFileLock(target, { ...options, retainOnExit: action === "retain" });
  if (kind === "parent-symlink") {
    fs.renameSync(parent, path.join(base, "parent-moved"));
    fs.symlinkSync(path.join(base, "parent-moved"), parent, process.platform === "win32" ? "junction" : "dir");
  } else if (kind !== "control") {
    fs.renameSync(directory, path.join(parent, "data-moved"));
    if (kind === "root-replaced") fs.mkdirSync(directory);
  }
  if (action === "release" || action === "reacquire") {
    await lock.release();
    await lock.release();
  }
  console.log("acquired");
  if (action === "explicit") process.exit(0);
}
