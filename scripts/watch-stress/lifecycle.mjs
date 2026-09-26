import { assert, fs, path, delay, fixture, observe, watch, wholeTree, compare, truthWalk, cleanup } from "./oracle.mjs";
import { resources, threads, trend } from "./metrics.mjs";
import { __setFsSafeTestHooksForTest as hooks } from "../../dist/test-hooks.js";

async function warm() {
  const f = await fixture("warm"); const observer = observe(f);
  try { await observer.subscription.ready; await observer.checkpoint(); }
  finally { await cleanup([() => observer.close()], [() => f.remove()]); }
  await delay(100);
}

export async function fanout() {
  await warm(); const baseline = await resources(), phases = [];
  for (const count of [64, 256]) {
    const fixtures = [], observers = [];
    try {
      for (let n = 0; n < count; n++) {
        const f = await fixture("fanout"); fixtures.push(f);
        await fs.writeFile(path.join(f.directory, "value"), "initial");
        const observer = observe(f); observers.push(observer);
        await observer.subscription.ready;
      }
      assert.equal(threads(), 1, "subscriptions must share exactly one hub thread");
      const opened = await resources();
      for (let n = 0; n < count; n++) {
        await fs.writeFile(path.join(fixtures[n].directory, "value"), `updated-${n}`);
        await observers[n].checkpoint();
      }
      for (const observer of observers) await observer.close();
      await delay(100);
      const closed = await resources();
      assert.equal(closed.hubThreads, 0); assert.ok(closed.handles <= baseline.handles, `handles leaked: ${closed.handles} > ${baseline.handles}`);
      phases.push({ count, opened, closed, checkpoints: count });
    } finally {
      await cleanup(observers.map(observer => () => observer.close()), fixtures.map(f => () => f.remove()));
    }
  }
  return { baseline, phases };
}

