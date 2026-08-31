import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const { createFileLockManager } = await import("../dist/file-lock.js");
const { root } = await import("../dist/root.js");
const { __setFsSafeTestHooksForTest } = await import("../dist/test-hooks.js");

const proof = "sidecar-unlinked-snapshot";
if (process.platform === "win32") {
  console.log(JSON.stringify({ proof, platform: process.platform, skipped: "POSIX unlink semantics required" }));
  process.exit(0);
}

const mismatch = { name: "FsSafeError", code: "path-mismatch" };
const errorShape = (error) => ({ name: error?.name, code: error?.code });
const retry = { retries: 3, minTimeout: 1, maxTimeout: 1 };

// Forward every call to this same real Root. Create's existing-file inspection
// opens internally, so arm only at the public snapshot open after its collision.
function observeSnapshot(capability, relative, hookName, mutate) {
  const original = { create: capability.create, open: capability.open, stat: capability.stat };
  const lockPath = path.join(capability.rootReal, relative);
  const trace = { hookCalls: 0, creates: [], probes: [], opened: undefined, error: undefined };
  let armed = false;
  capability.create = async function (candidate, raw, ...args) {
    const call = { raw, outcome: undefined };
    if (candidate === relative) trace.creates.push(call);
    try {
      const result = await original.create.call(this, candidate, raw, ...args);
      call.outcome = "created";
      return result;
    } catch (error) {
      call.outcome = error.code;
      throw error;
    }
  };
  capability.open = async function (candidate, ...args) {
    if (candidate !== relative || armed) return await original.open.call(this, candidate, ...args);
    armed = true;
    assert.deepEqual(trace.creates.map((call) => call.outcome), ["already-exists"]);
    __setFsSafeTestHooksForTest({
      async [hookName](candidatePath, handle) {
        if (candidatePath !== lockPath) return;
        __setFsSafeTestHooksForTest();
        trace.hookCalls += 1;
        trace.opened = handle;
        assert.equal(trace.hookCalls, 1);
        assert.ok(handle.fd >= 0);
        await mutate(handle);
      },
    });
    try {
      return await original.open.call(this, candidate, ...args);
    } catch (error) {
      trace.error = errorShape(error);
      throw error;
    } finally {
      __setFsSafeTestHooksForTest();
    }
  };
  capability.stat = async function (candidate, ...args) {
    try {
      const result = await original.stat.call(this, candidate, ...args);
      if (candidate === relative) trace.probes.push("present");
      return result;
    } catch (error) {
      if (candidate === relative) trace.probes.push(error.code);
      throw error;
    }
  };
  trace.restore = () => {
    __setFsSafeTestHooksForTest();
    Object.assign(capability, original);
  };
  return trace;
}

async function proveHandoff(capability, ownerManager, waiterManager) {
  const relative = "handoff.lock";
  const lockPath = path.join(capability.rootReal, relative);
  const targetPath = path.join(capability.rootReal, "handoff.json");
  const options = { lockPath, lockRoot: capability, retry, timeoutMs: 5_000 };
  const ownerPayload = { owner: "original", scenario: "handoff" };
  const waiterPayload = { owner: "waiter", scenario: "handoff" };
  const owner = await ownerManager.acquire(targetPath, { ...options, payload: () => ownerPayload });
  const ownerBytes = await fs.readFile(lockPath);
  assert.deepEqual(JSON.parse(ownerBytes.toString("utf8")), ownerPayload);

  const trace = observeSnapshot(capability, relative, "afterOpenedPathIdentityCheck", async () => {
    await owner.release();
    await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  });
  let waiter;
  try {
    waiter = await waiterManager.acquire(targetPath, { ...options, payload: () => waiterPayload });
  } finally {
    trace.restore();
  }
  assert.equal(trace.hookCalls, 1);
  assert.equal(trace.opened?.fd, -1);
  assert.deepEqual(trace.error, mismatch);
  assert.deepEqual(trace.probes, ["not-found"]);
  assert.deepEqual(trace.creates.map((call) => call.outcome), ["already-exists", "created"]);
  const waiterBytes = await fs.readFile(lockPath);
  assert.deepEqual(waiterBytes, Buffer.from(trace.creates[1].raw, "utf8"));
  const payload = JSON.parse(waiterBytes.toString("utf8"));
  assert.deepEqual(payload, waiterPayload);
  assert.notDeepEqual(waiterBytes, ownerBytes);
  const verified = await waiter.verifyStillHeld();
  assert.equal(verified, true);
  assert.equal(waiterManager.heldEntries().length, 1);
  await waiter.release();
  await assert.rejects(capability.stat(relative), { name: "FsSafeError", code: "not-found" });
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  assert.equal(ownerManager.heldEntries().length, 0);
  assert.equal(waiterManager.heldEntries().length, 0);
  return {
    hookCalls: trace.hookCalls,
    waiterOwner: payload.owner,
    payload,
    verified,
    openedHandleClosed: trace.opened.fd === -1,
    finalMissing: true,
  };
}

