import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";
import { getNativeBinding } from "../src/native.js";

// Dedicated disposable Linux proof lowers the kernel limit before launching us.
it.skipIf(process.platform !== "linux" || process.env.FS_SAFE_TEST_WATCH_LIMIT !== "1")("reports real inotify ENOSPC as watch-limit and joins failed admission", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "watch-limit-"));
  const owner = watch(await root(dir), { mode: "events", scopes: [{ path: "", kind: "tree" }], onInvalidate() {} });
  try {
    await expect(owner.ready).rejects.toMatchObject({ details: { operation: "watch", code: "watch-limit" } });
    expect(owner.health()).toMatchObject({ state: "unavailable", failure: { operation: "watch", code: "watch-limit" } });
  } finally { await owner.close(); await fs.rm(dir, { recursive: true, force: true }); }
  expect(getNativeBinding()!.watchThreadCount!()).toBe(0);
});
