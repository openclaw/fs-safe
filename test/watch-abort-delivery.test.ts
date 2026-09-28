import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it.each(["starting", "ready"] as const)("receives cancellation despite stopped propagation while %s", async phase => {
  const directory = await tempRoot("fs-safe-watch-abort-delivery-");
  await fs.writeFile(path.join(directory, "value"), "value");
  const capability = await root(directory);
  const controller = new AbortController();
  const callerAbort = vi.fn((event: Event) => event.stopImmediatePropagation());
  controller.signal.onabort = callerAbort;
  const subscription = watch(capability, {
    mode: "poll", scopes: [{ path: "", kind: "tree" }],
    signal: controller.signal, onInvalidate() {},
  });
  try {
    if (phase === "ready") await subscription.ready;
    controller.abort();
    expect(callerAbort).toHaveBeenCalledTimes(1);
    expect(controller.signal.onabort).toBe(callerAbort);
    // close() must already have fenced new work, without a manual close here.
    await expect(subscription.reconcile()).rejects.toMatchObject({ name: "AbortError" });
    if (phase === "starting") await expect(subscription.ready).rejects.toMatchObject({ name: "AbortError" });
  } finally { await subscription.close(); }
  expect(subscription.health()).toMatchObject({ state: "closed", directories: 0 });
  expect(controller.signal.onabort).toBe(callerAbort);
});

it("keeps a pre-aborted subscription closed before admission", async () => {
  const directory = await tempRoot("fs-safe-watch-pre-aborted-");
  const controller = new AbortController();
  controller.abort();
  const subscription = watch(await root(directory), {
    mode: "poll", scopes: [], signal: controller.signal, onInvalidate() {},
  });
  try { await expect(subscription.ready).rejects.toMatchObject({ name: "AbortError" }); }
  finally { await subscription.close(); }
  expect(subscription.health()).toMatchObject({ state: "closed", directories: 0 });
});
