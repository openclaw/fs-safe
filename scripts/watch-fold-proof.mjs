import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";

/** Public API only; reconcile drives settlement, including delayed native delivery. */
export async function foldProof(api, { baseline = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-fold-")));
  const values = [];
  let owner;
  try {
    await fs.mkdir(path.join(directory, "noise"), { recursive: true });
    const caseInsensitive = !!await fs.stat(path.join(directory, "NOISE")).catch(() => undefined);
    // Let fixture-creation event IDs settle before starting the stream.
    if (process.platform === "darwin") await delay(3000);
    owner = api.watch(await api.root(directory), { mode: "events", intervalMs: 60_000,
      scopes: [{ path: "skills", kind: "tree", depth: 8 }],
      onInvalidate: value => { values.push(value); } });
    await owner.ready;
    const settle = async () => {
      // Include delayed/coalesced FSEvents delivery, not just the configured latency.
      for (let i = 0; i < 20; i++) { await delay(150); await owner.reconcile(); }
    };
    await settle(); values.length = 0;
    for (let i = 0; i < 1000; i++) writeFileSync(path.join(directory, "noise", String(i)), "x");
    // Hold JS delivery across several FSEvents flushes, as a busy consumer does.
    // This also exercises native callback retry without flooding the kernel queue.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    await settle();
    const siblingOverflows = values.filter(value => value.reason === "overflow").length;
    const target = path.join(directory, caseInsensitive ? "SKILLS" : "skills");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "created"), "selected");
    const delivered = () => values.some(value => value.reason === "event" && value.changes?.some(change => change.path === path.join("skills", "created")));
    const deadline = performance.now() + 10_000;
    while (!delivered() && performance.now() < deadline) await delay(20);
    const detected = delivered(); // Reconcile must not satisfy native discovery.
    await settle();
    const result = { platform: process.platform, arch: process.arch, baseline, caseInsensitive, writes: 1000,
      siblingOverflows, overflows: values.filter(value => value.reason === "overflow").length, detected, health: owner.health() };
    console.log(JSON.stringify({ foldProof: result }));
    assert.equal(result.health.state, "ready");
    assert.equal(result.health.mode, "events");
    assert.equal(detected, true);
    if (!baseline) assert.equal(result.overflows, 0);
    return result;
  } finally {
    await owner?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  let installed;
  try {
    if (command === "baseline") {
      installed = await fs.mkdtemp(path.join(os.tmpdir(), "watch-fold-published-"));
      execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "@openclaw/fs-safe@0.22.0"],
        { cwd: installed, stdio: "inherit", shell: process.platform === "win32" });
      // Windows keeps loaded addon DLLs locked until their process exits.
      execFileSync(process.execPath, [process.argv[1], "baseline-installed", path.join(installed, "node_modules", "@openclaw", "fs-safe", "dist")], { stdio: "inherit" });
    } else {
      const baseline = command === "baseline-installed";
      const base = baseline ? process.argv[3] : path.resolve("dist");
      const api = { ...await import(pathToFileURL(path.join(base, "root.js"))), ...await import(pathToFileURL(path.join(base, "watch.js"))) };
      await foldProof(api, { baseline });
    }
  } finally { if (installed) await fs.rm(installed, { recursive: true, force: true }); }
}
