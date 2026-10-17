import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchSubscription } from "../src/watch.js";
import { isWatchPathError } from "../src/watch-scan.js";
import * as io from "../src/watch-io.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let owner: WatchSubscription | undefined;
afterEach(async () => { await owner?.close(); owner = undefined; vi.restoreAllMocks(); });
const descriptorRace = (syscall = "realpath") => Object.assign(new Error("temporary descriptor race"), { code: "EBADF", syscall });

it("recovers a deep listing descriptor race after rechecking Root authority", async () => {
  const directory = await tempRoot("watch-listing-descriptor-");
  const child = path.join(directory, "one", "two", "three");
  await fs.mkdir(child, { recursive: true });
  await fs.writeFile(path.join(child, "file"), "inside");
  const capability = await root(directory);
  owner = watch(capability, { mode: "poll", intervalMs: 60_000, scopes: [{ path: "", kind: "tree" }], onInvalidate() {} });
  await owner.ready;
  const listing = io.watchListing, current = io.watchRootCurrent;
  let failed = false, rechecks = 0;
  vi.spyOn(io, "watchRootCurrent").mockImplementation(async root => {
    if (failed) rechecks++;
    await current(root);
  });
  vi.spyOn(io, "watchListing").mockImplementation(async (...args) => {
    if (args[1] === child && !failed) { failed = true; throw descriptorRace(); }
    return listing(...args);
  });
  await expect(owner.reconcile()).resolves.toBeUndefined();
  expect(failed).toBe(true);
  expect(rechecks).toBeGreaterThan(0);
  expect(owner.health().state).toBe("ready");
  expect(owner.health().failure).toBeUndefined();
  await owner.reconcile();
  expect(await capability.readText(path.join("one", "two", "three", "file"))).toBe("inside");
});

it("keeps a Root observation descriptor failure terminal", async () => {
  const directory = await tempRoot("watch-root-descriptor-");
  owner = watch(await root(directory), { mode: "poll", intervalMs: 60_000, scopes: [{ path: "", kind: "tree" }], onInvalidate() {} });
  await owner.ready;
  const failure = descriptorRace();
  vi.spyOn(io, "watchRootCurrent").mockRejectedValue(failure);
  await expect(owner.reconcile()).rejects.toBe(failure);
  expect(owner.health().state).toBe("unavailable");
});

it("does not treat other descriptor syscalls as path churn", () => {
  expect(isWatchPathError(descriptorRace("read"))).toBe(false);
  expect(isWatchPathError(descriptorRace("lstat"))).toBe(false);
  expect(isWatchPathError(descriptorRace())).toBe(true);
});
