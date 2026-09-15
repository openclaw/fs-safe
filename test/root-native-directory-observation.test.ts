import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { realpathSync } from "../src/realpath.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const requireNativeObservation =
  process.env.FS_SAFE_REQUIRE_NATIVE_DIRECTORY_OBSERVATION === "1";

afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

function installDirectoryObserver(
  beforeObserve?: (pathname: string, call: number) => void,
) {
  const rawLstat = fsSync.lstatSync.bind(fsSync);
  const rawRealpath = fsSync.realpathSync.native.bind(fsSync.realpathSync);
  const observeDirectory = vi.fn((pathname: string) => {
    beforeObserve?.(pathname, observeDirectory.mock.calls.length);
    const stat = rawLstat(pathname, { bigint: true });
    if (stat.isSymbolicLink()) throw Object.assign(new Error("final link rejected"), { code: "ELOOP" });
    if (!stat.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    return { dev: stat.dev, ino: stat.ino, realPath: rawRealpath(pathname) };
  });
  __setNativeLoaderForTest(() => ({ observeDirectory } as unknown as NativeBinding));
  return observeDirectory;
}

async function createDepthFixture(rootDir: string, prefix: string, depth: number, file: boolean) {
  const segments = Array.from({ length: depth }, (_, index) => `${prefix}-${index}`);
  const target = path.join(rootDir, ...segments);
  if (file) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "inside");
  } else {
    await fs.mkdir(target, { recursive: true });
  }
  return segments.join(path.sep);
}

async function measuredCalls<T>(
  run: () => Promise<T>,
  lstat: ReturnType<typeof vi.spyOn>,
  canonical: ReturnType<typeof vi.spyOn>,
  observeDirectory: ReturnType<typeof installDirectoryObserver>,
) {
  lstat.mockClear();
  canonical.mockClear();
  observeDirectory.mockClear();
  const value = await run();
  return {
    value,
    lstats: lstat.mock.calls.length,
    canonical: canonical.mock.calls.length,
    observations: observeDirectory.mock.calls.length,
  };
}

it.each(["auto", "require"] as const)(
  "fuses fixed directory observations at stat/list depths in native %s mode",
  async (mode) => {
    const rootDir = await tempRoot(`fs-safe-native-observation-${mode}-`);
    const statPaths = new Map<number, string>();
    const listPaths = new Map<number, string>();
    for (const depth of [1, 2, 8]) {
      statPaths.set(depth, await createDepthFixture(rootDir, `stat-${depth}`, depth, true));
      listPaths.set(depth, await createDepthFixture(rootDir, `list-${depth}`, depth, false));
    }
    configureFsSafeNative({ mode });
    const observeDirectory = installDirectoryObserver();
    const capability = await root(rootDir);
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const canonical = vi.spyOn(realpathSync, "native");

    for (const depth of [0, 1, 2, 8]) {
      const relative = depth === 0 ? "" : statPaths.get(depth)!;
      const calls = await measuredCalls(
        () => capability.stat(relative), lstat, canonical, observeDirectory,
      );
      expect(calls.value).toMatchObject({ isDirectory: depth === 0, isFile: depth !== 0 });
      expect(calls).toMatchObject({
        lstats: depth === 0 ? 2 : depth === 1 ? 4 : depth + 2,
        canonical: depth <= 1 ? 1 : 0,
        observations: depth <= 1 ? 0 : 2,
      });
    }

    for (const depth of [0, 1, 2, 8]) {
      const relative = depth === 0 ? "" : listPaths.get(depth)!;
      const calls = await measuredCalls(
        () => capability.list(relative), lstat, canonical, observeDirectory,
      );
      expect(Array.isArray(calls.value)).toBe(true);
      if (depth !== 0) expect(calls.value).toEqual([]);
      expect(calls).toMatchObject({
        lstats: depth === 0 ? 1 : depth + 1,
        canonical: 0,
        observations: 2,
      });
    }
  },
);

