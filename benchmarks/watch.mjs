import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

export async function registerWatch({ api, workspace, register, contract }) {
  // Older measured distributions have no watch export to cover.
  if (typeof api.watch !== "function") return;
  const directory = path.join(workspace, "watch-lifecycle");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "file"), "fixture");
  const root = await api.root(directory);
  const scopes = [{ path: "", kind: "tree" }];
  const initial = api.watch(root, { mode: "poll", scopes, onDirty() {} });
  try { contract("WatchSubscription", initial); await initial.ready; }
  finally { await initial.close(); }
  for (const mode of ["node", "poll"]) {
    register("watch/" + mode + "-lifecycle", async () => {
      const owner = api.watch(root, { mode, scopes, onDirty() {} });
      try {
        await owner.ready;
        await owner.update([{ path: "file", kind: "entry" }]);
        await owner.reconcile();
        assert.equal(owner.health().state, "ready");
      } finally { await owner.close(); }
      await owner[Symbol.asyncDispose]();
      assert.equal(owner.health().workers, 0);
    }, { covers: ["watch", "WatchSubscription.update", "WatchSubscription.reconcile", "WatchSubscription.health", "WatchSubscription.close", "WatchSubscription.[Symbol.asyncDispose]"],
      workloadSemantics: "One isolated subscription, entry update, guarded reconciliation and joined retirement; no throughput-win claim." });
  }
}