export async function lifecycle() {
  await warm(); const baseline = await resources();
  const f = await fixture("lifecycle"); const samples = [], begin = performance.now();
  let observer;
  try {
    await fs.writeFile(path.join(f.directory, "value"), "content");
    for (let cycle = 1; cycle <= 10_000; cycle++) {
      observer = observe(f); await observer.subscription.ready; await observer.flush();
      if (cycle % 1000 === 0) await observer.checkpoint();
      await observer.close(); observer = undefined;
      if (cycle % 1000 === 0) {
        await delay(100);
        const sample = { cycle, seconds: (performance.now() - begin) / 1000, ...(await resources()) };
        samples.push(sample); assert.equal(sample.hubThreads, 0);
        assert.ok(sample.handles <= baseline.handles, `handle leak after ${cycle} cycles`);
        process.stderr.write(`lifecycle ${cycle}/10000\n`);
      }
    }
    for (let n = 0; n < 100; n++) {
      const owner = watch(f.capability, { mode: "events", scopes: wholeTree, onInvalidate() { assert.fail("callback after immediate close"); } });
      const ready = owner.ready.then(() => "resolved", error => error.name);
      await owner.close(); assert.equal(await ready, "AbortError");
    }
    for (let n = 0; n < 100; n++) {
      let entered, release;
      const admitted = new Promise(resolve => { entered = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      hooks({ beforeWatchRegistration: () => { entered(); return held; } });
      const controller = new AbortController();
      const owner = watch(f.capability, { mode: "events", scopes: wholeTree, signal: controller.signal, onInvalidate() { assert.fail("aborted generation delivered"); } });
      const ready = owner.ready.then(() => "resolved", error => error.name);
      try { await admitted; controller.abort(); release(); await owner.close(); assert.equal(await ready, "AbortError"); }
      finally { release(); hooks(); await owner.close(); }
    }
    observer = observe(f); await observer.subscription.ready; await observer.flush();
    const before = observer.metrics.invalidations, calls = [];
    for (let n = 0; n < 1000; n++) calls.push(observer.setScopes([{ path: `generation-${n}`, kind: "entry" }]).then(() => "resolved", error => error.name));
    const settled = await Promise.all(calls);
    assert.deepEqual(settled.slice(0, -1), Array(999).fill("AbortError"));
    assert.equal(settled.at(-1), "resolved");
    assert.equal(observer.metrics.invalidations - before, 1, "a superseded generation delivered");
    await fs.writeFile(path.join(f.directory, "generation-999"), "last"); await observer.checkpoint();
    await observer.close(); observer = undefined;
    for (let n = 0; n < 100; n++) {
      let closing, notifications = 0;
      const owner = watch(f.capability, { mode: "events", scopes: wholeTree, onInvalidate() { notifications++; closing = owner.close(); } });
      const ready = owner.ready.then(() => "resolved", error => error.name);
      assert.equal(await ready, "AbortError"); await closing; assert.equal(notifications, 1);
    }
    await delay(100);
    const closed = await resources(), memory = trend(samples.slice(2));
    assert.equal(closed.hubThreads, 0); assert.ok(closed.handles <= baseline.handles);
    assert.ok(memory.growth <= 32 * 1024 * 1024, "lifecycle RSS grew by more than 32 MiB after 3000 cycles");
    return { cycles: 10_000, immediateClose: 100, abortDuringAdmission: 100, scopeChanges: 1000, callbackClose: 100, baseline, closed, memory, samples };
  } finally { hooks(); await cleanup([() => observer?.close()], [() => f.remove()]); }
}

export async function adversarial() {
  const results = [];
  for (const replacement of [false, true]) {
    const f = await fixture("root-swap"), previous = f.directory + "-old";
    let observer;
    try {
      await fs.writeFile(path.join(f.directory, "original"), "kept");
      observer = observe(f); await observer.subscription.ready; await observer.flush();
      await fs.rename(f.directory, previous);
      if (replacement) { await fs.mkdir(f.directory); await fs.writeFile(path.join(f.directory, "OUTSIDE_SENTINEL-replacement"), "private"); }
      await assert.rejects(observer.subscription.reconcile());
      assert.equal(observer.subscription.health().state, "unavailable");
      await observer.flush(); compare(observer.cache, await truthWalk(previous));
      results.push({ scenario: replacement ? "root-replace" : "root-rename", health: observer.subscription.health().state, oracle: "original root retained" });
    } finally { await cleanup([() => observer?.close()], [() => f.remove(), () => fs.rm(previous, { recursive: true, force: true })]); }
  }
  const f = await fixture("adversarial"), outside = await fixture("outside"); let observer;
  try {
    await fs.mkdir(path.join(f.directory, "watched"));
    await fs.writeFile(path.join(f.directory, "watched", "inside"), "inside");
    observer = observe(f); await observer.subscription.ready; await observer.flush();
    await fs.rename(path.join(f.directory, "watched"), path.join(f.directory, "retired"));
    await fs.symlink(outside.directory, path.join(f.directory, "watched"), process.platform === "win32" ? "junction" : "dir");
    for (let n = 0; n < 1000; n++) {
      await fs.writeFile(path.join(outside.directory, "OUTSIDE_SENTINEL-" + n), "private");
      await fs.writeFile(path.join(f.directory, "inside-churn"), `inside-${n}`);
    }
    await observer.checkpoint();
    assert.equal([...observer.cache.keys()].some(name => name.includes("OUTSIDE_SENTINEL")), false);
    results.push({ scenario: "symlink-swap-during-churn", oracle: "matched", outsideNames: 0 });
    await fs.mkdir(path.join(f.directory, "delete-tree", "child"), { recursive: true });
    await fs.writeFile(path.join(f.directory, "delete-tree", "child", "value"), "content");
    await observer.checkpoint();
    const start = performance.now();
    await fs.rm(path.join(f.directory, "delete-tree"), { recursive: true });
    const deleteMs = performance.now() - start;
    await observer.checkpoint(); results.push({ scenario: "recursive-delete", deleteMs, oracle: "matched" });
    for (let n = 0; n < 10_000; n++) {
      await fs.writeFile(path.join(f.directory, "same-name"), String(n));
      await fs.unlink(path.join(f.directory, "same-name"));
    }
    await observer.checkpoint(); results.push({ scenario: "same-name-create-delete", operations: 20_000, oracle: "matched" });
    return { results, ...observer.metrics };
  } finally { await cleanup([() => observer?.close()], [() => f.remove(), () => outside.remove()]); }
}