it("keeps native-off budgets explicit, including optimized root receipts", async () => {
  const rootDir = await tempRoot("fs-safe-portable-observation-budget-");
  const direct = await createDepthFixture(rootDir, "stat-1", 1, true);
  const nested = await createDepthFixture(rootDir, "stat-8", 8, true);
  const listed = await createDepthFixture(rootDir, "list-8", 8, false);
  configureFsSafeNative({ mode: "off" });
  const capability = await root(rootDir);
  const lstat = vi.spyOn(fsSync, "lstatSync");
  const canonical = vi.spyOn(realpathSync, "native");
  const unusedObserver = vi.fn() as ReturnType<typeof installDirectoryObserver>;

  for (const [relative, expected] of [
    ["", { lstats: 2, canonical: 1 }],
    [direct, { lstats: 4, canonical: 1 }],
    [nested, { lstats: 12, canonical: 2 }],
  ] as const) {
    const calls = await measuredCalls(
      () => capability.stat(relative), lstat, canonical, unusedObserver,
    );
    expect(calls).toMatchObject({ ...expected, observations: 0 });
  }
  for (const [relative, expected] of [
    ["", { lstats: 2, canonical: 2 }],
    [listed, { lstats: 11, canonical: 2 }],
  ] as const) {
    const calls = await measuredCalls(
      () => capability.list(relative), lstat, canonical, unusedObserver,
    );
    expect(calls).toMatchObject({ ...expected, observations: 0 });
  }
});

it.each([0, 1, 101, 1000])(
  "keeps the fixed native list cost independent of %i metadata entries",
  async (width) => {
    const rootDir = await tempRoot(`fs-safe-native-observation-width-${width}-`);
    const selected = path.join(rootDir, "selected");
    await fs.mkdir(selected);
    for (let start = 0; start < width; start += 64) {
      await Promise.all(Array.from({ length: Math.min(64, width - start) }, (_, offset) => {
        const index = start + offset;
        return fs.writeFile(path.join(selected, `entry-${String(index).padStart(4, "0")}`), "x");
      }));
    }
    configureFsSafeNative({ mode: "auto" });
    const observeDirectory = installDirectoryObserver();
    const capability = await root(rootDir);
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const canonical = vi.spyOn(realpathSync, "native");
    const calls = await measuredCalls(
      () => capability.list("selected", { withFileTypes: true }),
      lstat,
      canonical,
      observeDirectory,
    );
    expect(calls.value).toHaveLength(width);
    expect(calls).toMatchObject({ lstats: width + 2, canonical: 0, observations: 2 });
  },
);

it.each(["auto", "require"] as const)(
  "uses the full JavaScript path when the %s binding lacks the optional method",
  async (mode) => {
    const rootDir = await tempRoot(`fs-safe-native-observation-absent-${mode}-`);
    await fs.mkdir(path.join(rootDir, "selected"));
    configureFsSafeNative({ mode });
    __setNativeLoaderForTest(() => ({} as NativeBinding));
    const capability = await root(rootDir);
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const canonical = vi.spyOn(realpathSync, "native");
    await expect(capability.list("selected")).resolves.toEqual([]);
    expect(lstat).toHaveBeenCalledTimes(4);
    expect(canonical).toHaveBeenCalledTimes(2);
  },
);

it("retains the JavaScript path when the automatic native loader is unavailable", async () => {
  const rootDir = await tempRoot("fs-safe-native-observation-loader-unavailable-");
  await fs.mkdir(path.join(rootDir, "selected"));
  configureFsSafeNative({ mode: "auto" });
  __setNativeLoaderForTest(() => { throw new Error("native unavailable"); });
  const capability = await root(rootDir);
  await expect(capability.list("selected")).resolves.toEqual([]);
});

it.each(["auto", "require"] as const)(
  "keeps root and direct-child stat on the JavaScript fence when native observation is unavailable in %s mode",
  async (mode) => {
    const rootDir = await tempRoot(`fs-safe-native-observation-shallow-${mode}-`);
    await fs.writeFile(path.join(rootDir, "direct"), "inside");
    configureFsSafeNative({ mode });
    const unavailable = Object.assign(new Error("observation unavailable"), { code: "ENOSYS" });
    const observeDirectory = installDirectoryObserver(() => { throw unavailable; });
    const capability = await root(rootDir);
    await expect(capability.stat("")).resolves.toMatchObject({ isDirectory: true });
    await expect(capability.stat("direct")).resolves.toMatchObject({ isFile: true });
    expect(observeDirectory).not.toHaveBeenCalled();
  },
);

it("falls back before admission but never after a native receipt is admitted", async () => {
  const rootDir = await tempRoot("fs-safe-native-observation-fallback-");
  const selected = path.join(rootDir, "selected");
  await fs.mkdir(selected);
  await fs.writeFile(path.join(selected, "value"), "inside");
  configureFsSafeNative({ mode: "auto" });
  const nativeFailure = Object.assign(new Error("observation unavailable"), { code: "ENOSYS" });
  const initialFailure = installDirectoryObserver((_pathname, call) => {
    if (call === 1) throw nativeFailure;
  });
  const capability = await root(rootDir);
  await expect(capability.list("selected")).resolves.toEqual(["value"]);
  expect(initialFailure).toHaveBeenCalledTimes(1);

  const finalFailure = installDirectoryObserver((_pathname, call) => {
    if (call === 2) throw nativeFailure;
  });
  await expect(capability.list("selected")).rejects.toMatchObject({ code: "path-mismatch" });
  expect(finalFailure).toHaveBeenCalledTimes(2);
});

