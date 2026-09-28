import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";

export async function ancestorProof(api, { mode, kind = "entry", durationMs = 8000, expectation = "zero" }) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-ancestor-")));
  const stop = new SharedArrayBuffer(4);
  let owner, joined;
  const hints = [], failures = [], phases = [];
  let operations = 0;
  try {
    await fs.mkdir(path.join(directory, "noise"));
    await fs.writeFile(path.join(directory, "content"), "initial");
    await fs.mkdir(path.join(directory, "directory"));
    const posix = process.platform !== "win32";
    if (posix) await fs.symlink("content", path.join(directory, "alias"));
    const ready = [], exits = [];
    for (let index = 0; index < 4; index++) {
      const worker = new Worker(new URL("./watch-ancestor-churn.mjs", import.meta.url), { workerData: { directory: path.join(directory, "noise", `writer-${index}`), stop } });
      exits.push(new Promise((resolve, reject) => {
        worker.on("message", value => { if (value.operations !== undefined) operations += value.operations; });
        worker.once("error", reject);
        worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`churn exited ${code}`)));
      }));
      ready.push(new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); }));
    }
    joined = Promise.all(exits);
    void joined.catch(() => {});
    await Promise.all(ready);
    const scopes = kind === "tree" ? [{ path: "", kind: "tree", depth: 1 }]
      : ["content", "missing", "directory", ...(posix ? ["alias"] : [])].map(path => ({ path, kind: "entry" }));
    owner = api.watch(await api.root(directory), { mode, scopes, intervalMs: 60_000, pollIntervalMs: 25,
      onInvalidate: value => hints.push(value), onHealth: value => { if (value.failure) failures.push(value.failure); } });
    await owner.ready;
    assert.equal(owner.health().mode, mode);
    const started = performance.now();
    const change = async (label, selected, mutate) => {
      // Drain preceding delivery so each phase must observe a fresh invalidation.
      await delay(100);
      const first = hints.length;
      await mutate();
      const deadline = performance.now() + 5000;
      while (!hints.slice(first).some(value => value.changes?.some(change => change.path === selected))) {
        if (performance.now() >= deadline) throw new Error(`missing selected detail: ${label}; overflows=${hints.filter(h => h.reason === "overflow").length}`);
        assert.equal(failures.length, 0);
        await delay(20);
      }
      phases.push(label);
    };
    // Measurement runs accept overflow-only invalidations; correctness runs require detail.
    if (expectation === "zero") {
      await change("create", "missing", () => fs.writeFile(path.join(directory, "missing"), "created"));
      await change("content", "content", () => fs.appendFile(path.join(directory, "content"), "-changed"));
      if (posix) {
        await change("attribute", "content", () => fs.chmod(path.join(directory, "content"), 0o400));
        await change("directory attribute", "directory", () => fs.chmod(path.join(directory, "directory"), 0o500));
        await change("symlink retarget", "alias", async () => {
          await fs.symlink("missing", path.join(directory, "next-alias"));
          await fs.rename(path.join(directory, "next-alias"), path.join(directory, "alias"));
        });
        await change("symlink attribute after re-arm", "alias", () => fs.lchmod(path.join(directory, "alias"), 0o600));
      }
      await change("delete", "missing", () => fs.unlink(path.join(directory, "missing")));
      await change("recreate", "missing", () => fs.writeFile(path.join(directory, "missing"), "again"));
      await change("content after re-arm", "missing", () => fs.appendFile(path.join(directory, "missing"), "-changed"));
    }
    await delay(Math.max(0, durationMs - (performance.now() - started)));
    Atomics.store(new Int32Array(stop), 0, 1);
    await joined;
    await delay(500); // include pending native loss notifications after the writer stops
    const result = { platform: process.platform, arch: process.arch, mode, kind,
      durationMs: Math.round(performance.now() - started), operations,
      operationsPerSecond: Math.round(operations / ((performance.now() - started) / 1000)),
      overflows: hints.filter(value => value.reason === "overflow").length, invalidations: hints.length,
      health: owner.health(), phases };
    console.log(JSON.stringify({ ancestorProof: result }));
    assert.equal(failures.length, 0);
    if (expectation === "zero") assert.equal(result.overflows, 0);
    if (expectation === "storm") assert.ok(result.overflows > 1, "baseline must reproduce repeated overflow");
    return result;
  } finally {
    Atomics.store(new Int32Array(stop), 0, 1);
    await joined;
    await owner?.close();
    await fs.chmod(path.join(directory, "directory"), 0o700).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = pathToFileURL(path.resolve(process.env.FS_SAFE_PROOF_DIST ?? "dist") + path.sep);
  const api = { ...await import(new URL("root.js", base)), ...await import(new URL("watch.js", base)) };
  await ancestorProof(api, { mode: process.env.FS_SAFE_PROOF_MODE ?? "events", kind: process.env.FS_SAFE_PROOF_KIND ?? "entry",
    expectation: process.env.FS_SAFE_PROOF_EXPECT ?? "zero", durationMs: Number(process.env.FS_SAFE_PROOF_MS ?? 8000) });
}
