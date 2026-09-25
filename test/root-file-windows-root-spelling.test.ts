import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRootFileFinalAdmission, observeCanonicalRoot } from "../src/root-file-final-admission.js";
import { openRootFile, openRootFileSync } from "../src/root-file.js";
import { realpathSync } from "../src/realpath.js";
import { itWin32, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const shortRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\boundary";
const nativeRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\boundary";

function directoryStat(dev = 11n, ino = 22n): BigIntStats {
  return {
    dev, ino, isDirectory: () => true, isSymbolicLink: () => false,
  } as BigIntStats;
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
});

it("binds the native Windows root spelling to the already observed identity", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const calls: string[] = [];
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((candidate) => {
    calls.push(String(candidate));
    return directoryStat();
  }) as typeof fsSync.lstatSync);
  const resolve = vi.spyOn(realpathSync, "native").mockReturnValue(nativeRoot);

  expect(observeCanonicalRoot(fsSync, shortRoot)).toEqual({
    ok: true, path: nativeRoot, identity: { dev: 11n, ino: 22n },
  });
  expect(calls).toEqual([shortRoot, nativeRoot]);
  expect(resolve).toHaveBeenCalledExactlyOnceWith(shortRoot);
});

it("does not repeat metadata inspection when native Windows root spelling is unchanged", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((() =>
    directoryStat()) as typeof fsSync.lstatSync);
  vi.spyOn(realpathSync, "native").mockReturnValue(nativeRoot);

  expect(observeCanonicalRoot(fsSync, nativeRoot)).toEqual({
    ok: true, path: nativeRoot, identity: { dev: 11n, ino: 22n },
  });
  expect(lstat).toHaveBeenCalledExactlyOnceWith(nativeRoot, { bigint: true });
});

it.each(["replacement", "unknown", "symlink", "missing"] as const)(
  "rejects a canonical Windows root with %s identity evidence",
  scenario => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.spyOn(realpathSync, "native").mockReturnValue(nativeRoot);
    const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation(((candidate) => {
      if (String(candidate) === shortRoot) return directoryStat();
      if (scenario === "missing") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (scenario === "replacement") return directoryStat(11n, 23n);
      if (scenario === "unknown") return directoryStat(0n, 22n);
      return { ...directoryStat(), isSymbolicLink: () => true };
    }) as typeof fsSync.lstatSync);

    expect(observeCanonicalRoot(fsSync, shortRoot)).toMatchObject({
      ok: false, error: { code: "path-mismatch" },
    });
    expect(lstat).toHaveBeenCalledTimes(scenario === "unknown" ? 3 : 2);
  },
);

it("rejects an initial root symlink before canonicalization can erase it", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.spyOn(fsSync, "lstatSync").mockImplementation((() => ({
    ...directoryStat(), isSymbolicLink: () => true,
  })) as typeof fsSync.lstatSync);
  const resolve = vi.spyOn(realpathSync, "native");

  expect(observeCanonicalRoot(fsSync, shortRoot)).toMatchObject({
    ok: false, error: { code: "path-mismatch" },
  });
  expect(resolve).not.toHaveBeenCalled();
});

it("preserves custom-adapter observation and resolver ownership", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const native = vi.spyOn(realpathSync, "native");
  const resolve = vi.fn();
  const inspect = vi.fn(() => directoryStat());

  expect(observeCanonicalRoot({
    lstatSync: inspect as unknown as typeof fsSync.lstatSync,
    realpathSync: resolve as unknown as typeof fsSync.realpathSync,
  }, shortRoot)).toEqual({
    ok: true, path: shortRoot, identity: { dev: 11n, ino: 22n },
  });
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(native).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

itWin32.each(
  (["async", "sync"] as const).flatMap(mode => [false, true].map(explicit => ({ mode, explicit }))),
)("opens raw Windows temp-root spelling ($mode, rootRealPath=$explicit)", async ({ mode, explicit }) => {
  const boundary = await tempRoot("fs-safe-raw-root-spelling-");
  const target = path.join(boundary, "value.txt");
  await fs.writeFile(target, "inside");
  const params = {
    rootPath: boundary,
    absolutePath: target,
    boundaryLabel: "raw temp root",
    ...(explicit ? { rootRealPath: fsSync.realpathSync(boundary) } : {}),
  };
  const opened = mode === "async" ? await openRootFile(params) : openRootFileSync(params);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  try {
    expect(opened.rootRealPath).toBe(fsSync.realpathSync.native(boundary));
    expect(opened.path).toBe(fsSync.realpathSync.native(target));
    expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("inside");
  } finally {
    fsSync.closeSync(opened.fd);
  }
});

it("rejects a namespace alias returned while normalizing the Windows root", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const inspect = vi.spyOn(fsSync, "lstatSync").mockImplementation((() =>
    directoryStat()) as typeof fsSync.lstatSync);
  vi.spyOn(realpathSync, "native").mockReturnValue(`${nativeRoot}::$INDEX_ALLOCATION`);

  expect(observeCanonicalRoot(fsSync, shortRoot)).toMatchObject({
    ok: false, error: { code: "invalid-path", details: { reason: "windows-path-alias" } },
  });
  expect(inspect).toHaveBeenCalledExactlyOnceWith(shortRoot, { bigint: true });
});

it.each(["\\\\?\\C:\\", "\\\\.\\C:\\"])("dispatches the admitted namespaced root %s", rootPath => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const inspect = vi.spyOn(fsSync, "lstatSync").mockImplementation((() =>
    directoryStat()) as typeof fsSync.lstatSync);
  const resolve = vi.spyOn(realpathSync, "native").mockReturnValue("C:\\");

  expect(observeCanonicalRoot(fsSync, rootPath)).toEqual({
    ok: true, path: "C:\\", identity: { dev: 11n, ino: 22n },
  });
  expect(resolve).toHaveBeenCalledExactlyOnceWith("C:\\");
  expect(inspect.mock.calls.map(([candidate]) => candidate)).toEqual(["C:\\", "C:\\"]);
});

it("rejects a final canonical stream alias before its identity lookup", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const inspect = vi.fn(() => directoryStat());
  const resolve = vi.fn(() => `${shortRoot}\\value:payload`);
  const admission = createRootFileFinalAdmission({
    lstatSync: inspect as unknown as typeof fsSync.lstatSync,
    realpathSync: resolve as unknown as typeof fsSync.realpathSync,
  }, { ok: true, path: shortRoot, identity: { dev: 11n, ino: 22n } }, "fixture root");

  expect(() => admission({
    path: `${shortRoot}\\value`,
    descriptorIdentity: directoryStat(),
  })).toThrow(expect.objectContaining({
    code: "invalid-path", details: { reason: "windows-path-alias" },
  }));
  expect(inspect).toHaveBeenCalledExactlyOnceWith(shortRoot, { bigint: true });
});
