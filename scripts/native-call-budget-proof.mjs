import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const operation = process.argv.includes("--operation") ? process.argv[process.argv.indexOf("--operation") + 1] : "mkdir";
assert(["mkdir", "ensureRoot", "remove", "move", "append", "openWritable", "create", "write"].includes(operation));
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
      const prepare = () => { if (operation !== "mkdir" && operation !== "ensureRoot" && operation !== "create") fs.writeFileSync(path.join(temporary, "child"), "payload", operation === "write" ? { mode: 0o600 } : undefined); };
      const perform = () => {
        if (operation === "ensureRoot") return safe.ensureRoot();
        if (operation === "mkdir") return safe.mkdir("child");
        if (operation === "remove") return safe.remove("child");
        if (operation === "append") return safe.append("child", "data", { durable: false });
        if (operation === "openWritable") return safe.openWritable("child", { writeMode: "append" });
        if (operation === "create") return safe.create("child", "data", { durable: false });
        if (operation === "write") return safe.write("child", "data", { durable: false });
        return safe.move("child", "target", { overwrite: true });
      };
      const cleanup = result => {
        if (operation === "mkdir") fs.rmdirSync(path.join(temporary, "child"));
        if (operation === "create") fs.unlinkSync(path.join(temporary, "child"));
        if (operation === "move") fs.unlinkSync(path.join(temporary, "target"));
        if (operation === "openWritable") return result.handle.close();
      };
      prepare();
      const warm = await perform();
      await cleanup(warm);
      const resources = {};
      const hook = createHook({ init(_id, type) { resources[type] = (resources[type] ?? 0) + 1; } });
      prepare();
      fs.writeSync(2, `BUDGET_START ${operation} ${mode}\n`);
      hook.enable();
      const result = await perform();
      hook.disable();
      fs.writeSync(2, `BUDGET_END ${operation} ${mode}\n`);
      await cleanup(result);
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
      "-e", "trace=%file,read,write,pread64,pwrite64,readv,writev,preadv,pwritev,preadv2,pwritev2,close,fstat,fsync,fdatasync,getdents64,lseek,copy_file_range,sendfile,fcntl,ftruncate,fchmod,fchown,flock,ioctl",
      process.execPath, script, "--child", "--operation", operation,
    ] : [script, "--child", "--operation", operation], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const rows = child.stdout.trim().split("\n").map(line => JSON.parse(line));
    if (trace) {
      let current;
      const counts = {};
      for (const line of fs.readFileSync(tracePath, "utf8").split("\n")) {
        const marker = /BUDGET_(START|END) (?:mkdir|ensureRoot|remove|move|append|openWritable|create|write) (off|require|auto)/.exec(line);
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
      if (process.argv.includes("--record")) { console.log(JSON.stringify(row)); continue; }
      const promises = { ensureRoot: [21, 5], mkdir: [21, 5], remove: [32, 27], move: [82, 73], append: [66, 62], openWritable: [36, 32] }[operation];
      const publication = operation === "create" || operation === "write";
      const expectedResources = publication
        ? operation === "create"
          ? row.mode === "off"
            ? { PROMISE: 104, FSREQPROMISE: 2, FILEHANDLE: 1, FILEHANDLECLOSEREQ: 1 }
            : { PROMISE: 88 }
          : row.mode === "off"
            ? { PROMISE: 152, FSREQPROMISE: 5, FILEHANDLE: 2, FILEHANDLECLOSEREQ: 2 }
            : { PROMISE: 117, FSREQPROMISE: 1, FILEHANDLE: 1, FILEHANDLECLOSEREQ: 1 }
        : (operation === "mkdir" || operation === "ensureRoot")
          ? { PROMISE: promises[row.mode === "require" ? 1 : 0] }
        : row.mode === "require"
          ? { PROMISE: promises[1] }
          : { PROMISE: promises[0], FSREQPROMISE: 1 };
      if (operation === "append" || operation === "openWritable") {
        expectedResources.FSREQPROMISE = operation === "append" ? 2 : 1;
        expectedResources.FILEHANDLE = 1;
        if (operation === "append") expectedResources.FILEHANDLECLOSEREQ = 1;
      }
      assert.deepEqual(row.resources, expectedResources, `${row.mode} ${operation} async resources`);
      if (trace) {
        let expected = row.mode !== "require"
          ? { statx: 9, readlink: 14, mkdir: 1 }
          : process.env.FS_SAFE_TEST_NO_OPENAT2 === "1"
            ? { statx: 4, openat: 3, fstat: 11, readlink: 6, newfstatat: 6, mkdirat: 1, close: 3 }
            : { statx: 4, openat: 1, fstat: 6, readlink: 6, newfstatat: 3, mkdirat: 1, openat2: 1, close: 2 };
        if (operation === "ensureRoot") expected = row.mode === "require"
          ? { statx: 3, openat: 1, fstat: 2, readlink: 2, newfstatat: 1, close: 1 }
          : { statx: 3, readlink: 2 };
        if (operation === "remove") expected = row.mode === "require"
          ? { statx: 6, readlink: 6, openat: 1, newfstatat: 2, unlinkat: 1, close: 1 }
          : { statx: 6, readlink: 6, unlink: 1 };
        if (operation === "move") expected = row.mode === "require"
          ? { statx: 31, readlink: 6, openat: 1, newfstatat: 1, renameat: 1, close: 1 }
          : { statx: 28, readlink: 8, rename: 1 };
        if (operation === "append") expected = row.mode === "require"
          ? { statx: 13, readlink: 6, openat: 1, write: 1, close: 1 }
          : { statx: 14, readlink: 8, openat: 1, write: 1, close: 1 };
        if (operation === "openWritable") expected = row.mode === "require"
          ? { statx: 13, readlink: 6, openat: 1 }
          : { statx: 14, readlink: 8, openat: 1 };
        if (operation === "create") expected = row.mode === "off"
          ? { statx: 23, readlink: 13, openat: 1, write: 1, fchmod: 1, close: 1 }
          : { statx: 24, readlink: 14, openat: 2, fcntl: 1, fstat: 11, newfstatat: 10, fchmod: 1, write: 1, renameat2: 1, close: 3 };
        if (operation === "write") expected = row.mode === "off"
          ? { statx: 27, readlink: 16, openat: 2, close: 2, write: 1, fchmod: 1, rename: 1 }
          : { statx: 25, readlink: 17, openat: 3, close: 6, fcntl: 3, fstat: 11, newfstatat: 10, fchmod: 1, write: 1, renameat: 1 };
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
