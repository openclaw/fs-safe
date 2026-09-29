import { vi } from "vitest";
import { getNativeBinding } from "../../src/native.js";
import * as scanner from "../../src/watch-scan.js";
import type { WatchInvalidation } from "../../src/watch.js";
import type { WatchSubscription } from "../../src/watch.js";
import { setTimeout as delay } from "node:timers/promises";

/** Bounded synthetic-fixture evidence; raw backend hints never enter public invalidations. */
export function watchDiagnostics(selected: string) {
  let phase = "setup";
  let activity = 0;
  const start = performance.now();
  const timeline: unknown[] = [];
  const selectedHints: unknown[] = [];
  const stamp = () => ({ phase, ms: Math.round((performance.now() - start) * 1000) / 1000 });
  const add = (value: unknown) => { timeline.push(value); if (timeline.length > 128) timeline.shift(); };
  let previous: string | undefined;
  let latest: { before?: string; after?: string } = {};
  const scan = scanner.scanWatch;
  vi.spyOn(scanner, "scanWatch").mockImplementation(async (...args) => {
    const next = await scan(...args);
    latest = { before: previous, after: next.entries.get(selected) };
    previous = latest.after;
    add({ ...stamp(), kind: "scan", ...latest });
    return next;
  });
  const native = getNativeBinding();
  if (native?.watchRegister) {
    const register = native.watchRegister;
    vi.spyOn(native, "watchRegister").mockImplementation((root, limit, callback, persistent) => register(root, limit, batch => {
      activity++;
      add({ ...stamp(), kind: "native", ...batch });
      for (const hint of batch.hints) if (hint.name === selected) {
        selectedHints.push({ ...stamp(), ...hint, flagsHex: typeof hint.flags === "number" ? `0x${hint.flags.toString(16)}` : undefined, ...latest });
        if (selectedHints.length > 64) selectedHints.shift();
      }
      callback(batch);
    }, persistent));
  }
  return {
    phase(value: string) { phase = value; add({ ...stamp(), kind: "phase" }); },
    invalidation(value: WatchInvalidation) { activity++; add({ ...stamp(), kind: "invalidation", value, ...latest }); },
    async quiet(owner: WatchSubscription, observationMs = 200) {
      const deadline = performance.now() + 5000;
      do {
        await owner.reconcile();
        if (performance.now() + observationMs > deadline) break;
        const observed = activity;
        await delay(observationMs);
        await owner.reconcile();
        if (activity === observed && performance.now() <= deadline) return;
      } while (performance.now() < deadline);
      throw new Error("watch fixture did not become quiet before measurement");
    },
    report() { return { selected, selectedHints, timeline }; },
  };
}
