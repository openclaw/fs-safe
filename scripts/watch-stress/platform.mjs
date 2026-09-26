import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync } from "node:fs";
import { assert, fs, path, delay, fixture, observe, watch, wholeTree, isolatedEdit, cleanup } from "./oracle.mjs";
import { resources, threads, threadSample, exec } from "./metrics.mjs";
import { getNativeBinding } from "../../dist/native.js";
import { __setFsSafeTestHooksForTest as hooks } from "../../dist/test-hooks.js";

export async function limitChild() {
  const f = await fixture("watch-limit"); let owner;
  try {
    await fs.mkdir(path.join(f.directory, "child"));
    const health = [];
    owner = watch(f.capability, { mode: "events", scopes: wholeTree, onInvalidate() { assert.fail("exhausted admission published a baseline"); },
      onHealth(value) { health.push({ state: value.state, code: value.failure?.code, operation: value.failure?.operation }); } });
    await assert.rejects(owner.ready, error => error.details?.code === "watch-limit");
    assert.equal(owner.health().failure.code, "watch-limit");
    assert.equal(owner.health().failure.operation, "watch");
    assert.ok(health.some(value => value.state === "unavailable" && value.code === "watch-limit"));
    await owner.close(); assert.equal(threads(), 0);
    return { health, hubThreadsAfterClose: threads() };
  } finally { await cleanup([() => owner?.close()], [() => f.remove()]); }
}

export async function limits() {
  if (process.platform === "linux") {
    const key = "fs.inotify.max_user_watches";
    const before = (await exec("sysctl", ["-n", key])).stdout.trim();
    // The trap restores the setting even if the child crashes. Other platforms
    // never invoke a POSIX shell or sysctl mutation.
    const shell = 'set -eu\nold=$(sysctl -n fs.inotify.max_user_watches)\ntrap \'sudo -n sysctl -q -w fs.inotify.max_user_watches="$old"\' EXIT HUP INT TERM\nsudo -n sysctl -q -w fs.inotify.max_user_watches=1\n"$1" "$2" --scenario limits-child';
    let child;
    try {
      child = await exec("/bin/sh", ["-c", shell, "watch-stress", process.execPath, fileURLToPath(new URL("../watch-stress.mjs", import.meta.url))], { timeout: 60_000 });
    } finally {
      const after = (await exec("sysctl", ["-n", key])).stdout.trim();
      assert.equal(after, before, "inotify watch limit was not restored");
    }
    const result = JSON.parse(child.stdout.trim()); assert.equal(result.result, "pass");
    const f = await fixture("limit-recovery"), observer = observe(f);
    try { await observer.subscription.ready; await isolatedEdit(f, observer, 1); await observer.checkpoint(); }
    finally { await cleanup([() => observer.close()], [() => f.remove()]); }
    return { kernelLimitBefore: Number(before), kernelLimitDuring: 1, restored: true, admission: result.metrics, recovery: "oracle matched" };
  }
  const f = await fixture("transport-overflow"); let observer, inject;
  const binding = getNativeBinding(), original = binding.watchRegister;
  const batches = { total: 0, overflow: 0, errors: [] };
  binding.watchRegister = (directory, limit, callback) => original(directory, limit, batch => {
    batches.total++; if (batch.overflow) batches.overflow++;
    if (batch.error) batches.errors.push(batch.error);
    callback(batch);
  });
  try {
    await fs.writeFile(path.join(f.directory, "modify"), "before");
    await fs.writeFile(path.join(f.directory, "remove"), "before");
    if (process.platform === "darwin") hooks({ afterWatchBackendCreated: (_root, _emit, testEvent) => { inject = testEvent; } });
    observer = observe(f); await observer.subscription.ready; await observer.flush();
    const naturalBefore = batches.overflow;
    for (let n = 0; n < 10_000; n++) {
      const name = path.join(f.directory, "long-name-" + String(n).padStart(6, "0") + "x".repeat(150));
      writeFileSync(name, "burst"); unlinkSync(name);
    }
    writeFileSync(path.join(f.directory, "modify"), "after");
    unlinkSync(path.join(f.directory, "remove"));
    writeFileSync(path.join(f.directory, "created"), "retained");
    await observer.checkpoint();
    const naturalTransportOverflows = batches.overflow - naturalBefore;
    let dropFlags;
    if (process.platform === "darwin") {
      const before = observer.metrics.overflows;
      inject(f.directory, 2); await delay(100); await observer.checkpoint();
      inject(f.directory, 4); await delay(100); await observer.checkpoint();
      assert.ok(observer.metrics.overflows >= before + 2);
      dropFlags = "UserDropped and KernelDropped injected through native decoder; natural FSEvents drop flags not independently inducible/observable";
    } else {
      assert.ok(naturalTransportOverflows > 0, "no native transport overflow observed");
      dropFlags = "Native transport overflow observed; public batch does not distinguish RDCW kernel loss from bounded native queue loss";
    }
    const recoveredLatencyMs = await isolatedEdit(f, observer, "recovered"); await observer.checkpoint();
    return { operations: 20_003, naturalTransportOverflows, nativeBatches: batches, dropFlags, recoveredLatencyMs, ...observer.metrics };
  } finally { hooks(); binding.watchRegister = original; await cleanup([() => observer?.close()], [() => f.remove()]); }
}

export async function idle() {
  const fixtures = [], observers = [];
  try {
    for (let n = 0; n < 16; n++) {
      const f = await fixture("idle"); fixtures.push(f);
      const observer = observe(f, { intervalMs: 3_600_000 }); observers.push(observer);
      await observer.subscription.ready; await observer.checkpoint();
    }
    await delay(2000);
    assert.equal(threads(), 1);
    const before = await resources(), threadBefore = await threadSample();
    const cpu = process.cpuUsage(), usage = process.resourceUsage(), started = performance.now();
    await delay(600_000);
    const elapsedMs = performance.now() - started, consumed = process.cpuUsage(cpu), afterUsage = process.resourceUsage();
    const cpuMs = (consumed.user + consumed.system) / 1000;
    const threadAfter = await threadSample(), after = await resources();
    assert.ok(cpuMs / elapsedMs < 0.01, "idle process used more than 1% of one CPU");
    let hubContextSwitches;
    if (process.platform === "linux") {
      assert.equal(threadBefore.length, 1); assert.equal(threadAfter.length, 1);
      assert.equal(threadBefore[0].id, threadAfter[0].id);
      hubContextSwitches = threadAfter[0].voluntary + threadAfter[0].involuntary - threadBefore[0].voluntary - threadBefore[0].involuntary;
      assert.ok(hubContextSwitches <= 30, "idle hub woke more than 30 times in ten minutes");
    }
    for (const observer of observers) await observer.checkpoint();
    return { subscriptions: 16, intervalMs: 3_600_000, elapsedMs, cpuMs, cpuPercent: cpuMs / elapsedMs * 100,
      voluntaryContextSwitches: afterUsage.voluntaryContextSwitches - usage.voluntaryContextSwitches,
      involuntaryContextSwitches: afterUsage.involuntaryContextSwitches - usage.involuntaryContextSwitches,
      hubContextSwitches, threadBefore, threadAfter, before, after, oracleCheckpoints: 32 };
  } finally {
    await cleanup(observers.map(observer => () => observer.close()), fixtures.map(f => () => f.remove()));
  }
}
