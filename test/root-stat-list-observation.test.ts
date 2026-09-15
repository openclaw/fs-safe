import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { resolveRootContext } from "../src/root-context.js";
import { resolvePinnedObservedPathInRoot } from "../src/root-observed-path.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
});

it.skipIf(process.platform === "win32")("uses ordinary metadata within unchanged descendant observation budgets", async () => {
  const rootDir = await tempRoot("fs-safe-observation-numeric-budget-");
  await fs.mkdir(path.join(rootDir, "selected"));
  await fs.writeFile(path.join(rootDir, "direct"), "inside");
  await fs.writeFile(path.join(rootDir, "selected", "value"), "inside");
  const originalStat = fsSync.statSync.bind(fsSync);
  const originalLstat = fsSync.lstatSync.bind(fsSync);
  // Project safe IDs consistently; the budget does not depend on host inode width.
  const project = (stat: fsSync.Stats | fsSync.BigIntStats) => Object.assign(Object.create(stat),
    typeof stat.dev === "bigint" ? { dev: 7n, ino: 11n } : { dev: 7, ino: 11 });
  vi.spyOn(fsSync, "statSync").mockImplementation((candidate, options) =>
    project(originalStat(candidate, options as never)));
  const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) =>
    project(originalLstat(candidate, options as never)));
  const capability = await root(rootDir);
  const realpath = vi.spyOn(realpathSync, "native");
  const operations = [
    { run: () => capability.stat("direct"), lstats: 4, canonical: 1 },
    { run: () => capability.exists("direct"), lstats: 4, canonical: 1 },
    { run: () => capability.stat("selected/value"), lstats: 6, canonical: 2 },
    { run: () => capability.list("selected"), lstats: 4, canonical: 2 },
    { run: () => capability.list("selected", { withFileTypes: true }), lstats: 5, canonical: 2 },
  ];
  for (const operation of operations) {
    lstat.mockClear();
    realpath.mockClear();
    await operation.run();
    expect(lstat).toHaveBeenCalledTimes(operation.lstats);
    expect(realpath).toHaveBeenCalledTimes(operation.canonical);
    expect(lstat.mock.calls.every(call => call.length === 1)).toBe(true);
  }
});

it("preserves the root-only initial and final stat hooks", async () => {
  const rootDir = await tempRoot("fs-safe-root-only-observation-");
  await fs.writeFile(path.join(rootDir, "value"), "inside");
  const capability = await root(rootDir);
  const context = await resolveRootContext(rootDir);
  expect((await resolvePinnedObservedPathInRoot(context, ".", "stat"))?.receipt).toBeUndefined();
  expect((await resolvePinnedObservedPathInRoot(context, ".", "directory"))?.receipt).toBeUndefined();
  const events: string[] = [];
  __setFsSafeTestHooksForTest({
    beforeRootStatInitialObservation: () => { events.push("initial"); },
    beforeRootStatObservation: () => { events.push("final"); },
    beforeRootListObservation: () => { events.push("list"); },
  });
  await expect(capability.stat(".")).resolves.toMatchObject({ isDirectory: true });
  expect(events).toEqual(["initial", "final"]);
  events.length = 0;
  await expect(capability.list(".")).resolves.toEqual(["value"]);
  expect(events).toEqual(["list"]);
});

it.each(["selected/./value", "selected//value"])(
  "keeps unusual spelling %s on the general observation path", async spelling => {
    const rootDir = await tempRoot("fs-safe-observation-spelling-");
    await fs.mkdir(path.join(rootDir, "selected"));
    await fs.writeFile(path.join(rootDir, "selected", "value"), "inside");
    const capability = await root(rootDir);
    const context = await resolveRootContext(rootDir);
    expect((await resolvePinnedObservedPathInRoot(context, spelling, "stat"))?.receipt).toBeUndefined();
    await expect(capability.stat(spelling)).resolves.toMatchObject({ isFile: true });
    await expect(capability.stat(spelling.replace("value", "missing")))
      .rejects.toMatchObject({ code: "not-found" });
  },
);

it("rejects parent traversal before the general observation path", async () => {
  const rootDir = await tempRoot("fs-safe-observation-parent-traversal-");
  await fs.mkdir(path.join(rootDir, "selected"));
  await fs.writeFile(path.join(rootDir, "selected", "value"), "inside");
  const capability = await root(rootDir);
  const context = await resolveRootContext(rootDir);
  const spelling = "selected/../selected/value";
  expect((await resolvePinnedObservedPathInRoot(context, spelling, "stat"))?.receipt).toBeUndefined();
  const lstat = vi.spyOn(fsSync, "lstatSync");
  await expect(capability.stat(spelling)).rejects.toMatchObject({ code: "invalid-path" });
  expect(lstat).not.toHaveBeenCalled();
});

it("retains the general path for an admitted directory alias", async () => {
  const rootDir = await tempRoot("fs-safe-observation-alias-");
  const selected = path.join(rootDir, "selected");
  await fs.mkdir(selected);
  await fs.writeFile(path.join(selected, "value"), "inside");
  await fs.symlink(selected, path.join(rootDir, "alias"), process.platform === "win32" ? "junction" : "dir");
  const capability = await root(rootDir);
  const context = await resolveRootContext(rootDir);
  expect((await resolvePinnedObservedPathInRoot(context, "alias/value", "stat"))?.receipt).toBeUndefined();
  expect((await resolvePinnedObservedPathInRoot(context, "alias/", "directory"))?.receipt).toBeUndefined();
  await expect(capability.stat("alias/value")).resolves.toMatchObject({ isFile: true });
  await expect(capability.list("alias/")).resolves.toEqual(["value"]);
});

it("keeps root failure ahead of the selected directory's list error", async () => {
  const rootDir = await tempRoot("fs-safe-observation-error-order-");
  const selected = path.join(rootDir, "selected");
  await fs.mkdir(selected);
  const capability = await root(rootDir);
  const originalLstat = fsSync.lstatSync.bind(fsSync);
  const rootFailure = Object.assign(new Error("root observation denied"), { code: "EACCES" });
  const listFailure = Object.assign(new Error("list observation missing"), { code: "ENOENT" });
  __setFsSafeTestHooksForTest({
    beforeRootListObservation: () => {
      vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
        if (path.resolve(String(candidate)) === rootDir) throw rootFailure;
        return originalLstat(candidate, options as never);
      });
      throw listFailure;
    },
  });
  await expect(capability.list("selected")).rejects.toMatchObject({ code: "path-mismatch", cause: rootFailure });
});
