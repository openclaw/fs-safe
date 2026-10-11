import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
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
      await safe.mkdir("child");
      fs.rmdirSync(path.join(temporary, "child"));
      const resources = {};
      const hook = createHook({ init(_id, type) { resources[type] = (resources[type] ?? 0) + 1; } });
      fs.writeSync(2, `BUDGET_START mkdir ${mode}\n`);
      hook.enable();
      await safe.mkdir("child");
      hook.disable();
      fs.writeSync(2, `BUDGET_END mkdir ${mode}\n`);
      fs.rmdirSync(path.join(temporary, "child"));
      console.log(JSON.stringify({ operation: "mkdir", mode, resources }));
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
      process.execPath, script, "--child",
    ] : [script, "--child"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const rows = child.stdout.trim().split("\n").map(line => JSON.parse(line));
    if (trace) {
      let current;
      const counts = {};
      for (const line of fs.readFileSync(tracePath, "utf8").split("\n")) {
        const marker = /BUDGET_(START|END) mkdir (off|require|auto)/.exec(line);
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
      const expectedResources = row.mode === "require"
        ? { PROMISE: 19 }
        : { PROMISE: 40, FSREQPROMISE: 1 };
      assert.deepEqual(row.resources, expectedResources, `${row.mode} mkdir async resources`);
      if (trace) {
        const expected = row.mode !== "require"
          ? { statx: 9, readlink: 14, mkdir: 1 }
          : process.env.FS_SAFE_TEST_NO_OPENAT2 === "1"
            ? { statx: 8, openat: 3, fstat: 11, readlink: 6, newfstatat: 6, mkdirat: 1, close: 3 }
            : { statx: 8, openat: 1, fstat: 6, readlink: 6, newfstatat: 3, mkdirat: 1, openat2: 1, close: 2 };
        assert.deepEqual(row.syscalls, expected, `${row.mode} mkdir filesystem syscalls`);
      }
      console.log(JSON.stringify(row));
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
