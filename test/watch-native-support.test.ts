import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";
import { nativeWatchSupported, NodeWatchBackend } from "../src/watch-node.js";

it.skipIf(nativeWatchSupported)("refuses unprovable native routes without allocating workers or silently polling", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-watch-unavailable-"));
  const admitted = await root(directory);
  const observer = watch(admitted, { mode: "node", scopes: [{ path: "", kind: "tree" }], onDirty() { throw new Error("unexpected hint"); } });
  try {
    await expect(observer.ready).rejects.toMatchObject({ code: "helper-unavailable", details: { operation: "watch" } });
    expect(observer.health()).toMatchObject({ mode: "node", state: "unavailable", workers: 0, directories: 0 });
    await expect(observer.close()).resolves.toBeUndefined();
    expect(() => new NodeWatchBackend(() => {}, () => {}, true, 2)).toThrow(/descriptor-bound native observation/);
    const poll = watch(admitted, { mode: "poll", scopes: [{ path: "", kind: "tree" }], onDirty() {} });
    try { await poll.ready; expect(poll.health()).toMatchObject({ mode: "poll", state: "ready", workers: 0 }); }
    finally { await poll.close(); }
  } finally { await observer.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
