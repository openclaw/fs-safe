import { assert, fs, path, delay, fixture, observe, populate, isolatedEdit, cleanup, diagnostics } from "./oracle.mjs";
import { resources, percentile, trend } from "./metrics.mjs";
import { writeFileSync } from "node:fs";
import { assessSoakMemory, collectedMemory, SOAK_MINUTES } from "./memory-policy.mjs";

// Exactly 10,000 awaited mutations, covering files and directory identities.
export async function burst(f, batch, onMutation) {
  for (let n = 0; n < 1000; n++) {
    const a = path.join(f.directory, `burst-${n % 32}`), b = a + "-moved";
    await fs.mkdir(a);
    await fs.writeFile(path.join(a, "a"), `${batch}-${n}`);
    await fs.appendFile(path.join(a, "a"), "-modified");
    await fs.rename(path.join(a, "a"), path.join(a, "b"));
    await fs.mkdir(path.join(a, "child"));
    await fs.rename(a, b);
    await fs.writeFile(path.join(b, "child", "kept"), "content");
    if (n === 999) {
      await fs.writeFile(path.join(f.directory, "dir-0", "file-0"), `persisted-${batch}`);
      if (f.retained) await fs.rm(f.retained, { recursive: true });
      else await fs.unlink(path.join(b, "b"));
      f.retained = path.join(f.directory, "retained-" + batch);
      await fs.rename(b, f.retained);
    } else {
      await fs.unlink(path.join(b, "b"));
      await fs.rm(path.join(b, "child"), { recursive: true });
      await fs.rmdir(b);
    }
    onMutation?.();
  }
  return 10_000;
}

export async function scale() {
  const f = await fixture("scale"); let observer;
  try {
    await populate(f, 2000, 25);
    const before = await resources(), start = performance.now();
    observer = observe(f);
    await observer.subscription.ready;
    const readyMs = performance.now() - start;
    await observer.flush();
    const admitted = await resources();
    const reconcileStart = performance.now();
    await observer.subscription.reconcile();
    const reconcileMs = performance.now() - reconcileStart;
    await observer.checkpoint();
    assert.equal(observer.cache.size, 52_001);
    await observer.close();
    return { files: 50_000, directories: 2001, readyMs, reconcileMs, before, admitted, closed: await resources(), ...observer.metrics };
  } finally { await cleanup([() => observer?.close()], [() => f.remove()]); }
}

export async function churn() {
  const f = await fixture("churn"); let observer;
  try {
    await populate(f, 32, 8);
    observer = observe(f); await observer.subscription.ready; await observer.flush();
    // Block JS while creating more distinct entries than the default detail
    // budget. A single subsequent guarded pass must lose detail, regardless of
    // native event coalescing or the speed of the sustained async writer.
    const pressureBefore = observer.metrics.overflows;
    for (let n = 0; n < 1024; n++) writeFileSync(path.join(f.directory, "pressure-" + n), "retained-pressure");
    await observer.checkpoint();
    const pressureOverflows = observer.metrics.overflows - pressureBefore;
    assert.ok(pressureOverflows > 0, "bounded-detail pressure did not invalidate the whole scope");
    const begin = performance.now(), samples = [], latency = [];
    let operations = 0, batches = 0;
    do {
      operations += await burst(f, batches++);
      await observer.checkpoint();
      latency.push(await isolatedEdit(f, observer, batches));
      samples.push({ seconds: (performance.now() - begin) / 1000, ...(await resources()) });
      assert.equal(observer.subscription.health().failure, undefined);
    } while (performance.now() - begin < 300_000);
    await observer.checkpoint();
    const memory = trend(samples.slice(Math.min(2, samples.length - 2)));
    const peakRss = process.resourceUsage().maxRSS * 1024;
    const result = { durationSeconds: (performance.now() - begin) / 1000, operations, batches, pressureOperations: 1024, pressureOverflows,
      latencySamples: latency.length, p50Ms: percentile(latency, 0.5), p99Ms: percentile(latency, 0.99), peakRss, memory, samples, ...observer.metrics };
    diagnostics.scenarioMetrics = result;
    assert.ok(memory.growth <= 64 * 1024 * 1024, "post-warmup RSS grew by more than 64 MiB");
    assert.ok(peakRss < 512 * 1024 * 1024, "RSS exceeded 512 MiB");
    return result;
  } finally { await cleanup([() => observer?.close()], [() => f.remove()]); }
}

export async function soak() {
  const f = await fixture("soak"); let observer;
  try {
    await populate(f, 16, 8);
    observer = observe(f); await observer.subscription.ready; await observer.flush();
    const begin = performance.now(), samples = [];
    let edits = 0, operations = 0, cycles = 0, bursts = 0;
    for (let minute = 1; minute <= SOAK_MINUTES; minute++) {
      const deadline = begin + minute * 60_000;
      if (minute % 5 === 0) { operations += await burst(f, minute); bursts++; }
      while (performance.now() < deadline) {
        await fs.writeFile(path.join(f.directory, "low-rate"), `edit-${++edits}`);
        const peer = observe(f, { scopes: [{ path: "low-rate", kind: "entry" }] });
        try { await peer.subscription.ready; await peer.checkpoint(); cycles++; }
        finally { await cleanup([() => peer.close()]); }
        await delay(Math.min(1000, Math.max(0, deadline - performance.now())));
      }
      await observer.checkpoint();
      const counts = await resources();
      const memory = await collectedMemory();
      const sample = { seconds: (performance.now() - begin) / 1000, ...counts, ...memory };
      samples.push(sample);
      process.stderr.write(JSON.stringify({ scenario: "soak", checkpoint: minute, ...sample }) + "\n");
    }
    const peakRss = process.resourceUsage().maxRSS * 1024;
    const memory = assessSoakMemory(samples, peakRss);
    const result = { durationSeconds: (performance.now() - begin) / 1000, edits, operations, cycles, bursts, peakRss, samples, memory, ...observer.metrics };
    diagnostics.scenarioMetrics = result;
    assert.deepEqual(memory.failures, [], memory.failures.join("; "));
    return result;
  } finally { await cleanup([() => observer?.close()], [() => f.remove()]); }
}
