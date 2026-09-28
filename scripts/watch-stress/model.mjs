import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mutations, scopeSets, selectedDepth } from "./model-operations.mjs";
import { consumer, guardedSnapshot, sorted } from "./model-oracle.mjs";
import { createRenameWriter } from "./rename-writer.mjs";

export async function runSequence({ root, watch }, operations, { mode = "poll", settleMs = 40, maxPendingPaths = 8 } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "watch-model-"));
  const directory = path.join(temporary, "root"), outside = path.join(temporary, "outside");
  await fs.mkdir(directory); await fs.mkdir(outside);
  const model = new Map([["", "directory"]]);
  const writer = createRenameWriter();
  const mutate = mutations(directory, outside, model, writer);
  const capability = await root(directory);
  let owner;
  let step = -1, checkpoints = 0, invalidations = 0;
  async function checkpoint() {
    await delay(settleMs);
    await owner.subscription.reconcile();
    await owner.flush();
    const truth = await guardedSnapshot(capability, owner.scopes);
    assert.deepEqual(sorted(truth), sorted(new Map([...model].filter(([name]) => selectedDepth(owner.scopes, name) >= 0))), "guarded walk differs from mutation model");
    assert.deepEqual(sorted(owner.cache), sorted(truth), "consumer cache contains stale or missing content");
    // Event hints may start a subsequent pass while the guarded oracle is reading.
    assert.ok(["ready", "reconciling"].includes(owner.subscription.health().state));
    assert.equal(owner.subscription.health().failure, undefined);
    assert.equal(owner.health.some(value => value.state === "unavailable"), false, "healthy Root became unavailable without authority/backend/limit loss");
    checkpoints++;
  }
  try {
    owner = consumer(capability, watch, mode, scopeSets[0], maxPendingPaths);
    await owner.subscription.ready; await owner.flush();
    for (step = 0; step < operations.length; step++) {
      const op = operations[step];
      switch (op.kind) {
        case "checkpoint": await checkpoint(); break;
        case "scopes":
          await owner.setScopes(scopeSets[op.value % scopeSets.length]);
          await owner.flush();
          break;
        case "supersede": {
          const reconciling = owner.subscription.reconcile();
          // Let an old pass start, then replace it twice without yielding.
          await Promise.resolve();
          const retired = owner.setScopes([{ path: "d3", kind: "tree", depth: 32 }]);
          const replacement = owner.setScopes(scopeSets[op.value % scopeSets.length]);
          await assert.rejects(retired, { name: "AbortError" });
          await Promise.all([reconciling, replacement]);
          await owner.flush();
          break;
        }
        case "reopen": {
          await checkpoint();
          const scopes = owner.scopes;
          const active = owner.subscription.reconcile();
          await owner.close();
          await assert.rejects(active, { name: "AbortError" });
          invalidations += owner.events.length;
          await mutate({ ...op, kind: "put" });
          await delay(settleMs);
          await owner.close(); // Surface any callback admitted while the owner was closed.
          assert.equal(owner.subscription.health().state, "closed");
          owner = consumer(capability, watch, mode, scopes, maxPendingPaths);
          await owner.subscription.ready; await owner.flush();
          break;
        }
        default: await mutate(op);
      }
    }
    await checkpoint();
    invalidations += owner.events.length;
    return { checkpoints, invalidations, operations: operations.length, ...writer.metrics };
  } catch (cause) {
    throw Object.assign(new Error(`watch model ${mode}, step ${step}: ${cause.message}; rename metrics: ${JSON.stringify(writer.metrics)}`, { cause }),
      { renameMetrics: { ...writer.metrics } });
  } finally {
    try {
      await owner?.close();
      await delay(settleMs);
      await owner?.close();
    }
    finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
}
