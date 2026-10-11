import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { createDirectorySync, createFileSync } from "../../dist/advanced.js";
import { configureFsSafeNative } from "../../dist/config.js";
import { readOwnerAndDacl } from "../../dist/permissions-public.js";
import { root } from "../../dist/root.js";
import { holdWindowsSharingLock, setWindowsFileAttributes } from "../../dist/test-hooks.js";

assert.equal(process.platform, "win32");
configureFsSafeNative({ mode: "require" });

function paddedParent(base, length) {
  let result = base;
  while (result.length < length) {
    const remaining = length - result.length;
    result = remaining === 1 ? result + "p" : path.join(result, "p".repeat(Math.min(40, remaining - 1)));
  }
  assert.equal(result.length, length);
  return result;
}

function assertPrivate(target) {
  const facts = readOwnerAndDacl(target);
  assert.equal(facts.status, "supported");
  assert.equal(facts.ownerSid, facts.currentUserSid);
  assert.equal(facts.complete, true);
  assert.equal(facts.daclPresent, true);
  const trusted = new Set([facts.currentUserSid.toLowerCase(), "s-1-5-18", "s-1-5-32-544"]);
  assert.ok(facts.aces.some(ace => ace.aceType === "allow" && ace.sid === facts.currentUserSid));
  assert.ok(facts.aces.every(ace => ace.aceType !== "allow" || trusted.has(ace.sid.toLowerCase())));
}

async function prove() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fs-long-"));
  const rows = [];
  try {
    for (const length of [259, 260, 261, 300]) {
      for (const boundary of ["target", "stage-directory", "stage-file"]) {
        const leaf = "private-data";
        const stageNameLength = ".fs-safe-create-".length + 36;
        const parentLength = length - 1 - (boundary === "target" ? leaf.length
          : stageNameLength + (boundary === "stage-file" ? "/file".length : 0));
        const parent = paddedParent(base, parentLength);
        fs.mkdirSync(path.toNamespacedPath(parent), { recursive: true });
        const target = path.join(parent, leaf);
        const scoped = await root(parent);
        createDirectorySync(target, { private: true });
        assertPrivate(target);
        await scoped.remove(leaf);
        assert.equal(fs.existsSync(target), false);

        const stages = new Set();
        const owner = createFileSync(target, { private: true, assertBeforeMutation() {
          for (const name of fs.readdirSync(parent)) {
            if (name.startsWith(".fs-safe-create-")) stages.add(path.join(parent, name));
          }
        } });
        const fd = owner.fd;
        try {
          fs.writeSync(fd, "synthetic long-path payload");
          assert.equal(fs.fstatSync(fd, { bigint: true }).ino, fs.statSync(target, { bigint: true }).ino);
          assertPrivate(target);
          assert.throws(() => createFileSync(target, { private: true }), { code: "already-exists" });
        } finally { owner.close(); owner.close(); }
        assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
        assert.equal(stages.size, 1);
        const [stage] = stages;
        const measured = boundary === "target" ? target.length
          : boundary === "stage-directory" ? stage.length : path.join(stage, "file").length;
        assert.equal(measured, length);
        assert.deepEqual(fs.readdirSync(parent), [leaf]);
        const lock = holdWindowsSharingLock(target);
        lock.close(); lock[Symbol.dispose]();
        setWindowsFileAttributes(target, { hidden: true });
        setWindowsFileAttributes(target, { hidden: false });
        const copy = "copied--data";
        await scoped.copyIn(copy, target, { clone: "never", overwrite: false });
        assert.equal(fs.readFileSync(path.join(parent, copy), "utf8"), "synthetic long-path payload");
        await scoped.remove(leaf);
        await scoped.remove(copy);
        assert.deepEqual(fs.readdirSync(parent), []);
        rows.push({ context: isMainThread ? "main" : "worker", boundary, length,
          targetLength: target.length, stageDirectoryLength: stage.length,
          stageFileLength: path.join(stage, "file").length, operations: 4 });
      }
    }
    // Keep raw alias admission before the namespace conversion.
    for (const suffix of ["bad.", "bad ", "parent\\..\\bad", ".\\bad"]) {
      assert.throws(() => createDirectorySync(base + "\\" + suffix, { private: true }));
      assert.deepEqual(fs.readdirSync(base).filter(name => name.startsWith("bad")), []);
    }
    return rows;
  } finally { fs.rmSync(path.toNamespacedPath(base), { recursive: true, force: true }); }
}

const rows = await prove();
if (!isMainThread) parentPort.postMessage(rows);
else {
  const workerRows = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url));
    let result;
    worker.once("message", value => { result = value; });
    worker.once("error", reject);
    worker.once("exit", code => code === 0 && result ? resolve(result) : reject(new Error(`Worker exit ${code}`)));
  });
  const proof = { platform: process.platform, arch: process.arch,
    runtime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`,
    rows: [...rows, ...workerRows] };
  fs.mkdirSync("artifacts-windows-long-path", { recursive: true });
  fs.writeFileSync(`artifacts-windows-long-path/${proof.runtime}-${process.arch}.json`, JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
}
