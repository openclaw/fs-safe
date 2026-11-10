import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { sidecarStagingPath } from "../src/sidecar-lock-staging.js";
import * as timing from "../src/timing.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

it.each(["async", "sync"] as const)("Root %s waits for a reclaim guard's complete publication", async kind => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-guard-publication-");
  const target = path.join(directory, "state"), guard = `${target}.lock.reclaim`;
  const stage = sidecarStagingPath(guard);
  fs.writeFileSync(stage, '{"owner":"reclaimer"}');
  fs.linkSync(stage, guard);
  const payload = vi.fn(() => ({ owner: "waiter" }));
  const finish = vi.fn(() => {
    expect(payload).not.toHaveBeenCalled();
    expect(fs.statSync(guard).nlink).toBe(2);
    fs.unlinkSync(stage);
    fs.unlinkSync(guard);
  });
  vi.spyOn(timing, "sleep").mockImplementation(async () => { finish(); });
  vi.spyOn(timing, "sleepSync").mockImplementation(finish);
  const options = { lockRoot: await root(directory), payload, timeoutMs: Infinity, retry: { retries: 1, minTimeout: 1, maxTimeout: 1 } };
  const owner = kind === "async" ? await acquireFileLock(target, options) : acquireFileLockSync(target, options);
  try {
    expect(finish).toHaveBeenCalledOnce();
    expect(await owner.verifyStillHeld()).toBe(true);
  } finally { await owner.release(); }
});

it("Root sync still rejects a foreign hardlinked reclaim guard", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-guard-foreign-");
  const target = path.join(directory, "state"), guard = `${target}.lock.reclaim`;
  const foreign = path.join(directory, "foreign");
  fs.writeFileSync(foreign, "foreign owner");
  fs.linkSync(foreign, guard);
  const lockRoot = await root(directory);
  expect(() => acquireFileLockSync(target, { lockRoot, payload: () => ({}) })).toThrow(expect.objectContaining({ code: "hardlink" }));
  expect(fs.readFileSync(foreign, "utf8")).toBe("foreign owner");
});
