import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { once } from "node:events";
import { createDirectory, createDirectorySync, createFile, createFileSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { resolveWindowsSystemCommand } from "../../dist/windows-command.js";

async function prove(scenario) {
  const root = mkdtempSync(path.join(tmpdir(), "fs-safe-win32-errno-"));
  const capture = async (operation) => {
    let failure;
    try { await operation(); } catch (error) { failure = error; }
    assert.ok(failure instanceof Error, "creation must fail");
    return failure;
  };
  try {
    if (scenario === "collision") {
      const directory = path.join(root, "existing");
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "keep"), "original");
      for (const operation of [
        () => createDirectorySync(directory, { private: true }),
        () => createDirectory(directory, { private: true }),
      ]) {
        const error = await capture(operation);
        assert.ok(error instanceof FsSafeError);
        assert.equal(error.code, "already-exists");
        assert.equal(error.cause.code, "EEXIST");
        assert.equal(error.cause.errno, 183);
      }
      assert.equal(fs.readFileSync(path.join(directory, "keep"), "utf8"), "original");
      // A preflight refusal has no failed syscall and must not invent a Win32 code.
      const file = path.join(root, "existing-file");
      fs.writeFileSync(file, "original");
      const error = await capture(() => createFileSync(file, { private: true }));
      assert.equal(error.code, "already-exists");
      assert.equal(error.cause?.errno, undefined);
      assert.equal(fs.readFileSync(file, "utf8"), "original");
      return { scenario, errno: [183, 183], preflightErrno: null };
    }

    assert.equal(scenario, "denied");
    const parent = path.join(root, "denied");
    fs.mkdirSync(parent);
    const identity = execFileSync(resolveWindowsSystemCommand("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    const sid = identity.match(/S-1-\d+(?:-\d+)+/u)?.[0];
    assert.ok(sid, "the fixture needs its actual Windows SID");
    const icacls = (...args) => execFileSync(resolveWindowsSystemCommand("icacls.exe"), [parent, ...args], { windowsHide: true, stdio: "pipe", timeout: 10_000 });
    icacls("/deny", `*${sid}:(AD)`);
    try {
      for (const [kind, operation] of [
        ["directory", () => createDirectorySync(path.join(parent, "directory-sync"), { private: true })],
        ["directory", () => createDirectory(path.join(parent, "directory-async"), { private: true })],
        ["file", () => createFileSync(path.join(parent, "file-sync"), { private: true })],
        ["file", () => createFile(path.join(parent, "file-async"), { private: true })],
      ]) {
        const error = await capture(operation);
        const wrapped = kind === "file" && process.env.FS_SAFE_NATIVE_MODE === "off";
        if (wrapped) {
          assert.ok(error instanceof FsSafeError);
          assert.equal(error.code, "helper-failed");
          assert.equal(error.details.cleanup, "preserved");
        }
        const original = wrapped ? error.cause : error;
        assert.equal(original.code, "EACCES");
        assert.equal(original.errno, 5);
      }
      assert.deepEqual(fs.readdirSync(parent), []);
    } finally {
      icacls("/remove:d", `*${sid}`);
    }
    return { scenario, errno: [5, 5, 5, 5], preserved: true };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (isMainThread && process.argv[2] === "worker") {
  const worker = new Worker(new URL(import.meta.url), { workerData: { scenario: process.argv[3] } });
  let result;
  worker.on("message", (message) => { result = message; });
  const [code] = await once(worker, "exit");
  assert.equal(code, 0);
  assert.ok(result);
  console.log(JSON.stringify(result));
} else {
  const result = await prove(isMainThread ? process.argv[3] : workerData.scenario);
  if (parentPort) parentPort.postMessage(result);
  else console.log(JSON.stringify(result));
}
