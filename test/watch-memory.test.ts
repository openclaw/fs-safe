import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";
import { watchBinding } from "../src/watch-native.js";

const binding = watchBinding("auto");
it.skipIf(!binding?.watchMemoryStats)("retires native allocations across close and scope generations", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "watch-memory-"));
  const capability = await root(directory);
  const before = binding!.watchMemoryStats!();
  let owner: ReturnType<typeof watch> | undefined;
  try {
    await fs.writeFile(path.join(directory, "entry"), "initial");
    for (let cycle = 0; cycle < 32; cycle++) {
      owner = watch(capability, { mode: "events", scopes: [{ path: "", kind: "tree" }], onInvalidate() {} });
      await owner.ready;
      for (let generation = 0; generation < 4; generation++) {
        await owner.setScopes([{ path: generation % 2 ? "entry" : "", kind: "tree" }]);
        await fs.writeFile(path.join(directory, "entry"), `${cycle}-${generation}`);
        await owner.reconcile();
      }
      await owner.close(); owner = undefined;
      // N-API finalizers run on the JS loop after native retirement joins.
      await expect.poll(() => {
        const stats = binding!.watchMemoryStats!();
        return [stats.registrations, stats.pendingSets, stats.payloadsLive, stats.threadsafeFunctionsLive];
      }).toEqual([before.registrations, before.pendingSets, before.payloadsLive, before.threadsafeFunctionsLive]);
    }
    const after = binding!.watchMemoryStats!();
    expect(after.threadsafeFunctionsCreated - before.threadsafeFunctionsCreated).toBeGreaterThanOrEqual(160);
    expect(after.threadsafeFunctionsCreated - before.threadsafeFunctionsCreated)
      .toBe(after.threadsafeFunctionsDestroyed - before.threadsafeFunctionsDestroyed);
    expect(after.payloadsCreated - before.payloadsCreated).toBe(after.payloadsDestroyed - before.payloadsDestroyed);
  } finally {
    await owner?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 30_000);
