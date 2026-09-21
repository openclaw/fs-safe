import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withExtractionDeadline } from "../src/archive-deadline.js";
import { inspectTarArchive } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); __resetFsSafeNativeConfigForTest(); });
function heldClock() {
  let now = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return () => { now = 10; };
}

it("checks monotonic expiry before a held timer callback runs", async () => {
  const expire = heldClock();
  await expect(withExtractionDeadline(10, "archive", async deadline => {
    expire(); deadline.check(); return "late";
  })).rejects.toThrow("archive timed out after 10ms");
  expect(vi.getTimerCount()).toBe(0);
});

it("refuses successful settlement after synchronous work exhausts the budget", async () => {
  const expire = heldClock();
  await expect(withExtractionDeadline(10, "archive", async () => {
    expire(); return "late";
  })).rejects.toThrow("archive timed out after 10ms");
});

it("checks again before dispatching a queued destination mutation", async () => {
  const expire = heldClock(), mutate = vi.fn(async () => "changed");
  await expect(withExtractionDeadline(10, "archive", async deadline => {
    const operation = deadline.ownDestinationMutation(mutate);
    expire(); return await operation;
  })).rejects.toThrow("archive timed out after 10ms");
  expect(mutate).not.toHaveBeenCalled();
});

it.each([undefined, null, false, new Error("caller failed")])("preserves caller rejection %j after elapsed work", async failure => {
  const expire = heldClock();
  await expect(withExtractionDeadline(10, "archive", async () => {
    expire(); throw failure;
  })).rejects.toBe(failure);
});

it.each([0, -1, Infinity, NaN])("keeps disabled deadline %s disabled", async timeoutMs => {
  const expire = heldClock();
  await expect(withExtractionDeadline(timeoutMs, "archive", async deadline => {
    expire(); deadline.check(); return await deadline.ownDestinationMutation(async () => "done");
  })).resolves.toBe("done");
  expect(vi.getTimerCount()).toBe(0);
});

it("stops public TAR inspection before the next filter after elapsed synchronous policy work", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-inspect-deadline-");
  const archivePath = path.join(directory, "input.tar");
  await fs.writeFile(archivePath, tarFixture([{ path: "first", body: "one" }, { path: "second", body: "two" }]));
  const expire = heldClock(), observed: string[] = [];
  await expect(inspectTarArchive({ archivePath, timeoutMs: 10, entryFilter: entry => {
    observed.push(entry.path); expire(); return "extract";
  } })).rejects.toThrow("inspect tar timed out after 10ms");
  expect(observed).toEqual(["first"]);
});
