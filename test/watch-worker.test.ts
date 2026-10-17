import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
it.skipIf(!!process.versions.bun || !!process.versions.deno)("keeps compiled watch scans off the host and fences deep worker observations", async () => {
  const result = await exec(process.execPath, ["--input-type=module", "--max-old-space-size=4096", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import fsp from "node:fs/promises";
    import os from "node:os";
    import { setTimeout as settle } from "node:timers/promises";
    import path from "node:path";
    import { root } from "./dist/root.js";
    import { watch } from "./dist/watch.js";
    import { rootHandleContext } from "./dist/root-handle-context.js";
    import { createWatchIo, watchGuard, watchAssert, watchStats, enableWatchIoDiagnostics, watchIoMetrics } from "./dist/watch-io.js";
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "watch-worker-")));
    let owner;
    try {
      for (let n = 0; n < 128; n++) {
        const child = path.join(directory, "d" + n, "deep");
        await fsp.mkdir(child, { recursive: true });
        await fsp.writeFile(path.join(child, "file"), "before");
      }
      await settle(1100);
      enableWatchIoDiagnostics();
      const capability = await root(directory);
      let changed = false;
      let ready;
      owner = watch(capability, { mode: "poll", intervalMs: 100, maxDirectories: 1000,
        scopes: [{ path: "", kind: "tree" }], exclude() { return false; },
        onInvalidate() { changed = true; }, onHealth(h) { if (h.state === "ready") ready?.(); } });
      await owner.ready;
      changed = false;
      const before = await watchIoMetrics();
      const original = new Map();
      let syncCalls = 0;
      for (const method of ["lstatSync", "statSync", "realpathSync", "openSync", "readSync"]) {
        original.set(method, fs[method]);
        fs[method] = Object.assign(function (...args) { syncCalls++; return original.get(method).apply(this, args); }, original.get(method));
      }
      try {
        await new Promise(resolve => { ready = resolve; }); ready = undefined;
        const idle = await watchIoMetrics();
        assert.equal(syncCalls, 0, "idle tick performed synchronous host I/O");
        assert.equal((idle["async.opendir"] ?? 0) - (before["async.opendir"] ?? 0), 0);
        assert.ok(idle["sync.lstatSync"] - before["sync.lstatSync"] <= 660);
        await owner.reconcile();
        assert.equal(syncCalls, 0, "full reconciliation performed synchronous host I/O");
        assert.equal(changed, false);
        const after = await watchIoMetrics();
        assert.ok(after["sync.lstatSync"] > before["sync.lstatSync"], "worker did not perform the scan");
        await fsp.writeFile(path.join(directory, "d50", "deep", "file"), "changed");
        await owner.reconcile();
        assert.ok(changed);
        assert.equal(syncCalls, 0);
      } finally { for (const [method, value] of original) fs[method] = value; }
      await owner.close(); owner = undefined;
      for (const substitution of ["symlink", "directory", "ancestor", "rename", "hardlink"]) {
        const context = { ...rootHandleContext(capability) };
        const close = createWatchIo(context, true);
        const child = path.join(directory, "d0", "deep");
        const moved = path.join(directory, "moved-" + substitution);
        try {
          const guard = await watchGuard(context, child);
          if (substitution === "hardlink") {
            const file = path.join(child, "file");
            const [before] = await watchStats(context, [{ path: file, directory: false,
              dev: (await fsp.lstat(file, { bigint: true })).dev, ino: (await fsp.lstat(file, { bigint: true })).ino }]);
            await fsp.link(file, moved);
            const [after] = await watchStats(context, [{ path: file, dev: before.dev, ino: before.ino, directory: false }]);
            assert.ok(after.nlink > before.nlink);
            await fsp.unlink(moved);
          } else {
            const selected = substitution === "ancestor" ? path.dirname(child) : child;
            await fsp.rename(selected, moved);
            try {
              if (substitution === "symlink" || substitution === "ancestor") await fsp.symlink(moved, selected, process.platform === "win32" ? "junction" : "dir");
              else await fsp.mkdir(selected);
              await assert.rejects(watchAssert(context, guard), e => ["path-mismatch", "not-file"].includes(e.code));
            } finally {
              await fsp.rm(selected, { recursive: true, force: true });
              await fsp.rename(moved, selected);
            }
          }
        } finally { await close(); }
      }
      console.log("worker-ok");
    } finally { await owner?.close(); await fsp.rm(directory, { recursive: true, force: true }); }
  `], { cwd: new URL("..", import.meta.url), timeout: 60_000, env: { ...process.env, FS_SAFE_NATIVE_MODE: "off" } });
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe("worker-ok");
}, 65_000);

it.skipIf(!!process.versions.bun || !!process.versions.deno)("rejects an ancestor relocation above a physically pinned Root", async () => {
  const result = await exec(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { root } from "./dist/root.js";
    import { rootHandleContext } from "./dist/root-handle-context.js";
    import { createWatchIo, watchRootCurrent } from "./dist/watch-io.js";
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-above-root-")));
    await fs.mkdir(path.join(base, "parent", "root"), { recursive: true });
    const context = { ...rootHandleContext(await root(path.join(base, "parent", "root"))) };
    const close = createWatchIo(context, true);
    try {
      await watchRootCurrent(context);
      await fs.rename(path.join(base, "parent"), path.join(base, "moved"));
      await fs.symlink(path.join(base, "moved"), path.join(base, "parent"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(watchRootCurrent(context), e => ["outside-workspace", "path-mismatch"].includes(e.code));
      console.log("pinned-root");
    } finally { await close(); await fs.rm(base, { recursive: true, force: true }); }
  `], { cwd: new URL("..", import.meta.url), timeout: 30_000, env: { ...process.env, FS_SAFE_NATIVE_MODE: "off" } });
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe("pinned-root");
}, 35_000);
