import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { inspectDarwinAcl } from "../../dist/permissions-public.js";
import { tryAcquireWriteLease } from "../../dist/file-lock.js";
import { holdWindowsSharingLock, setWindowsFileAttributes, readWindowsFileExtents } from "../../dist/test-hooks.js";

async function readyChild(file, mode = "r") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    const fd = fs.openSync(process.argv[1], process.argv[2]);
    process.stdout.write('ready');
    process.stdin.resume();
    process.stdin.on('end', () => { fs.closeSync(fd); process.exit(0); });
  `, file, mode], { stdio: ["pipe", "pipe", "inherit"] });
  await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
  return child;
}

async function linux(directory) {
  const file = path.join(directory, "lease");
  fs.writeFileSync(file, "lease fixture");
  const fd = fs.openSync(file, "r");
  try {
    const lease = tryAcquireWriteLease(fd);
    assert.ok(lease);
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(lease.fd, fd);
    assert.equal(lease.isHeld(), true);
    lease.release(); lease.release(); lease[Symbol.dispose]();
    assert.equal(lease.isHeld(), false);
    assert.equal(fs.fstatSync(fd).size, 13);
    const second = fs.openSync(file, "r");
    try { assert.equal(tryAcquireWriteLease(fd), null); } finally { fs.closeSync(second); }
    const existing = await readyChild(file);
    try { assert.equal(tryAcquireWriteLease(fd), null); } finally {
      existing.stdin.end();
      assert.deepEqual(await once(existing, "exit"), [0, null]);
    }
    for (const mode of ["r", "r+"]) {
      const broken = tryAcquireWriteLease(fd);
      assert.ok(broken);
      const competitor = readyChild(file, mode);
      try {
        const deadline = Date.now() + 5000;
        while (broken.isHeld() && Date.now() < deadline) await delay(10);
        assert.equal(broken.isHeld(), false);
      } finally { broken.release(); }
      const opened = await competitor;
      opened.stdin.end();
      assert.deepEqual(await once(opened, "exit"), [0, null]);
    }
  } finally { fs.closeSync(fd); }
  assert.throws(() => tryAcquireWriteLease(fd), { code: "helper-failed" });
  return "acquire, same-process contention, cross-process contention, reader/writer SIGIO breaks, idempotent release, caller fd retained";
}

function darwin(directory) {
  const username = os.userInfo().username;
  for (const [name, flags, expected] of [
    ["none", "", { kind: "none" }],
    ["plain", "read", { kind: "present", inheritsToFiles: false, inheritsToDirectories: false }],
    ["files", "read,file_inherit", { kind: "present", inheritsToFiles: true, inheritsToDirectories: false }],
    ["directories", "read,directory_inherit", { kind: "present", inheritsToFiles: false, inheritsToDirectories: true }],
    ["both", "read,file_inherit,directory_inherit", { kind: "present", inheritsToFiles: true, inheritsToDirectories: true }],
  ]) {
    const target = path.join(directory, name);
    fs.mkdirSync(target);
    execFileSync("chmod", ["-N", target]);
    if (flags) execFileSync("chmod", ["+a", `user:${username} allow ${flags}`, target]);
    assert.deepEqual(inspectDarwinAcl(target), expected);
  }
  const unreadable = path.join(directory, "unreadable");
  fs.writeFileSync(unreadable, "private", { mode: 0o000 });
  try { assert.equal(inspectDarwinAcl(unreadable).kind, "unknown"); }
  finally { fs.chmodSync(unreadable, 0o600); }
  assert.equal(inspectDarwinAcl(path.join(directory, "missing")).kind, "unknown");
  const link = path.join(directory, "symlink");
  fs.symlinkSync(path.join(directory, "none"), link);
  assert.equal(inspectDarwinAcl(link).kind, "unknown");
  return "absent, non-inheritable, file-inherit, directory-inherit, both, unreadable, missing, no-follow";
}

function windows(directory) {
  const file = path.join(directory, "file");
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 0x5a));
  const lock = holdWindowsSharingLock(file);
  assert.equal(Object.isFrozen(lock), true);
  try { assert.throws(() => fs.unlinkSync(file), { code: "EBUSY" }); }
  finally { lock.close(); lock.close(); lock[Symbol.dispose](); }
  const facts = () => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./windows-volume-facts.ps1", import.meta.url)), file], { encoding: "utf8" }));
  const original = facts();
  assert.equal(fs.statfsSync(file).bsize, original.clusterSize);
  assert.equal(original.filesystem, "NTFS");
  console.log(JSON.stringify({ proof: "windows-cluster-size", node: process.version, ...original, statfsBsize: fs.statfsSync(file).bsize }));
  try {
    setWindowsFileAttributes(file, { readOnly: true, hidden: true, system: true });
    assert.equal(facts().attributes & 7, 7);
    setWindowsFileAttributes(file, { hidden: false });
    assert.equal(facts().attributes & 7, 5);
  } finally { setWindowsFileAttributes(file, { readOnly: false, hidden: false, system: false }); }
  assert.equal(facts().attributes, original.attributes);
  const extents = readWindowsFileExtents(file);
  assert.ok(extents.length > 0);
  let next = 0n;
  for (const extent of extents) {
    assert.equal(extent.vcn, next);
    assert.ok(extent.lcn >= 0n);
    assert.ok(extent.clusters > 0n);
    next += extent.clusters;
  }
  assert.ok(next * BigInt(original.clusterSize) >= BigInt(fs.statSync(file).size));
  const empty = path.join(directory, "empty");
  fs.writeFileSync(empty, "");
  assert.deepEqual(readWindowsFileExtents(empty), []);
  fs.unlinkSync(file);
  assert.throws(() => readWindowsFileExtents(file), { code: "helper-failed" });
  return "no delete sharing, idempotent close, attributes preserve unspecified bits, NTFS extents, empty extents, statfs cluster size";
}

async function run(directory) {
  return process.platform === "linux" ? await linux(directory)
    : process.platform === "darwin" ? darwin(directory) : windows(directory);
}

if (isMainThread) {
  // SIGIO is process-scoped; install in the hosting main thread even for Workers.
  if (process.platform === "linux") process.on("SIGIO", () => {});
  const [mode, directory] = process.argv.slice(2);
  if (mode === "worker") {
    const worker = new Worker(new URL(import.meta.url), { workerData: directory });
    worker.on("message", value => console.log(JSON.stringify({ mode, proof: value })));
    const [code] = await once(worker, "exit");
    assert.equal(code, 0);
  } else {
    console.log(JSON.stringify({ mode, proof: await run(directory) }));
  }
} else {
  parentPort.postMessage(await run(workerData));
}
