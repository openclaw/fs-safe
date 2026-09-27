import { expect, it } from "vitest";
import fc from "fast-check";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";
import { watchBinding } from "../src/watch-native.js";
import { sequences } from "../scripts/watch-stress/model-operations.mjs";
import { runSequence } from "../scripts/watch-stress/model.mjs";

it.each([1, 42, 702])("keeps an invalidation-only cache coherent (poll seed %i)", async seed => {
  await expect(fc.assert(fc.asyncProperty(sequences(0, 14), async operations => { await runSequence({ root, watch }, operations, { mode: "poll", settleMs: 0 }); }), { seed, numRuns: 1 })).resolves.toBeUndefined();
}, 30_000);

it("detects a consumer that misses content invalidations", async () => {
  const dropChanges: typeof watch = (capability, options) => watch(capability, {
    ...options,
    onInvalidate(event) { if (!event.changes) options.onInvalidate(event); },
  });
  await expect(runSequence({ root, watch: dropChanges }, [
    { kind: "put", slot: 0, target: 0, value: 1 },
  ], { mode: "poll", settleMs: 0 })).rejects.toThrow("stale or missing content");
}, 30_000);

it("preserves overlapping deep scopes after a coarse ancestor invalidation", async () => {
  const coarseChanges: typeof watch = (capability, options) => watch(capability, {
    ...options,
    onInvalidate(event) {
      options.onInvalidate(event.changes ? { ...event, changes: [{ path: "d0", type: "structural" }] } : event);
    },
  });
  await expect(runSequence({ root, watch: coarseChanges }, [
    { kind: "deep", slot: 0, target: 0, value: 0 },
    { kind: "scopes", slot: 0, target: 0, value: 4 },
    { kind: "put", slot: 0, target: 0, value: 1 },
  ], { mode: "poll", settleMs: 0 })).resolves.toMatchObject({ checkpoints: 1 });
}, 30_000);

it.skipIf(process.env.FS_SAFE_TEST_WATCH_EVENTS !== "1")("keeps an invalidation-only cache coherent with native events", async () => {
  expect(watchBinding("events")).toBeTruthy();
  await fc.assert(fc.asyncProperty(sequences(0, 14), async operations => { await runSequence({ root, watch }, operations, { mode: "events", settleMs: 40 }); }), { seed: 702, numRuns: 2 });
}, 30_000);
