import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const operation = process.argv.includes("--operation") ? process.argv[process.argv.indexOf("--operation") + 1] : "mkdir";
assert(["mkdir", "remove", "move"].includes(operation));
if (process.argv.includes("--child")) {
  const { configureFsSafeNative, root } = await import("../dist/index.js");
  const { getNativeBinding } = await import("../dist/native.js");
  configureFsSafeNative({ mode: "require" });
  assert(getNativeBinding("openBeneath", "mkdirChildBeneath"));
  // Keep the Linux path depth constant for deterministic canonicalization counts.
  const temporary = fs.mkdtempSync(path.join(process.platform === "linux" ? "/tmp" : os.tmpdir(), "fs-safe-native-budget-"));
  try {
    const safe = await root(temporary);
    for (const mode of ["off", "require", "auto"]) {
      configureFsSafeNative({ mode });
      const prepare = () => { if (operation !== "mkdir") fs.writeFileSync(path.join(temporary, "child"), "payload"); };
      const perform = () => operation === "mkdir" ? safe.mkdir("child") : operation === "remove"
        ? safe.remove("child") : safe.move("child", "target", { overwrite: true });
      const cleanup = () => {
        if (operation === "mkdir") fs.rmdirSync(path.join(temporary, "child"));
        if (operation === "move") fs.unlinkSync(path.join(temporary, "target"));
      };
      prepare();
      await perform();
      cleanup();
      const resources = {};
      const hook = createHook({ init(_id, type) { resources[type] = (resources[type] ?? 0) + 1; } });
      prepare();
      fs.writeSync(2, `BUDGET_START ${operation} ${mode}\n`);
      hook.enable();
      await perform();
      hook.disable();
      fs.writeSync(2, `BUDGET_END ${operation} ${mode}\n`);
      cleanup();
      console.log(JSON.stringify({ operation, mode, resources }));
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} else {
  const trace = process.platform === "linux" && !process.argv.includes("--resources-only");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-native-counts-"));
  try {
    const tracePath = path.join(temporary, "trace");
    const child = spawnSync(trace ? "strace" : process.execPath, trace ? [
      "-f", "-yy", "-s", "256", "-o", tracePath,
      "-e", "trace=%file,read,write,close,fstat,fsync,fdatasync,getdents64,lseek,copy_file_range,sendfile,fcntl",
      process.execPath, script, "--child", "--operation", operation,
    ] : [script, "--child", "--operation", operation], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const rows = child.stdout.trim().split("\n").map(line => JSON.parse(line));
    if (trace) {
      let current;
      const counts = {};
      for (const line of fs.readFileSync(tracePath, "utf8").split("\n")) {
        const marker = /BUDGET_(START|END) (?:mkdir|remove|move) (off|require|auto)/.exec(line);
        if (marker) {
          current = marker[1] === "START" ? marker[2] : undefined;
          if (current) counts[current] = {};
          continue;
        }
        if (!current || /anon_inode:\[(?:eventfd|eventpoll)\]|pipe:\[/.test(line)) continue;
        const syscall = /^\d+\s+(\w+)\(/.exec(line)?.[1];
        if ((syscall === "read" || syscall === "write") && !/\(\d+<\//.test(line)) continue;
        if (syscall) counts[current][syscall] = (counts[current][syscall] ?? 0) + 1;
      }
      for (const row of rows) row.syscalls = counts[row.mode];
    }
    for (const row of rows) {
      const promises = { mkdir: [40, 19], remove: [32, 27], move: [90, 81] }[operation];
      const expectedResources = row.mode === "require"
        ? { PROMISE: promises[1] }
        : { PROMISE: promises[0], FSREQPROMISE: 1 };
      assert.deepEqual(row.resources, expectedResources, `${row.mode} ${operation} async resources`);
      if (trace) {
        let expected = row.mode !== "require"
          ? { statx: 9, readlink: 14, mkdir: 1 }
          : process.env.FS_SAFE_TEST_NO_OPENAT2 === "1"
            ? { statx: 8, openat: 3, fstat: 11, readlink: 6, newfstatat: 6, mkdirat: 1, close: 3 }
            : { statx: 8, openat: 1, fstat: 6, readlink: 6, newfstatat: 3, mkdirat: 1, openat2: 1, close: 2 };
        if (operation === "remove") expected = row.mode === "require"
          ? { statx: 6, readlink: 6, openat: 1, newfstatat: 2, unlinkat: 1, close: 1 }
          : { statx: 6, readlink: 6, unlink: 1 };
        if (operation === "move") expected = row.mode === "require"
          ? { statx: 33, readlink: 8, openat: 1, newfstatat: 1, renameat: 1, close: 1 }
          : { statx: 31, readlink: 14, rename: 1 };
        // Linux arm64 exposes the *at variants for these libc pathname calls.
        const aliases = { mkdir: "mkdirat", readlink: "readlinkat", unlink: "unlinkat", rename: "renameat" };
        const architectureExpected = process.arch === "arm64"
          ? Object.fromEntries(Object.entries(expected).map(([name, count]) => [aliases[name] ?? name, count]))
          : expected;
        assert.deepEqual(row.syscalls, architectureExpected, `${row.mode} ${operation} filesystem syscalls`);
      }
      console.log(JSON.stringify(row));
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