async function proveReplacement(capability, ownerManager, waiterManager) {
  const relative = "replacement.lock";
  const lockPath = path.join(capability.rootReal, relative);
  const displacedPath = `${lockPath}.displaced`;
  const targetPath = path.join(capability.rootReal, "replacement.json");
  const options = { lockPath, lockRoot: capability, retry, timeoutMs: 5_000 };
  const ownerPayload = { owner: "original", scenario: "replacement" };
  const owner = await ownerManager.acquire(targetPath, { ...options, payload: () => ownerPayload });
  const originalBytes = await fs.readFile(lockPath);
  assert.deepEqual(JSON.parse(originalBytes.toString("utf8")), ownerPayload);
  const replacementBytes = Buffer.from('{"owner":"replacement","preserve":true}\n');
  assert.notDeepEqual(replacementBytes, originalBytes);

  const trace = observeSnapshot(capability, relative, "afterOpen", async () => {
    await fs.rename(lockPath, displacedPath);
    await fs.writeFile(lockPath, replacementBytes, { flag: "wx", mode: 0o600 });
  });
  let rejected;
  try {
    await assert.rejects(
      waiterManager.acquire(targetPath, {
        ...options,
        payload: () => ({ owner: "waiter", scenario: "replacement" }),
      }),
      (error) => {
        rejected = errorShape(error);
        assert.deepEqual(rejected, mismatch);
        return true;
      },
    );
  } finally {
    trace.restore();
  }
  assert.equal(trace.hookCalls, 1);
  assert.equal(trace.opened?.fd, -1);
  assert.deepEqual(trace.error, mismatch);
  assert.deepEqual(trace.probes, ["present"]);
  assert.deepEqual(trace.creates.map((call) => call.outcome), ["already-exists"]);
  assert.equal(waiterManager.heldEntries().length, 0);
  assert.equal((await fs.lstat(lockPath)).isFile(), true);
  assert.deepEqual(await fs.readFile(lockPath), replacementBytes);
  assert.deepEqual(await fs.readFile(displacedPath), originalBytes);
  assert.equal(await owner.verifyStillHeld(), false);
  await owner.release();
  await ownerManager.drain();
  await waiterManager.drain();
  ownerManager.reset();
  waiterManager.reset();
  assert.equal(ownerManager.heldEntries().length, 0);
  assert.equal(waiterManager.heldEntries().length, 0);
  assert.deepEqual(await fs.readFile(lockPath), replacementBytes);
  assert.deepEqual(await fs.readFile(displacedPath), originalBytes);
  return {
    hookCalls: trace.hookCalls,
    error: rejected,
    openedHandleClosed: trace.opened.fd === -1,
    replacementPreserved: true,
    originalPreserved: true,
  };
}

let phase = "setup";
let directory;
const ownerManager = createFileLockManager(`${proof}:owner`);
const waiterManager = createFileLockManager(`${proof}:waiter`);
try {
  let result;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-sidecar-proof-"));
    const capability = await root(directory);
    phase = "handoff";
    const handoff = await proveHandoff(capability, ownerManager, waiterManager);
    phase = "replacement";
    const replacement = await proveReplacement(capability, ownerManager, waiterManager);
    result = { proof, platform: process.platform, handoff, replacement };
    phase = "cleanup";
  } finally {
    __setFsSafeTestHooksForTest();
    try {
      await ownerManager.drain();
      await waiterManager.drain();
      ownerManager.reset();
      waiterManager.reset();
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(result));
} catch (error) {
  // Error messages/stacks can contain private absolute paths; expose only shape.
  console.error(JSON.stringify({ proof, platform: process.platform, phase, failed: true, error: errorShape(error) }));
  process.exitCode = 1;
}
