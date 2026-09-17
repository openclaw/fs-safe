import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { ensureSyncStoreDirectory } from "../src/file-store-sync-directory.js";
import * as canonicalPath from "../src/realpath.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

function directoryChain(root: string, depth: number): string[] {
  return Array.from({ length: depth + 1 }, (_, index) =>
    path.join(root, ...Array.from({ length: index }, (__, part) => `d${part}`)));
}

async function repairTarget(depth: number): Promise<string[]> {
  const root = await tempRoot("fs-safe-sync-store-admission-");
  const directories = directoryChain(root, depth);
  await fs.mkdir(directories.at(-1)!, { recursive: true });
  await Promise.all(directories.map((directory, index) =>
    fs.chmod(directory, index === depth ? 0o755 : 0o700)));
  return directories;
}

itPosix.each([
  { depth: 0, matchingLstats: 4, repairedLstats: 7, newLstats: 7 },
  { depth: 4, matchingLstats: 24, repairedLstats: 60, newLstats: 64 },
  { depth: 16, matchingLstats: 84, repairedLstats: 228, newLstats: 244 },
].flatMap((budget) => ["matching", "repaired", "new"].map((layout) => ({
  ...budget,
  layout,
}))))(
  "bounds directory admissions for $layout directories at depth $depth",
  async ({ depth, layout, matchingLstats, repairedLstats, newLstats }) => {
    const container = await tempRoot("fs-safe-sync-store-admission-budget-");
    const root = path.join(container, "store");
    const directories = directoryChain(root, depth);
    const target = directories.at(-1)!;
    if (layout !== "new") {
      await fs.mkdir(target, { recursive: true });
      await Promise.all(directories.map((directory) =>
        fs.chmod(directory, layout === "matching" ? 0o750 : 0o755)));
    }
    const lstats = vi.spyOn(fsSync, "lstatSync");
    const realpaths = vi.spyOn(canonicalPath.realpathSync, "native");
    const fstats = vi.spyOn(fsSync, "fstatSync");
    const fchmods = vi.spyOn(fsSync, "fchmodSync");
    const pathnameChmod = vi.spyOn(fsSync, "chmodSync");
    const previousUmask = process.umask(0o077);
    try {
      const receipt = ensureSyncStoreDirectory({
        rootDir: root,
        targetDir: target,
        mode: 0o750,
        messagePrefix: "store",
      });
      expect(receipt.exactStat.mode & 0o7777n).toBe(0o750n);
    } finally {
      process.umask(previousUmask);
    }

    expect(lstats).toHaveBeenCalledTimes(layout === "matching" ? matchingLstats :
      layout === "new" ? newLstats : repairedLstats);
    expect(realpaths).toHaveBeenCalledTimes(layout === "matching" ? depth + 5 : 4 * depth + 8);
    expect(fstats).toHaveBeenCalledTimes(layout === "matching" ? 0 : 2 * (depth + 1));
    expect(fchmods).toHaveBeenCalledTimes(layout === "matching" ? 0 : depth + 1);
    expect(pathnameChmod).not.toHaveBeenCalled();
    expect(lstats.mock.calls.every((call) => call[1]?.bigint === true)).toBe(true);
    expect(fstats.mock.calls.every((call) => call[1]?.bigint === true)).toBe(true);
    for (const directory of directories) {
      expect((await fs.stat(directory)).mode & 0o7777).toBe(0o750);
    }
  },
);

