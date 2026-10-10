import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
// @ts-expect-error the shared proof runs against compiled entry points in both contexts.
import { partialBindingProof } from "./fixtures/partial-native-binding.mjs";

const expected = ["auto-open", "auto-probe", "auto-hash", "auto-write", "auto-tree-copy",
  "require-open", "require-probe", "require-hash", "require-write", "require-tree-copy",
  "auto-terminal-error", "require-terminal-error", "complete-capability-set",
  "copy-capabilities-win32", "copy-capabilities-linux", "auto-copy-in", "require-copy-in"];

it("selects complete capabilities and preserves terminal errors on the main thread", async () => {
  expect(await partialBindingProof()).toEqual(expected);
});

it("selects complete capabilities and preserves terminal errors in a real Worker", async () => {
  const worker = new Worker(new URL("./fixtures/partial-native-binding.mjs", import.meta.url));
  try {
    const [[completed], [exitCode]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
    expect(completed).toEqual(expected);
    expect(exitCode).toBe(0);
  } finally {
    await worker.terminate();
  }
});
