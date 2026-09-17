import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkedMutationDirectory,
  mutationObservationsCurrent,
  observeMutationPath,
} from "../src/pinned-mutation-observation.js";
import { realpathSync } from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe("synchronous mutation observation phases", () => {
  it("observes an overlapping Root, target and exact parent once per invocation", async () => {
    const directory = await tempRoot("fs-safe-observation-phase-");
    const root = observeMutationPath(directory)!;
    const target = observeMutationPath(path.join(directory, "new", "value"))!;
    const parent = checkedMutationDirectory(directory, directory, fs.lstatSync(directory, { bigint: true }));
    const lstat = vi.spyOn(fs, "lstatSync");
    const canonical = vi.spyOn(realpathSync, "native");
    for (let invocation = 1; invocation <= 2; invocation++) {
      expect(mutationObservationsCurrent([root, target], [parent])).toBe(true);
      expect(lstat.mock.calls.filter(([name]) => name === directory)).toHaveLength(invocation);
      expect(canonical.mock.calls.filter(([name]) => name === directory)).toHaveLength(invocation);
    }
    expect(lstat.mock.calls.map(([name]) => name)).toEqual([
      path.join(directory, "new"), directory, path.join(directory, "new"), directory,
    ]);
  });

  it("compares every role with its own exact metadata requirements", async () => {
    const directory = await tempRoot("fs-safe-observation-roles-");
    const root = observeMutationPath(directory)!;
    const stat = fs.lstatSync(directory, { bigint: true });
    const staleLinks = checkedMutationDirectory(directory, directory, { ...stat, nlink: stat.nlink + 1n });
    expect(mutationObservationsCurrent([root], [staleLinks])).toBe(false);
    const changedEpochLinks = { ...root, entry: { ...root.entry, nlink: root.entry.nlink + 1n } };
    expect(mutationObservationsCurrent([changedEpochLinks], [])).toBe(true);
    const staleMode = { ...root, identity: { ...root.identity, mode: root.identity.mode ^ 0o100n } };
    const parent = checkedMutationDirectory(directory, directory, stat);
    expect(mutationObservationsCurrent([root, staleMode], [parent])).toBe(false);
  });

  it("rejects a next component that appeared after the earlier phase", async () => {
    const directory = await tempRoot("fs-safe-observation-missing-");
    const target = observeMutationPath(path.join(directory, "new", "value"))!;
    fs.mkdirSync(path.join(directory, "new"));
    const parent = checkedMutationDirectory(directory, directory, fs.lstatSync(directory, { bigint: true }));
    expect(mutationObservationsCurrent([target], [parent])).toBe(false);
  });

  it.runIf(process.platform !== "win32")("keeps deny-alias binding independent from the exact parent", async () => {
    const directory = await tempRoot("fs-safe-observation-alias-");
    const parentPath = path.join(directory, "parent");
    const otherPath = path.join(directory, "other");
    const aliasPath = path.join(directory, "denied");
    fs.mkdirSync(parentPath);
    fs.mkdirSync(otherPath);
    fs.symlinkSync(parentPath, aliasPath, "dir");
    const denied = observeMutationPath(aliasPath)!;
    const target = observeMutationPath(path.join(parentPath, "new", "value"))!;
    const parent = checkedMutationDirectory(parentPath, parentPath, fs.lstatSync(parentPath, { bigint: true }));
    expect(mutationObservationsCurrent([denied, target], [parent])).toBe(true);
    fs.unlinkSync(aliasPath);
    fs.symlinkSync(otherPath, aliasPath, "dir");
    expect(mutationObservationsCurrent([denied, target], [parent])).toBe(false);
  });

  it("refreshes the exact parent after observations of other denied paths", async () => {
    const directory = await tempRoot("fs-safe-observation-end-fence-");
    const parentPath = path.join(directory, "parent");
    const deniedPath = path.join(directory, "denied");
    fs.mkdirSync(parentPath);
    fs.mkdirSync(deniedPath);
    const target = observeMutationPath(path.join(parentPath, "new", "value"))!;
    const denied = observeMutationPath(deniedPath)!;
    const parent = checkedMutationDirectory(parentPath, parentPath, fs.lstatSync(parentPath, { bigint: true }));
    const original = realpathSync.native;
    let replaced = false;
    vi.spyOn(realpathSync, "native").mockImplementation((input) => {
      if (input === deniedPath && !replaced) {
        replaced = true;
        fs.renameSync(parentPath, path.join(directory, "saved"));
        fs.mkdirSync(parentPath);
      }
      return original(input);
    });
    expect(mutationObservationsCurrent([target, denied], [parent])).toBe(false);
    expect(replaced).toBe(true);
    expect(fs.readdirSync(parentPath)).toEqual([]);
    expect(fs.readdirSync(path.join(directory, "saved"))).toEqual([]);
  });
});
