// pnpm build; node benchmarks/plugin-source-capture.mjs <baseline-dist/advanced.js>
// Synthetic installed-plugin dependencies; no application data or timing assertions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import * as candidate from "../dist/advanced.js";
import { configureFsSafeNative } from "../dist/config.js";

const baselineUrl = pathToFileURL(path.resolve(process.argv[2]));
const baseline = await import(baselineUrl.href);
const baselineConfig = await import(new URL("config.js", baselineUrl).href);
const native = process.env.FS_SAFE_BENCH_NATIVE ?? "auto";
configureFsSafeNative({ mode: native });
baselineConfig.configureFsSafeNative({ mode: native });
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-plugin-capture-")));
const scratch = Buffer.allocUnsafe(64 * 1024);
const files = [];
const timings = [];

function observeFilesystemCalls() {
  if (process.env.FS_SAFE_BENCH_PROFILE !== "1") return () => undefined;
  const calls = {};
  const restore = [];
  const wrap = (owner, key, label) => {
    const original = owner[key];
    const measured = Object.assign(function (...args) {
      calls[label] = (calls[label] ?? 0) + 1;
      return Reflect.apply(original, this, args);
    }, original);
    owner[key] = measured;
    restore.push(() => { owner[key] = original; });
  };
  for (const key of ["lstatSync", "statSync", "fstatSync", "realpathSync", "openSync", "closeSync", "readSync", "writeSync", "fchmodSync", "fsyncSync"]) {
    wrap(fs, key, key);
  }
  wrap(fs.realpathSync, "native", "realpathSync.native");
  return () => {
    for (const undo of restore.reverse()) undo();
    return Object.fromEntries(Object.entries(calls).map(([name, count]) => [name, count / files.length]));
  };
}

function digest(fd) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (;;) {
    const length = fs.readSync(fd, scratch, 0, scratch.length, bytes);
    if (!length) return { hash: hash.digest("hex"), bytes };
    hash.update(scratch.subarray(0, length));
    bytes += length;
  }
}

function capture(api, entry, target, batch) {
  const opened = api.openRootFileSync({
    absolutePath: entry.source, rootPath: entry.root,
    boundaryLabel: "plugin build source", rejectHardlinks: false,
  });
  if (!opened.ok) throw opened.error;
  try {
    const admitted = fs.fstatSync(opened.fd, { bigint: true });
    const options = {
      source: { rootPath: entry.root, absolutePath: entry.source },
      destination: { rootPath: path.dirname(target), absolutePath: target },
      expectedSourceIdentity: { dev: admitted.dev, ino: admitted.ino },
      clone: "auto", maxBytes: Number(admitted.size),
      mode: 0o600 | Number(admitted.mode & 0o100n), sourceHardlinks: "allow",
    };
    const copied = batch ? batch.copyFile(options) : api.copyRootFileSync(options);
    try {
      const hashed = digest(copied.fd);
      return { ...hashed, method: copied.method, identity: copied.identity };
    } finally { copied.close(); }
  } finally { fs.closeSync(opened.fd); }
}

try {
  // 60 small packages, each with 100 JS, declaration, map and metadata files.
  for (let pkg = 0; pkg < 60; pkg++) {
    const relativeRoot = `node_modules/@fixture/package-${pkg}`;
    const root = path.join(base, "state/extensions/diagnostics-otel", relativeRoot);
    for (let index = 0; index < 100; index++) {
      const relative = `build/src/group-${index % 10}/file-${index}.${["js", "d.ts", "js.map", "json"][index % 4]}`;
      const source = path.join(root, relative);
      const content = Buffer.alloc([200, 1024, 4096, 16384, 65536][index % 5], (pkg + index) % 256);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, content, { mode: index % 10 === 0 ? 0o755 : 0o644 });
      files.push({ source, root, relative: path.join(relativeRoot, relative), content });
    }
  }
  const implementations = {
    baseline: baseline,
    single: candidate,
    batch: candidate,
  };
  // Alternate direction to expose order/cache effects on the same host.
  const order = process.env.FS_SAFE_BENCH_CASE
    ? [process.env.FS_SAFE_BENCH_CASE]
    : ["baseline", "single", "batch", "batch", "single", "baseline"];
  for (const name of order) {
    assert(Object.hasOwn(implementations, name), "case must be baseline, single or batch");
    const targetRoot = path.join(base, `cache/plugin-artifacts/generation-${timings.length}/runtime`);
    const targets = files.map(entry => path.join(targetRoot, entry.relative));
    for (const target of targets) fs.mkdirSync(path.dirname(target), { recursive: true });
    const api = implementations[name];
    const batch = name === "batch" ? api.createRootFileCopyBatchSync() : undefined;
    let receipts;
    let callsPerFile;
    const stopObserving = observeFilesystemCalls();
    const started = performance.now();
    try { receipts = files.map((entry, index) => capture(api, entry, targets[index], batch)); }
    finally { batch?.close(); callsPerFile = stopObserving(); }
    const elapsedMs = performance.now() - started;
    const methods = {};
    // Verify all bytes, descriptor hashes, modes and independent inodes outside timing.
    for (let index = 0; index < files.length; index++) {
      const entry = files[index];
      const receipt = receipts[index];
      assert.deepEqual(fs.readFileSync(targets[index]), entry.content);
      assert.equal(receipt.hash, createHash("sha256").update(entry.content).digest("hex"));
      assert.equal(receipt.bytes, entry.content.length);
      const sourceStat = fs.statSync(entry.source, { bigint: true });
      const targetStat = fs.statSync(targets[index], { bigint: true });
      assert.notDeepEqual(receipt.identity, { dev: sourceStat.dev, ino: sourceStat.ino });
      assert.equal(targetStat.nlink, 1n);
      if (process.platform !== "win32") assert.equal(targetStat.mode & 0o777n, 0o600n | (sourceStat.mode & 0o100n));
      methods[receipt.method] = (methods[receipt.method] ?? 0) + 1;
    }
    timings.push({ name, elapsedMs, methods, callsPerFile });
    console.log(JSON.stringify(timings.at(-1)));
    fs.rmSync(targetRoot, { recursive: true });
  }
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch, native,
    files: files.length, packages: 60, bytes: files.reduce((sum, entry) => sum + entry.content.length, 0),
    timings,
  }, null, 2));
} finally { fs.rmSync(base, { recursive: true, force: true }); }
