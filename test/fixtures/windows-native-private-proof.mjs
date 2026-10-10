import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainThread, parentPort } from "node:worker_threads";
import { createDirectorySync, createFileSync } from "../../dist/advanced.js";
import { configureFsSafeNative } from "../../dist/config.js";
import { readOwnerAndDacl } from "../../dist/permissions-public.js";

assert.equal(process.platform, "win32");
configureFsSafeNative({ mode: "require" });
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-private-proof-"));
try {
  const directory = path.join(parent, "private");
  const file = path.join(directory, "payload");
  createDirectorySync(directory, { private: true });
  const owner = createFileSync(file, { private: true });
  const fd = owner.fd;
  try {
    fs.writeSync(fd, "private payload");
    assert.equal(fs.fstatSync(fd, { bigint: true }).ino, fs.statSync(file, { bigint: true }).ino);
    for (const entry of [directory, file]) {
      const facts = readOwnerAndDacl(entry);
      assert.equal(facts.status, "supported");
      assert.equal(facts.ownerSid, facts.currentUserSid);
      assert.equal(facts.complete, true);
      assert.equal(facts.daclPresent, true);
      assert.deepEqual(facts.unsupportedAceTypes, []);
      const trusted = new Set([facts.currentUserSid.toLowerCase(), "s-1-5-18", "s-1-5-32-544"]);
      assert.ok(facts.aces.some((ace) => ace.aceType === "allow" && ace.sid === facts.currentUserSid));
      assert.ok(facts.aces.every((ace) => ace.aceType !== "allow" || trusted.has(ace.sid.toLowerCase())));
    }
    assert.throws(() => createFileSync(file, { private: true }), { code: "already-exists" });
  } finally {
    owner.close();
    owner.close();
  }
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  assert.equal(fs.readFileSync(file, "utf8"), "private payload");
  const proof = { arch: process.arch, isMainThread, privateCreation: true, nativeClose: true };
  if (parentPort) parentPort.postMessage(proof);
  else console.log(JSON.stringify(proof));
} finally {
  fs.rmSync(parent, { recursive: true, force: true });
}
