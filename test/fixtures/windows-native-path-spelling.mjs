import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { configureFsSafeNative } from "../../dist/config.js";
import { readOwnerAndDacl } from "../../dist/permissions-public.js";
import { inspectPathPermissions } from "../../dist/permissions.js";
import { root } from "../../dist/root.js";

assert.equal(process.platform, "win32");
configureFsSafeNative({ mode: "require" });

async function prove() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-spelling-"));
  const drive = path.parse(directory).root;
  assert.match(drive, /^[A-Za-z]:\\$/);
  const unc = `\\\\localhost\\${drive[0]}$\\${directory.slice(3)}`;
  const rows = [];
  try {
    // Hosted Windows runners provide the loopback administrative share. These
    // UNC cases require real successful opens; a missing share must fail proof.
    assert.equal(fs.statSync(unc).isDirectory(), true);
    const accepted = [
      { name: "drive", value: directory, expected: directory },
      { name: "drive-forward-slashes", value: directory.replaceAll("\\", "/"), expected: directory },
      { name: "extended-drive", value: `\\\\?\\${directory}`, expected: directory },
      { name: "device-drive", value: `\\\\.\\${directory}`, expected: directory },
      { name: "UNC", value: unc, expected: directory, network: true },
      { name: "extended-UNC", value: `\\\\?\\UNC\\${unc.slice(2)}`, expected: directory, network: true },
      { name: "extended-drive-root", value: `\\\\?\\${drive}`, expected: drive },
      { name: "device-drive-root", value: `\\\\.\\${drive}`, expected: drive },
    ];
    for (const entry of accepted) {
      const expected = readOwnerAndDacl(entry.expected);
      const actual = readOwnerAndDacl(entry.value);
      assert.equal(actual.status, "supported", entry.name);
      for (const field of ["ownerSid", "currentUserSid", "daclPresent", "complete", "unsupportedAceTypes", "aces"]) {
        assert.deepEqual(actual[field], expected[field], `${entry.name}: ${field}`);
      }
      if (!entry.network) {
        const permissions = await inspectPathPermissions(entry.value);
        assert.equal(permissions.ok, true, entry.name);
        assert.equal(permissions.isDir, true, entry.name);
        assert.equal(permissions.source, "windows-acl", entry.name);
      }
      rows.push({ context: isMainThread ? "main" : "worker", spelling: entry.name, result: "accepted" });
    }
    let mutations = 0;
    const scoped = await root(directory, { assertBeforeMutation() { mutations++; } });
    const rejected = [
      { name: "physical-device", value: "\\\\.\\PhysicalDrive0" },
      { name: "named-pipe", value: "\\\\.\\pipe\\fs-safe-spelling-proof" },
      { name: "GLOBALROOT", value: "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\payload" },
    ];
    for (const entry of rejected) {
      for (const operation of [() => scoped.read(entry.value), () => scoped.write(entry.value, "must not be written")]) {
        await assert.rejects(operation, error => {
          assert.equal(error.name, "FsSafeError", entry.name);
          assert.ok(["device-path", "outside-workspace", "invalid-path", "path-alias"].includes(error.code), `${entry.name}: ${error.code}`);
          return true;
        });
      }
      rows.push({ context: isMainThread ? "main" : "worker", spelling: entry.name, result: "rejected-by-admission" });
    }
    assert.equal(mutations, 0);
    assert.deepEqual(fs.readdirSync(directory), []);
    return rows;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
  const proof = { arch: process.arch, runtime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`,
    rows: [...rows, ...workerRows] };
  fs.mkdirSync("artifacts-windows-long-path", { recursive: true });
  fs.writeFileSync(`artifacts-windows-long-path/spellings-${proof.runtime}-${process.arch}.json`, JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
}
