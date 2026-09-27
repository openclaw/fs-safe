import { assert, fs, path, delay, fixture, observe, populate, cleanup } from "./oracle.mjs";
import { collectedMemory } from "./memory-policy.mjs";
import { resources } from "./metrics.mjs";

// A two-minute lifecycle/GC smoke; the separate hour-long soak keeps its full gate.
export async function soakShort() {
  const f = await fixture("soak-short");
  let observer;
  try {
    await populate(f, 16, 8);
    observer = observe(f);
    await observer.subscription.ready; await observer.flush();
    const started = performance.now(), samples = [];
    let edits = 0;
    while (performance.now() - started < 120_000) {
      await fs.writeFile(path.join(f.directory, "low-rate"), `edit-${++edits}`);
      const peer = observe(f, { scopes: [{ path: "low-rate", kind: "entry" }] });
      try { await peer.subscription.ready; await peer.checkpoint(); }
      finally { await cleanup([() => peer.close()]); }
      await observer.checkpoint();
      if (edits % 5 === 0) samples.push({ seconds: (performance.now() - started) / 1000, ...(await resources()), ...(await collectedMemory()) });
      await delay(500);
    }
    const settled = samples.slice(2);
    assert.ok(settled.length >= 3, "short soak needs multiple post-warmup samples");
    const growth = key => Math.max(...settled.map(sample => sample[key])) - settled[0][key];
    const heapUsedGrowth = growth("heapUsed"), externalGrowth = growth("external");
    const peakRss = process.resourceUsage().maxRSS * 1024;
    assert.ok(heapUsedGrowth <= 8 * 1024 * 1024, "short soak collected heap grew by more than 8 MiB");
    assert.ok(externalGrowth <= 8 * 1024 * 1024, "short soak external memory grew by more than 8 MiB");
    assert.ok(peakRss < 512 * 1024 * 1024, "short soak RSS reached 512 MiB");
    assert.ok(samples.every(sample => sample.hubThreads === 1), "short soak duplicated native hub threads");
    await observer.close();
    const closed = await resources();
    assert.equal(closed.hubThreads, 0);
    return { durationSeconds: (performance.now() - started) / 1000, edits, samples, heapUsedGrowth, externalGrowth, peakRss, closed, ...observer.metrics };
  } finally { await cleanup([() => observer?.close()], [() => f.remove()]); }
}
