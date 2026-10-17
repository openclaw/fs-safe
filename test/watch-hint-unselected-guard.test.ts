import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { FsSafeError } from "../src/errors.js";
import { rootHandleContext } from "../src/root-handle-context.js";
import { admittedNativeChanges } from "../src/watch-hints.js";
import * as io from "../src/watch-io.js";
import { encodeWatchError, decodeWatchError } from "../src/watch-io-error.js";
import { scanWatch, watchScopes } from "../src/watch-scan.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it.each([
  { selected: false, timing: "capture" }, { selected: true, timing: "capture" },
  { selected: false, timing: "assert" }, { selected: true, timing: "assert" },
  { selected: false, timing: "unstable" },
  { selected: false, timing: "bad-realpath" }, { selected: true, timing: "bad-realpath" },
  { selected: false, timing: "bad-realpath-persistent" }, { selected: false, timing: "bad-lstat" },
])("fences parent churn ($timing, selected=$selected)", async ({ selected, timing }) => {
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
  const capture = io.watchGuard;
  let removed = false;
  const remove = async (guard: Awaited<ReturnType<typeof capture>>) => {
    if (guard.dir === changedParent && !removed) {
      removed = true;
      await fs.rm(changedParent, { recursive: true });
    }
  };
  vi.spyOn(io, "watchGuard").mockImplementation(async (root, name) => {
    if (name === changedParent && timing.startsWith("bad-") && (timing !== "bad-realpath" || !removed)) {
      if (timing === "bad-realpath" && !removed) {
        removed = true;
        await fs.rm(changedParent, { recursive: true });
      }
      throw decodeWatchError(structuredClone(encodeWatchError(Object.assign(new Error("descriptor race"), {
        code: "EBADF", syscall: timing === "bad-lstat" ? "lstat" : "realpath",
      }))));
    }
    const guard = await capture(root, name);
    if (timing === "capture") await remove(guard);
    return guard;
  });
  vi.spyOn(io, "watchAssert").mockImplementation(async (root, guard) => {
    if (timing === "unstable" && guard.dir === changedParent) {
      throw new FsSafeError("path-mismatch", "persistent replacement");
    }
    await assert(root, guard);
    if (timing === "assert") await remove(guard);
  });
  const observed = admittedNativeChanges(context, scopes, snapshot, snapshot, {
    hints: [{ directory: selected ? "selected" : "unrelated", name: "child", event: "rename" }], overflow: false,
  }, signal, 100);
  if (selected || timing === "unstable" || timing === "bad-realpath-persistent" || timing === "bad-lstat") {
    await expect(observed).rejects.toMatchObject({ code: timing.startsWith("bad-") ? "EBADF" : "path-mismatch" });
  }
  else await expect(observed).resolves.toEqual([]);
  if (timing === "unstable" || timing === "bad-realpath-persistent" || timing === "bad-lstat") {
    expect(vi.mocked(io.watchGuard).mock.calls.filter(([, name]) => name === changedParent)).toHaveLength(timing === "bad-lstat" ? 1 : 3);
  } else expect(removed).toBe(true);
});

it("retains a selected alias guard already used by an earlier hint", async () => {
  const directory = await tempRoot("watch-selected-alias-");
  const selected = path.join(directory, "selected");
  await fs.mkdir(selected);
  await fs.writeFile(path.join(selected, "config"), "selected");
  const context = rootHandleContext(await root(directory));
  const scopes = watchScopes([{ path: path.join("selected", "config"), kind: "entry" }]);
  const signal = new AbortController().signal;
  const snapshot = await scanWatch(context, scopes, {
    maxEntries: 100, maxDirectories: 100, maxPendingPaths: 100, admitting: true,
  }, signal, async () => {});
  // Model case-insensitive resolution on every test filesystem; identity stays real.
  const resolve = io.watchResolve;
  vi.spyOn(io, "watchResolve").mockImplementation((root, name, options) =>
    resolve(root, name === "./alias" ? "./selected" : name, options));
  const assert = io.watchAssert;
  let checks = 0;
  vi.spyOn(io, "watchAssert").mockImplementation(async (root, guard) => {
    if (guard.dir === selected && ++checks === 2) await fs.rm(selected, { recursive: true });
    await assert(root, guard);
  });
  await expect(admittedNativeChanges(context, scopes, snapshot, snapshot, {
    hints: [
      { directory: "alias", name: "config", event: "change" },
      { directory: "alias", name: "child", event: "change" },
    ], overflow: false,
  }, signal, 100)).rejects.toMatchObject({ code: "path-mismatch" });
});