it("keeps an accepted directory alias on the established resolver", async () => {
  const rootDir = await tempRoot("fs-safe-native-observation-alias-");
  const selected = path.join(rootDir, "selected");
  await fs.mkdir(selected);
  await fs.writeFile(path.join(selected, "value"), "inside");
  await fs.symlink(selected, path.join(rootDir, "alias"), process.platform === "win32" ? "junction" : "dir");
  configureFsSafeNative({ mode: "auto" });
  const observeDirectory = installDirectoryObserver();
  const capability = await root(rootDir);
  await expect(capability.list("alias")).resolves.toEqual(["value"]);
  // The helper rejects the final link before admission; JavaScript then
  // retains the public alias semantics and owns both guard observations.
  expect(observeDirectory).toHaveBeenCalledTimes(1);
});

it.each(["stat", "list"] as const)(
  "rejects a selected-directory substitution during final native %s observation",
  async (operation) => {
    const container = await tempRoot(`fs-safe-native-observation-race-${operation}-`);
    const rootDir = path.join(container, "root");
    const selected = path.join(rootDir, "selected");
    const outside = path.join(container, "outside");
    await fs.mkdir(selected, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(selected, "inside"), "inside");
    await fs.writeFile(path.join(outside, "secret"), "outside");
    configureFsSafeNative({ mode: "auto" });
    const observeDirectory = installDirectoryObserver((pathname, call) => {
      if (call !== 2 || path.resolve(pathname) !== selected) return;
      fsSync.renameSync(selected, `${selected}-original`);
      fsSync.symlinkSync(outside, selected, process.platform === "win32" ? "junction" : "dir");
    });
    const capability = await root(rootDir);
    const result = operation === "stat"
      ? capability.stat("selected/inside")
      : capability.list("selected");
    await expect(result).rejects.toMatchObject({ code: "path-mismatch" });
    expect(observeDirectory).toHaveBeenCalledTimes(2);
  },
);

it("rejects an ordinary selected-directory replacement at the native fence", async () => {
  const rootDir = await tempRoot("fs-safe-native-observation-directory-replacement-");
  const selected = path.join(rootDir, "selected");
  await fs.mkdir(selected);
  configureFsSafeNative({ mode: "auto" });
  installDirectoryObserver((_pathname, call) => {
    if (call !== 2) return;
    fsSync.renameSync(selected, `${selected}-original`);
    fsSync.mkdirSync(selected);
  });
  const capability = await root(rootDir);
  await expect(capability.list("selected")).rejects.toMatchObject({ code: "path-mismatch" });
});

it("exports an exact same-handle observation from the bundled binding", async (context) => {
  let native: NativeBinding;
  try {
    native = __loadBundledNativeForTest();
  } catch (error) {
    if (requireNativeObservation) throw error;
    return context.skip("native binding unavailable");
  }
  if (!native.observeDirectory) {
    if (requireNativeObservation) {
      throw new Error("native directory observation ABI is unavailable");
    }
    return context.skip("directory observation unavailable");
  }
  const container = await tempRoot("fs-safe-native-observation-integration-");
  const rootDir = path.join(container, "directory");
  await fs.mkdir(rootDir);
  const observed = native.observeDirectory(rootDir);
  const exact = fsSync.lstatSync(rootDir, { bigint: true });
  expect(observed).toMatchObject({ dev: exact.dev, ino: exact.ino });
  expect(path.resolve(observed.realPath)).toBe(path.resolve(fsSync.realpathSync.native(rootDir)));

  // Linux procfs uses this exact suffix as an annotation for unlinked handles;
  // a live directory with the same spelling must remain observable.
  const literalDeletedSuffix = path.join(container, "literal (deleted)");
  await fs.mkdir(literalDeletedSuffix);
  const literalObserved = native.observeDirectory(literalDeletedSuffix);
  const literalExact = fsSync.lstatSync(literalDeletedSuffix, { bigint: true });
  expect(literalObserved).toMatchObject({ dev: literalExact.dev, ino: literalExact.ino });
  expect(path.resolve(literalObserved.realPath))
    .toBe(path.resolve(fsSync.realpathSync.native(literalDeletedSuffix)));

  const alias = path.join(container, "alias");
  await fs.symlink(rootDir, alias, process.platform === "win32" ? "junction" : "dir");
  expect(() => native.observeDirectory!(alias)).toThrow();
});
