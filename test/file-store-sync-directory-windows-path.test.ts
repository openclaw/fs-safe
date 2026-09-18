import fsSync, { type BigIntStats, type Stats } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { ensureStoreDirectorySync } from "../src/file-store-boundary.js";
import {
  assertSyncStoreDirectoryReceipt,
  ensureSyncStoreDirectory,
} from "../src/file-store-sync-directory.js";
import * as canonicalPath from "../src/realpath.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const driveRoot = "C:\\";
const exactStat = {
  dev: 1n,
  ino: 2n,
  mode: 0o700n,
  isDirectory: () => true,
  isSymbolicLink: () => false,
} as BigIntStats;
const numericStat = { ...exactStat, dev: 1, ino: 2, mode: 0o700 } as unknown as Stats;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

function simulateWindowsDirectory() {
  Object.defineProperty(process, "platform", { value: "win32" });
  const mkdir = vi.spyOn(fsSync, "mkdirSync").mockReturnValue(undefined);
  const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation(
    ((...args: Parameters<typeof fsSync.lstatSync>) =>
      args[1]?.bigint ? exactStat : numericStat) as typeof fsSync.lstatSync,
  );
  const realpath = vi.spyOn(canonicalPath, "realpathSync").mockReturnValue(driveRoot);
  const open = vi.spyOn(fsSync, "openSync");
  return { mkdir, lstat, realpath, open };
}

it.each(["?", "."])("adapts %s namespace root dispatch while retaining the store receipt spelling", (namespace) => {
  const observed = simulateWindowsDirectory();
  const namespaceRoot = `\\\\${namespace}\\${driveRoot}`;

  const receipt = ensureStoreDirectorySync({
    rootDir: namespaceRoot,
    targetDir: namespaceRoot,
    mode: 0o700,
    messagePrefix: "store",
  });

  expect(receipt).toMatchObject({ dir: namespaceRoot, realPath: driveRoot });
  expect(typeof receipt.exactStat.ino).toBe("bigint");
  expect(observed.mkdir).toHaveBeenCalledExactlyOnceWith(driveRoot, { recursive: true, mode: 0o700 });
  expect(observed.lstat).toHaveBeenCalled();
  expect(observed.lstat.mock.calls.every(([input]) => input === driveRoot)).toBe(true);
  expect(observed.realpath).toHaveBeenCalled();
  expect(observed.realpath.mock.calls.every(([input]) => input === driveRoot)).toBe(true);
  expect(observed.open).not.toHaveBeenCalled();
});

it("rejects an alias returned by initial ordinary canonicalization", () => {
  const observed = simulateWindowsDirectory();
  observed.realpath.mockReturnValue(`${driveRoot}store:payload`);
  const namespaceRoot = `\\\\?\\${driveRoot}`;

  expect(() => ensureSyncStoreDirectory({
    rootDir: namespaceRoot,
    targetDir: namespaceRoot,
    mode: 0o700,
    messagePrefix: "store",
  })).toThrow(expect.objectContaining({ code: "invalid-path" }));

  expect(observed.realpath).toHaveBeenCalledExactlyOnceWith(driveRoot);
  expect(observed.mkdir).toHaveBeenCalledTimes(1);
  expect(observed.open).not.toHaveBeenCalled();
});

it("rejects an alias in a retained canonical receipt before filesystem observation", () => {
  const observed = simulateWindowsDirectory();

  expect(() => assertSyncStoreDirectoryReceipt({
    dir: `\\\\?\\${driveRoot}`,
    realPath: `${driveRoot}store:payload`,
    exactStat,
  })).toThrow(expect.objectContaining({ code: "invalid-path" }));

  expect(observed.lstat).not.toHaveBeenCalled();
  expect(observed.realpath).not.toHaveBeenCalled();
});
