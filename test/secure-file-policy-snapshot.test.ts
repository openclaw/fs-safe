import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import { readSecureFile, type SecureFileReadOptions } from "../src/secure-file.js";
import * as timing from "../src/timing.js";
import { itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

function onNextOpen(callback: (handle: fs.FileHandle) => void | Promise<void>) {
  const realOpen = fs.open.bind(fs);
  return vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args);
    await callback(handle);
    return handle;
  });
}

async function cwdFixture() {
  const base = await tempRoot("fs-safe-secure-cwd-policy-");
  const before = path.join(base, "before");
  const after = path.join(base, "after");
  for (const directory of [before, after]) {
    await fs.mkdir(path.join(directory, "trusted"), { recursive: true });
    await fs.writeFile(path.join(directory, "trusted", "secret"), "secret", { mode: 0o600 });
  }
  return { before, after };
}

describe("secure-read policy snapshots", () => {
  itWin32.each([
    "\\\\?\\C:", "\\\\.\\C:", "\\\\?\\C:\\child:stream\\..", "C:child:stream\\..",
  ])("rejects the raw trusted-directory namespace before normalization (%s)", async (trustedDir) => {
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const open = vi.spyOn(fs, "open");
    const options = { filePath: path.resolve("unused-secret"), trust: { trustedDirs: [trustedDir] } };
    await expect(readSecureFile({ ...options, io: { maxBytes: -1 } })).rejects.toBeInstanceOf(RangeError);
    await expect(readSecureFile(options)).rejects.toMatchObject({
      code: "invalid-path", details: { reason: "windows-path-alias" },
    });
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  itWin32("retains an extended-length drive root in the trusted-directory snapshot", async () => {
    const directory = await tempRoot("fs-safe-secure-namespace-root-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const driveRoot = path.parse(directory).root;
    await expect(readSecureFile({
      filePath, trust: { trustedDirs: [`\\\\?\\${driveRoot}`] }, permissions: { allowInsecure: true },
    })).resolves.toMatchObject({ buffer: Buffer.from("secret") });
  });

  it.each(["before", "after"] as const)("binds relative roots before opening a file in the %s cwd", async (location) => {
    const directories = await cwdFixture();
    const previousCwd = process.cwd();
    let read: ReturnType<typeof vi.spyOn>;
    let close: ReturnType<typeof vi.spyOn>;
    onNextOpen((handle) => {
      read = vi.spyOn(handle, "read");
      close = vi.spyOn(handle, "close");
      process.chdir(directories.after);
    });
    try {
      process.chdir(directories.before);
      const result = readSecureFile({
        filePath: path.join(directories[location], "trusted", "secret"),
        trust: { trustedDirs: ["trusted"] },
        permissions: { allowInsecure: true },
      });
      if (location === "before") {
        await expect(result).resolves.toMatchObject({ buffer: Buffer.from("secret") });
        expect(read!).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).rejects.toMatchObject({ code: "outside-workspace" });
        expect(read!).not.toHaveBeenCalled();
      }
      expect(close!).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(previousCwd);
    }
  });

  itWin32.each(["before", "after"] as const)("retains Windows drive-relative roots for a file in the %s cwd", async (location) => {
    const directories = await cwdFixture();
    const previousCwd = process.cwd();
    const drive = path.parse(directories.before).root.slice(0, 2);
    onNextOpen(() => { process.chdir(directories.after); });
    try {
      process.chdir(directories.before);
      const result = readSecureFile({
        filePath: path.join(directories[location], "trusted", "secret"),
        trust: { trustedDirs: [`${drive}trusted`] },
        permissions: { allowInsecure: true },
      });
      if (location === "before") {
        await expect(result).resolves.toMatchObject({ buffer: Buffer.from("secret") });
      } else {
        await expect(result).rejects.toMatchObject({ code: "outside-workspace" });
      }
    } finally {
      process.chdir(previousCwd);
    }
  });

  it.each(["entry", "array", "trust"] as const)("ignores a trusted-directory %s replacement after open", async (mutation) => {
    const base = await tempRoot("fs-safe-secure-trust-policy-");
    const trusted = path.join(base, "trusted");
    const filePath = path.join(base, "secret");
    await fs.mkdir(trusted);
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const dirs = [trusted];
    const trust = { trustedDirs: dirs };
    const options = { filePath, trust, permissions: { allowInsecure: true } };
    let read: ReturnType<typeof vi.spyOn>;
    let close: ReturnType<typeof vi.spyOn>;
    onNextOpen((handle) => {
      read = vi.spyOn(handle, "read");
      close = vi.spyOn(handle, "close");
      if (mutation === "entry") dirs[0] = base;
      else if (mutation === "array") trust.trustedDirs = [];
      else options.trust = { trustedDirs: [] };
    });
    await expect(readSecureFile(options)).rejects.toMatchObject({ code: "outside-workspace" });
    expect(read!).not.toHaveBeenCalled();
    expect(close!).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, "trusted", {}, [null], [undefined], [123], ["bad\0path"], Array(1),
  ].map((trustedDirs) => ({ trustedDirs })))("rejects malformed trustedDirs before filesystem admission ($trustedDirs)", async ({ trustedDirs }) => {
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const open = vi.spyOn(fs, "open");
    await expect(readSecureFile({
      filePath: path.resolve("unused-secret"),
      trust: { trustedDirs: trustedDirs as string[] },
    })).rejects.toMatchObject({ code: "invalid-path" });
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, NaN, Infinity, -Infinity, -1, 0.5, 0x1_0000_0000,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "0", false, 0n,
  ].map((length) => ({ length })))("rejects an invalid proxy array length before admission ($length)", async ({ length }) => {
    const readLength = vi.fn().mockReturnValueOnce(length).mockReturnValue(0);
    const trustedDirs = new Proxy([path.resolve("trusted")], {
      get(target, key, receiver) {
        return key === "length" ? readLength() : Reflect.get(target, key, receiver);
      },
    });
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const open = vi.spyOn(fs, "open");
    await expect(readSecureFile({
      filePath: path.resolve("unused-secret"), trust: { trustedDirs },
    })).rejects.toMatchObject({ code: "invalid-path" });
    expect(readLength).toHaveBeenCalledTimes(1);
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects an inherited index without reading it or admitting the file", async () => {
    const inheritedEntry = vi.fn(() => path.resolve("trusted"));
    const trustedDirs = Array<string>(1);
    Object.setPrototypeOf(trustedDirs, Object.create(Array.prototype, {
      0: { get: inheritedEntry },
    }));
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const open = vi.spyOn(fs, "open");
    await expect(readSecureFile({
      filePath: path.resolve("unused-secret"), trust: { trustedDirs },
    })).rejects.toMatchObject({ code: "invalid-path" });
    expect(inheritedEntry).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([undefined, [], [""]].map((trustedDirs) => ({ trustedDirs })))("preserves omitted, empty, and cwd trusted-directory lists ($trustedDirs)", async ({ trustedDirs }) => {
    const directory = await tempRoot("fs-safe-secure-empty-trust-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const previousCwd = process.cwd();
    try {
      process.chdir(directory);
      await expect(readSecureFile({
        filePath, trust: { trustedDirs }, permissions: { allowInsecure: true },
      })).resolves.toMatchObject({ buffer: Buffer.from("secret") });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("retains canonical trusted-directory aliases and lexical lookup fallback", async () => {
    const base = await tempRoot("fs-safe-secure-trust-alias-");
    const directory = path.join(base, "trusted");
    const alias = path.join(base, "alias");
    const filePath = path.join(directory, "secret");
    await fs.mkdir(directory);
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    await fs.symlink(directory, alias, "junction");
    await expect(readSecureFile({
      filePath, trust: { trustedDirs: [alias] }, permissions: { allowInsecure: true },
    })).resolves.toMatchObject({ buffer: Buffer.from("secret") });

    const realpath = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
      if (args[0] === directory) throw Object.assign(new Error("lookup denied"), { code: "EACCES" });
      return realpath(...args);
    });
    await expect(readSecureFile({
      filePath, trust: { trustedDirs: [directory] }, permissions: { allowInsecure: true },
    })).resolves.toMatchObject({ buffer: Buffer.from("secret") });
  });

  itPosix.each(["allowInsecure", "allowReadableByOthers"] as const)("ignores in-flight %s permission changes", async (field) => {
    const directory = await tempRoot("fs-safe-secure-permission-policy-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o644 });
    await fs.chmod(filePath, 0o644);
    const permissions = { allowInsecure: false, allowReadableByOthers: false };
    let read: ReturnType<typeof vi.spyOn>;
    let close: ReturnType<typeof vi.spyOn>;
    onNextOpen((handle) => {
      permissions[field] = true;
      read = vi.spyOn(handle, "read");
      close = vi.spyOn(handle, "close");
    });
    await expect(readSecureFile({ filePath, permissions }))
      .rejects.toMatchObject({ code: "insecure-permissions" });
    expect(read!).not.toHaveBeenCalled();
    expect(close!).toHaveBeenCalledTimes(1);
  });

  itPosix("retains no-follow policy after the caller allows symlinks in flight", async () => {
    const directory = await tempRoot("fs-safe-secure-symlink-policy-");
    const filePath = path.join(directory, "secret");
    const original = path.join(directory, "original");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const trust = { allowSymlink: false };
    let read: ReturnType<typeof vi.spyOn>;
    onNextOpen(async (handle) => {
      trust.allowSymlink = true;
      read = vi.spyOn(handle, "read");
      await fs.rename(filePath, original);
      await fs.symlink(original, filePath);
    });
    await expect(readSecureFile({ filePath, trust, permissions: { allowInsecure: true } }))
      .rejects.toMatchObject({ code: "symlink" });
    expect(read!).not.toHaveBeenCalled();
  });

  it("keeps the call-time timeout when the I/O object is changed after open", async () => {
    const directory = await tempRoot("fs-safe-secure-timeout-policy-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const io = { timeoutMs: 5_000 };
    const schedule = vi.spyOn(timing, "scheduleTimeout");
    onNextOpen(() => { io.timeoutMs = 0; });
    await expect(readSecureFile({ filePath, io, permissions: { allowInsecure: true } }))
      .resolves.toMatchObject({ buffer: Buffer.from("secret") });
    expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 5_000);
  });

  itPosix.each(["platform", "exec", "env"] as const)("retains the supplied injection %s after open", async (field) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-secure-injection-policy-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const exec = vi.fn(async () => { throw new Error("call-time inspector denied"); });
    const replacement = vi.fn(async () => { throw new Error("replacement inspector denied"); });
    const env = { SystemRoot: "C:\\CallTimeWindows" };
    const inject = { platform: "win32" as NodeJS.Platform, exec, env };
    onNextOpen(() => {
      if (field === "platform") inject.platform = process.platform;
      else if (field === "exec") inject.exec = replacement;
      else env.SystemRoot = "D:\\LaterWindows";
    });
    await expect(readSecureFile({ filePath, inject })).rejects.toMatchObject({
      code: "permission-unverified",
      message: expect.stringContaining("call-time inspector denied"),
    });
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("windows-security-helper.exe"), ["owner", filePath],
    );
    expect(replacement).not.toHaveBeenCalled();
  });

  itPosix.each(["SystemRoot", "WINDIR"].flatMap((name) =>
    ["enumerable", "non-enumerable", "inherited"].map((storage) => ({ name, storage })),
  ))("snapshots the exact $storage environment name $name once", async ({ name, storage }) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-secure-env-exact-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    let opened = false;
    const get = vi.fn(() => {
      if (opened) throw new Error("environment getter read after open");
      return "C:\\CapturedWindows";
    });
    const env: NodeJS.ProcessEnv = {
      systemroot: "D:\\CaseVariantWindows", windir: "D:\\CaseVariantWindows",
    };
    // An invalid exact SystemRoot suppresses its case variant and tries WINDIR.
    if (name === "WINDIR") env.SystemRoot = "relative-root";
    const target = storage === "inherited" ? {} : env;
    Object.defineProperty(target, name, { get, enumerable: storage === "enumerable" });
    if (storage === "inherited") Object.setPrototypeOf(env, target);
    const exec = vi.fn(async () => { throw new Error("captured inspector denied"); });
    onNextOpen(() => { opened = true; });
    await expect(readSecureFile({ filePath, inject: { platform: "win32", env, exec } }))
      .rejects.toMatchObject({ code: "permission-unverified", message: expect.stringContaining("captured inspector denied") });
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("windows-security-helper.exe"), ["owner", filePath],
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  itPosix.each(["systemroot", "windir"].flatMap((name) =>
    ["non-enumerable", "inherited"].map((storage) => ({ name, storage })),
  ))("continues to ignore a $storage case variant $name", async ({ name, storage }) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-secure-env-ignored-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const get = vi.fn(() => { throw new Error("unsupported case variant read"); });
    const env: NodeJS.ProcessEnv = {};
    const target = storage === "inherited" ? {} : env;
    Object.defineProperty(target, name, { get });
    if (storage === "inherited") Object.setPrototypeOf(env, target);
    const exec = vi.fn(async () => { throw new Error("default inspector denied"); });
    await expect(readSecureFile({ filePath, inject: { platform: "win32", env, exec } }))
      .rejects.toMatchObject({ code: "permission-unverified", message: expect.stringContaining("default inspector denied") });
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("windows-security-helper.exe"), ["owner", filePath],
    );
    expect(get).not.toHaveBeenCalled();
  });

  itPosix.each(["systemroot", "windir"])("retains an enumerable own environment case variant %s", async (name) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-secure-env-case-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const get = vi.fn(() => "C:\\CaseVariantWindows");
    const env: NodeJS.ProcessEnv = {};
    Object.defineProperty(env, name, { get, enumerable: true });
    const exec = vi.fn(async () => { throw new Error("case-variant inspector denied"); });
    await expect(readSecureFile({ filePath, inject: { platform: "win32", env, exec } }))
      .rejects.toMatchObject({ code: "permission-unverified", message: expect.stringContaining("case-variant inspector denied") });
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("windows-security-helper.exe"), ["owner", filePath],
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reads each supplied field once before open, including array entries and env values", async () => {
    const directory = await tempRoot("fs-safe-secure-policy-getters-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    let opened = false;
    const getters: ReturnType<typeof vi.fn>[] = [];
    function readOnce<T extends object>(values: T): T {
      const snapshot = {} as T;
      for (const key of Object.keys(values) as (keyof T)[]) {
        const value = values[key];
        const get = vi.fn(() => {
          if (opened) throw new Error("caller getter read after open");
          return value;
        });
        getters.push(get);
        Object.defineProperty(snapshot, key, { get, enumerable: true });
      }
      return snapshot;
    }
    const dirs = [directory];
    const dir = vi.fn(() => {
      if (opened) throw new Error("caller entry read after open");
      return directory;
    });
    Object.defineProperty(dirs, 0, { get: dir });
    // Array methods/iterators are caller-owned too; snapshot by index.
    dirs.map = () => { throw new Error("caller map used"); };
    dirs[Symbol.iterator] = () => { throw new Error("caller iterator used"); };
    const options: SecureFileReadOptions = readOnce({
      filePath,
      label: "call-time secret",
      trust: readOnce({ trustedDirs: dirs, allowSymlink: false, allowNetworkPath: false }),
      permissions: readOnce({ allowInsecure: true, allowReadableByOthers: false }),
      inject: readOnce({
        platform: process.platform,
        env: readOnce({ SystemRoot: "C:\\Windows" }),
        exec: vi.fn(async () => ({ stdout: "", stderr: "" })),
      }),
      io: readOnce({ maxBytes: 100, timeoutMs: 5_000 }),
    });
    onNextOpen(() => { opened = true; });
    await expect(readSecureFile(options)).resolves.toMatchObject({ buffer: Buffer.from("secret") });
    for (const get of [...getters, dir]) expect(get).toHaveBeenCalledTimes(1);
  });
});
