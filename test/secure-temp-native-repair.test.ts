import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { directoryEntryPath } from "../src/directory-entry-path.js";
import { resolveSecureTempRoot } from "../src/secure-temp-dir.js";
import { itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";
import { secureTempAdapterFixture, tempError } from "./helpers/secure-temp-adapter.js";

const { tempRoot } = useRealTempDirs();
const exec = promisify(execFile);
afterEach(() => vi.restoreAllMocks());

itPosix("uses the host descriptor bundle with an inert deprecated chmod option", async () => {
  const base = await tempRoot("fs-safe-temp-native-repair-");
  const preferredDir = path.join(base, "preferred");
  fs.mkdirSync(preferredDir, { mode: 0o700 });
  fs.chmodSync(preferredDir, 0o777);
  const chmod = vi.spyOn(fs, "chmodSync");
  const fchmod = vi.spyOn(fs, "fchmodSync");
  const close = vi.spyOn(fs, "closeSync");
  const deprecated = vi.fn(() => { throw new Error("unused property read"); });
  const options = { preferredDir, fallbackPrefix: "fixture", warn: vi.fn() };
  Object.defineProperty(options, "chmodSync", { get: deprecated });
  expect(resolveSecureTempRoot(options)).toBe(preferredDir);
  expect(fs.lstatSync(preferredDir).mode & 0o7777).toBe(0o700);
  expect(fchmod).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(chmod).not.toHaveBeenCalled();
  expect(deprecated).not.toHaveBeenCalled();
});

itPosix("does not open or chmod an already secure host directory", async () => {
  const preferredDir = await tempRoot("fs-safe-temp-native-fast-");
  const lstat = vi.spyOn(fs, "lstatSync");
  const access = vi.spyOn(fs, "accessSync");
  const open = vi.spyOn(fs, "openSync");
  const chmod = vi.spyOn(fs, "chmodSync");
  const fchmod = vi.spyOn(fs, "fchmodSync");
  expect(resolveSecureTempRoot({ preferredDir, fallbackPrefix: "fixture" })).toBe(preferredDir);
  expect(lstat).toHaveBeenCalledExactlyOnceWith(preferredDir, { bigint: true });
  expect(access).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  expect(chmod).not.toHaveBeenCalled();
  expect(fchmod).not.toHaveBeenCalled();
});

itPosix.each(["open", "chmod"])("keeps a real replacement unchanged when swapped at %s", async (stage) => {
  const base = await tempRoot("fs-safe-temp-real-swap-");
  const preferredDir = path.join(base, "preferred");
  const original = path.join(base, "original");
  const fallback = path.join(base, `fixture-${process.getuid!()}`);
  fs.mkdirSync(preferredDir, { mode: 0o700 });
  fs.chmodSync(preferredDir, 0o777);
  fs.mkdirSync(fallback, { mode: 0o700 });
  const mkdir = fs.mkdirSync;
  const chmod = fs.chmodSync;
  const swap = () => {
    fs.renameSync(preferredDir, original);
    mkdir(preferredDir, { mode: 0o700 });
    chmod(preferredDir, 0o777);
  };
  if (stage === "open") {
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((...args) => {
      const fd = open(...args);
      swap();
      return fd;
    });
  } else {
    const fchmod = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementationOnce((...args) => { swap(); fchmod(...args); });
  }
  const pathnameChmod = vi.spyOn(fs, "chmodSync");
  const close = vi.spyOn(fs, "closeSync");
  expect(resolveSecureTempRoot({ preferredDir, fallbackPrefix: "fixture", tmpdir: () => base, warn: vi.fn() }))
    .toBe(fallback);
  expect(fs.lstatSync(preferredDir).mode & 0o777).toBe(0o777);
  expect(fs.lstatSync(original).mode & 0o777).toBe(stage === "open" ? 0o777 : 0o700);
  expect(pathnameChmod).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

itPosix("admits a secure recursive-mkdir winner without claiming it was created", async () => {
  const base = await tempRoot("fs-safe-temp-mkdir-winner-");
  const preferredDir = path.join(base, "preferred");
  const mkdir = fs.mkdirSync;
  vi.spyOn(fs, "mkdirSync").mockImplementationOnce((candidate, options) => {
    mkdir(candidate, { recursive: true, mode: 0o700 });
    return mkdir(candidate, options);
  });
  const open = vi.spyOn(fs, "openSync");
  const fchmod = vi.spyOn(fs, "fchmodSync");
  expect(resolveSecureTempRoot({ preferredDir, fallbackPrefix: "fixture" })).toBe(preferredDir);
  expect(open).not.toHaveBeenCalled();
  expect(fchmod).not.toHaveBeenCalled();
});

itPosix("rejects a trailing-separator leaf symlink without chmodding its target", async () => {
  const base = await tempRoot("fs-safe-temp-leaf-link-");
  const target = path.join(base, "target");
  const alias = path.join(base, "alias");
  const fallback = path.join(base, `fixture-${process.getuid!()}`);
  fs.mkdirSync(target);
  fs.chmodSync(target, 0o777);
  fs.mkdirSync(fallback, { mode: 0o700 });
  fs.symlinkSync(target, alias, "dir");
  const chmod = vi.spyOn(fs, "chmodSync");
  const fchmod = vi.spyOn(fs, "fchmodSync");
  expect(resolveSecureTempRoot({
    preferredDir: `${alias}///`, fallbackPrefix: "fixture", tmpdir: () => base, warn: vi.fn(),
  })).toBe(fallback);
  expect(fs.statSync(target).mode & 0o777).toBe(0o777);
  expect(chmod).not.toHaveBeenCalled();
  expect(fchmod).not.toHaveBeenCalled();
});

itPosix("preserves symlink-sensitive parent components while removing trailing separators", async () => {
  const base = await tempRoot("fs-safe-temp-raw-parent-");
  const physical = path.join(base, "physical");
  fs.mkdirSync(path.join(physical, "child"), { recursive: true });
  const actual = path.join(physical, "secret");
  const lexical = path.join(base, "secret");
  for (const directory of [actual, lexical]) {
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o777);
  }
  const link = path.join(base, "link");
  fs.symlinkSync(path.join(physical, "child"), link, "dir");
  const preferredDir = `${link}/../secret///`;
  expect(resolveSecureTempRoot({ preferredDir, fallbackPrefix: "fixture", warn: vi.fn() })).toBe(preferredDir);
  expect(fs.statSync(actual).mode & 0o777).toBe(0o700);
  expect(fs.statSync(lexical).mode & 0o777).toBe(0o777);
});

it.each([
  { input: "/", expected: "/", platform: "linux" as const },
  { input: "///", expected: "///", platform: "linux" as const },
  { input: "/a/link/../root///", expected: "/a/link/../root", platform: "linux" as const },
  { input: "C:\\", expected: "C:\\", platform: "win32" as const },
  { input: "\\\\server\\share\\", expected: "\\\\server\\share\\", platform: "win32" as const },
  { input: "\\\\?\\UNC\\server\\share\\", expected: "\\\\?\\UNC\\server\\share\\", platform: "win32" as const },
])("preserves root spelling for $input", ({ input, expected, platform }) => {
  expect(directoryEntryPath(input, platform)).toBe(expected);
});

it.each(["lstatSync", "accessSync"] as const)("does not let an injected %s authorize default host mkdir", async (hook) => {
  const base = await tempRoot("fs-safe-temp-no-mixed-mkdir-");
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const options = {
    fallbackPrefix: "fixture", tmpdir: () => base,
    [hook]: hook === "lstatSync" ? () => { throw tempError("ENOENT"); } : () => undefined,
  };
  expect(() => resolveSecureTempRoot(options)).toThrow("Unable to create fallback");
  expect(mkdir).not.toHaveBeenCalled();
});

itPosix("does not mix a custom mkdir with default host chmod or descriptor repair", async () => {
  const base = await tempRoot("fs-safe-temp-no-mixed-repair-");
  const candidate = path.join(base, `fixture-${process.getuid!()}`);
  const mkdirSync = vi.fn(() => {
    fs.mkdirSync(candidate, { mode: 0o700 });
    fs.chmodSync(candidate, 0o777);
  });
  const open = vi.spyOn(fs, "openSync");
  const fchmod = vi.spyOn(fs, "fchmodSync");
  expect(() => resolveSecureTempRoot({ fallbackPrefix: "fixture", tmpdir: () => base, mkdirSync }))
    .toThrow("Unsafe fallback");
  expect(mkdirSync).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  expect(fchmod).not.toHaveBeenCalled();
  expect(fs.statSync(candidate).mode & 0o777).toBe(0o777);
});

it("retains Windows type/access admission without POSIX chmod", () => {
  const f = secureTempAdapterFixture();
  f.options.platform = "win32";
  expect(f.resolve()).toBe(path.win32.join(f.base, "fixture-501"));
  expect(f.legacyLstat).toHaveBeenCalledTimes(1);
  expect(f.accessSync).toHaveBeenCalledTimes(1);
  expect(f.fchmodSync).not.toHaveBeenCalled();
  expect(f.chmodSync).not.toHaveBeenCalled();
  expect(f.openSync).not.toHaveBeenCalled();
});

itWin32("does not enable POSIX chmod on Windows through a simulated platform", () => {
  const f = secureTempAdapterFixture();
  f.options.platform = "linux";
  expect(f.resolve()).toBe(f.candidate);
  expect(f.fchmodSync).not.toHaveBeenCalled();
  expect(f.chmodSync).not.toHaveBeenCalled();
  expect(f.openSync).not.toHaveBeenCalled();
});

itPosix.each([0o200, 0o777])("exercises creation under restrictive umask %s in a child", async (umask) => {
  const directory = await tempRoot("fs-safe-temp-restrictive-umask-");
  const child = fileURLToPath(new URL("./fixtures/secure-temp-umask-child.mjs", import.meta.url));
  const { stdout, stderr } = await exec(process.execPath, [child, directory, String(umask)], {
    cwd: new URL("..", import.meta.url), timeout: 5_000, killSignal: "SIGKILL",
  });
  expect(stderr).toBe("");
  const proof = JSON.parse(stdout);
  expect(proof.pathnameChmods).toBe(0);
  expect(proof.returnedSafe).toBe(true);
  if (proof.usedFallback) {
    expect(umask).toBe(0o777);
    expect(proof.preferredMode).toBe(0);
  } else {
    expect(proof.preferredMode).toBe(0o700);
  }
});