itPosix.each([
  { depth: 0, subject: "target" },
  { depth: 4, subject: "root" },
  { depth: 4, subject: "parent" },
  { depth: 4, subject: "target" },
].flatMap((location) => ["after-open", "after-chmod"].flatMap((phase) =>
  ["identity", "symlink"].map((fault) => ({ ...location, phase, fault })))))(
  "rejects $subject $fault changes $phase at depth $depth",
  async ({ depth, subject, phase, fault }) => {
    const directories = await repairTarget(depth);
    const root = directories[0]!;
    const target = directories.at(-1)!;
    const changed = subject === "root" ? root :
      subject === "parent" ? directories.at(-2)! : target;
    const realLstatSync = fsSync.lstatSync.bind(fsSync);
    const realOpenSync = fsSync.openSync.bind(fsSync);
    const realFchmodSync = fsSync.fchmodSync.bind(fsSync);
    let invalid = false;
    let descriptor: number | undefined;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args) => {
      const stat = realLstatSync(...args);
      if (!stat || !invalid || String(args[0]) !== changed || typeof stat.ino !== "bigint") return stat;
      return Object.assign(Object.create(stat), fault === "identity" ?
        { ino: stat.ino + (1n << 56n) } : { isSymbolicLink: () => true });
    }) as typeof fsSync.lstatSync);
    vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
      const opened = realOpenSync(...args);
      if (String(args[0]) === target) {
        descriptor = opened;
        if (phase === "after-open") invalid = true;
      }
      return opened;
    }) as typeof fsSync.openSync);
    const chmod = vi.spyOn(fsSync, "fchmodSync").mockImplementation((opened, mode) => {
      realFchmodSync(opened, mode);
      if (opened === descriptor && phase === "after-chmod") invalid = true;
    });
    const close = vi.spyOn(fsSync, "closeSync");

    expect(() => ensureSyncStoreDirectory({
      rootDir: root,
      targetDir: target,
      mode: 0o700,
      messagePrefix: "store",
    })).toThrow(expect.objectContaining({ code: "outside-workspace" }));

    expect(descriptor).toBeDefined();
    expect(chmod).toHaveBeenCalledTimes(phase === "after-open" ? 0 : 1);
    expect(close).toHaveBeenCalledExactlyOnceWith(descriptor);
    expect((await fs.stat(target)).mode & 0o7777).toBe(phase === "after-open" ? 0o755 : 0o700);
  },
);

itPosix.each([0, 4].flatMap((depth) => ["denied", "ineffective"].map((result) => ({
  depth,
  result,
}))))(
  "fails closed on $result descriptor mode repair at depth $depth",
  async ({ depth, result }) => {
    const directories = await repairTarget(depth);
    const target = directories.at(-1)!;
    const denied = Object.assign(new Error("directory ownership denies fchmod"), { code: "EPERM" });
    vi.spyOn(fsSync, "fchmodSync").mockImplementation(() => {
      if (result === "denied") throw denied;
    });
    const close = vi.spyOn(fsSync, "closeSync");
    const pathnameChmod = vi.spyOn(fsSync, "chmodSync");

    let failure: unknown;
    try {
      ensureSyncStoreDirectory({
        rootDir: directories[0]!,
        targetDir: target,
        mode: 0o700,
        messagePrefix: "store",
      });
    } catch (error) {
      failure = error;
    }

    if (result === "denied") expect(failure).toBe(denied);
    else expect(failure).toEqual(expect.objectContaining({ code: "insecure-permissions" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(pathnameChmod).not.toHaveBeenCalled();
    expect((await fs.stat(target)).mode & 0o7777).toBe(0o755);
  },
);

itPosix.each(["before-chmod", "after-chmod"])(
  "rejects changed canonical ancestry %s while the repair descriptor is open",
  async (phase) => {
    const directories = await repairTarget(4);
    const root = directories[0]!;
    const target = directories.at(-1)!;
    const realFstatSync = fsSync.fstatSync.bind(fsSync);
    const realRealpath = canonicalPath.realpathSync.native;
    let descriptorChecks = 0;
    let rejectedWhileOpen = false;
    const close = vi.spyOn(fsSync, "closeSync");
    const chmod = vi.spyOn(fsSync, "fchmodSync");
    vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args) => {
      descriptorChecks += 1;
      return realFstatSync(...args);
    }) as typeof fsSync.fstatSync);
    vi.spyOn(canonicalPath.realpathSync, "native").mockImplementation((input) => {
      if (input === target && descriptorChecks >= (phase === "before-chmod" ? 1 : 2)) {
        rejectedWhileOpen = close.mock.calls.length === 0;
        return path.join(root, "..", "outside");
      }
      return realRealpath(input);
    });

    expect(() => ensureSyncStoreDirectory({
      rootDir: root,
      targetDir: target,
      mode: 0o700,
      messagePrefix: "store",
    })).toThrow(expect.objectContaining({ code: "outside-workspace" }));

    expect(rejectedWhileOpen).toBe(true);
    expect(chmod).toHaveBeenCalledTimes(phase === "before-chmod" ? 0 : 1);
    expect(close).toHaveBeenCalledTimes(1);
  },
);
