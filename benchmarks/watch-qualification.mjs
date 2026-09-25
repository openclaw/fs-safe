import assert from "node:assert/strict";
import { watch as nodeWatch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { root } from "@openclaw/fs-safe/root";
import { watch } from "@openclaw/fs-safe/watch";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-watch-cost-"));
const directories = [directory];
try {
  for (let i = 0; i < 10; i++) {
    const child = path.join(directory, String(i));
    await fs.mkdir(child); directories.push(child);
    await Promise.all(Array.from({ length: 100 }, (_, n) => fs.writeFile(path.join(child, String(n)), "fixture")));
  }
  const admitted = await root(directory);
  const baselineStart = performance.now();
  const baseline = directories.map(dir => nodeWatch(dir, () => {}));
  const baselineRegistrationMs = performance.now() - baselineStart;
  for (const watcher of baseline) watcher.close();
  // Baseline close is deliberately not labeled a native join.
  const results = [];
  for (const mode of ["node", "poll"]) {
    let changes = 0;
    const started = performance.now();
    const beforeRss = process.memoryUsage().rss;
    const observer = watch(admitted, { mode, intervalMs: 30_000, scopes: [{ path: "", kind: "tree" }], onDirty() { changes++; } });
    try {
      await observer.ready;
      const startupMs = performance.now() - started;
      const resources = observer.health();
      const idleCpu = process.cpuUsage();
      // A bounded measurement interval, not a readiness/stability workaround.
      await delay(1000);
      const cpu = process.cpuUsage(idleCpu);
      const initial = changes;
      const editStarted = performance.now();
      await fs.writeFile(path.join(directory, "0/0"), "changed " + mode);
      if (mode === "node") {
        while (changes === initial && performance.now() - editStarted < 5000) await delay(5);
        assert.ok(changes > initial, "real event after idle must invalidate");
      }
      const editHintMs = mode === "node" ? performance.now() - editStarted : null;
      const reconcileStarted = performance.now();
      await observer.reconcile();
      const reconcileMs = performance.now() - reconcileStarted;
      const closeStarted = performance.now();
      await observer.close();
      const closeMs = performance.now() - closeStarted;
      assert.equal(observer.health().workers, 0);
      assert.equal(observer.health().directories, 0);
      results.push({ mode, startupMs, idleCpuMs: (cpu.user + cpu.system) / 1000,
        rssDeltaBytes: process.memoryUsage().rss - beforeRss, editHintMs, reconcileMs, closeMs, resources });
    } finally { await observer.close(); }
  }
  console.log(JSON.stringify({ node: process.versions.node, bun: process.versions.bun ?? null,
    platform: process.platform, arch: process.arch, fixture: { files: 1000, directories: 11 },
    baseline: { registrations: baseline.length, registrationMs: baselineRegistrationMs, semantics: "raw registrations only; no guards, scan, readiness, or joined-close proof" },
    results }, null, 2));
} finally { await fs.rm(directory, { recursive: true, force: true }); }
