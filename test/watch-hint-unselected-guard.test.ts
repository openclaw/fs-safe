import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { rootHandleContext } from "../src/root-handle-context.js";
import { admittedNativeChanges } from "../src/watch-hints.js";
import * as io from "../src/watch-io.js";
import { scanWatch, watchScopes } from "../src/watch-scan.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("retains a parent guard across churn only when selected: %s", async selected => {
  const directory = await tempRoot("watch-unselected-parent-");
  await fs.mkdir(path.join(directory, "selected"));
  await fs.writeFile(path.join(directory, "selected", "config"), "selected");
  const changedParent = path.join(directory, selected ? "selected" : "unrelated");
  if (!selected) await fs.mkdir(changedParent);
  await fs.writeFile(path.join(changedParent, "child"), "noise");
  const context = rootHandleContext(await root(directory));
  const scopes = watchScopes([{ path: path.join("selected", "config"), kind: "entry" }]);
  const signal = new AbortController().signal;
  const snapshot = await scanWatch(context, scopes, {
    maxEntries: 100, maxDirectories: 100, maxPendingPaths: 100, admitting: true,
  }, signal, async () => {});
  const assert = io.watchAssert;
  let removed = false;
  vi.spyOn(io, "watchAssert").mockImplementation(async (root, guard) => {
    await assert(root, guard);
    if (guard.dir === changedParent && !removed) {
      removed = true;
      await fs.rm(changedParent, { recursive: true });
    }
  });
  const observed = admittedNativeChanges(context, scopes, snapshot, snapshot, {
    hints: [{ directory: selected ? "selected" : "unrelated", name: "child", event: "rename" }], overflow: false,
  }, signal, 100);
  if (selected) await expect(observed).rejects.toMatchObject({ code: "path-mismatch" });
  else await expect(observed).resolves.toEqual([]);
  expect(removed).toBe(true);
});
