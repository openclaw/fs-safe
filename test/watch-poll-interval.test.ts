import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, getFsSafeNativeConfig } from "../src/config.js";
import type { NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import * as transport from "../src/watch-native.js";
import { watch, type WatchOptions, type WatchSubscription } from "../src/watch.js";

let dir: string;
let owner: WatchSubscription | undefined;
const config = getFsSafeNativeConfig();
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-poll-interval-"))); });
afterEach(async () => {
  await owner?.close(); owner = undefined;
  vi.useRealTimers(); vi.restoreAllMocks(); configureFsSafeNative(config);
  await fs.rm(dir, { recursive: true, force: true });
});

it.each(["poll", "native-off", "registration-failure", "anchor-failure", "events"] as const)("uses the selected transport interval (%s)", async scenario => {
  const capability = await root(dir);
  if (scenario === "native-off") configureFsSafeNative({ mode: "off" });
  else if (scenario !== "poll") {
    const unavailable = () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); };
    vi.spyOn(transport, "watchBinding").mockReturnValue({
      watchRegister: scenario === "registration-failure" ? unavailable : () => 1,
      watchAdd: scenario === "anchor-failure" ? unavailable : () => {},
      watchUnregister() {},
    } as unknown as NativeBinding);
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const timers = vi.spyOn(globalThis, "setTimeout");
  let passes = 0;
  let completed!: () => void;
  const nextPass = new Promise<void>(resolve => { completed = resolve; });
  owner = watch(capability, {
    mode: scenario === "poll" ? "poll" : scenario === "events" ? "events" : "auto",
    scopes: [{ path: "", kind: "tree" }], pollIntervalMs: 25,
    onInvalidate() {}, onHealth(health) { if (health.state === "ready" && ++passes === 2) completed(); },
  });
  await owner.ready; await vi.advanceTimersByTimeAsync(0);
  expect(owner.health().mode).toBe(scenario === "events" ? "events" : "poll");
  const interval = scenario === "events" ? 30_000 : 25;
  expect(timers.mock.calls.at(-1)![1]).toBe(interval);
  await vi.advanceTimersByTimeAsync(interval - 1);
  expect(passes).toBe(1);
  await vi.advanceTimersByTimeAsync(1); await nextPass;
  expect(passes).toBe(2);
});

it.each([
  { intervalMs: 80, pollIntervalMs: 25, expected: 25 },
  { intervalMs: 80, expected: 80 },
  { expected: 1000 },
])("applies polling precedence %j", async ({ expected, ...intervals }) => {
  const capability = await root(dir);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const timers = vi.spyOn(globalThis, "setTimeout");
  owner = watch(capability, { mode: "poll", scopes: [], ...intervals, onInvalidate() {} });
  await owner.ready; await vi.advanceTimersByTimeAsync(0);
  expect(timers.mock.calls.at(-1)![1]).toBe(expected);
});

it.each([0, -1, 1.1, NaN, Infinity, 19, 2_147_483_648])("rejects pollIntervalMs %s even when events are selected", async pollIntervalMs => {
  const capability = await root(dir);
  const options: WatchOptions = { mode: "events", scopes: [], pollIntervalMs, onInvalidate() {} };
  expect(() => watch(capability, options)).toThrow(RangeError);
});
