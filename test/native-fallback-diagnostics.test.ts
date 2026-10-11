import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import * as config from "../src/native-config.js";
import * as loader from "../src/native.js";
import * as warning from "../src/native-fallback-warning.js";
// @ts-expect-error shared proof exercises the built modules in both contexts.
import { nativeFallbackDiagnosticsProof } from "./fixtures/native-fallback-diagnostics.mjs";

const expected = ["loaded", "disabled", "disabled", "disabled", "package-missing",
  "load-failed", "load-failed", "load-failed", "load-failed", "load-failed", "load-failed",
  "capability-missing", "capability-missing", "unsupported-target"];

it("classifies cached native outcomes and renders path-free warnings on the main thread", () => {
  expect(nativeFallbackDiagnosticsProof({ config, loader, warning })).toEqual(expected);
});

it("classifies cached native outcomes and renders path-free warnings in a real Worker", async () => {
  const worker = new Worker(new URL("./fixtures/native-fallback-diagnostics.mjs", import.meta.url));
  try {
    const [[completed], [exitCode]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
    expect(completed).toEqual(expected);
    expect(exitCode).toBe(0);
  } finally {
    await worker.terminate();
  }
});
