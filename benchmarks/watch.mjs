import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

export async function registerWatch({ api, workspace, register, contract }) {
  if (typeof api.watch !== "function") return;
  const directory = path.join(workspace, "watch-lifecycle");
  await fs.mkdir(directory);
  const root = await api.root(directory);
  const initial = api.watch(root, { mode: "poll", scopes: [], onInvalidate() {} });
  try { contract("WatchSubscription", initial); await initial.ready; }
  finally { await initial.close(); }
  register("watch/poll-lifecycle", async () => {
    const owner = api.watch(root, { mode: "poll", scopes: [{ path: "", kind: "tree" }], onInvalidate() {} });
    try {
      await owner.ready;
      await owner.setScopes([{ path: "file", kind: "entry" }]);
      await owner.reconcile();
      assert.equal(owner.health().state, "ready");
    } finally { await owner.close(); }
    await owner[Symbol.asyncDispose]();
    assert.equal(owner.health().directories, 0);
  }, { covers: ["watch", "WatchSubscription.setScopes", "WatchSubscription.reconcile", "WatchSubscription.health", "WatchSubscription.close", "WatchSubscription.[Symbol.asyncDispose]"],
    workloadSemantics: "Guarded polling lifecycle and joined retirement; no event-throughput claim." });
}
