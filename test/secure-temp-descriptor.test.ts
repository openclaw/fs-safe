import fs from "node:fs";
import { afterEach, describe, expect, vi } from "vitest";
import { type SecureTempRootDescriptorAdapter } from "../src/secure-temp-dir.js";
import { itPosix } from "./helpers/vitest.js";
import { exactTempStat, secureTempAdapterFixture, tempError } from "./helpers/secure-temp-adapter.js";

afterEach(() => vi.restoreAllMocks());

describe("secure-temp descriptor authority", () => {
  itPosix("keeps the secure existing fast path to one lstat and access without opening", () => {
    const f = secureTempAdapterFixture();
    f.state.named.mode = 0o40750n;
    expect(f.resolve()).toBe(f.candidate);
    expect(f.lstatSync).toHaveBeenCalledExactlyOnceWith(f.candidate, { bigint: true });
    expect(f.accessSync).toHaveBeenCalledTimes(1);
    expect(f.openSync).not.toHaveBeenCalled();
    expect(f.fchmodSync).not.toHaveBeenCalled();
    expect(f.closeSync).not.toHaveBeenCalled();
    expect(f.legacyLstat).not.toHaveBeenCalled();
    expect(f.chmodSync).not.toHaveBeenCalled();
  });

  itPosix.each([0o40700n, 0o40500n])("admits or finalizes a newly created directory at %s", (createdMode) => {
    const f = secureTempAdapterFixture();
    f.state.exists = false;
    f.state.createdMode = createdMode;
    expect(f.resolve()).toBe(f.candidate);
    expect(f.mkdirSync).toHaveBeenCalledExactlyOnceWith(f.candidate, { recursive: true, mode: 0o700 });
    expect(f.fchmodSync).toHaveBeenCalledTimes(createdMode === 0o40700n ? 0 : 1);
    expect(f.openSync).toHaveBeenCalledTimes(1);
    expect(f.closeSync).toHaveBeenCalledTimes(1);
    expect(f.state.named.mode).toBe(0o40700n);
    expect(f.chmodSync).not.toHaveBeenCalled();
  });

  itPosix("repairs broad modes only through a pinned no-follow descriptor", () => {
    const f = secureTempAdapterFixture();
    expect(f.resolve()).toBe(f.candidate);
    expect(f.openSync).toHaveBeenCalledExactlyOnceWith(f.candidate, 0x30800);
    expect(f.fchmodSync).toHaveBeenCalledExactlyOnceWith(42, 0o700);
    expect(f.fstatSync.mock.calls.every((args) => args[0] === 42 && args[1]?.bigint === true)).toBe(true);
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
    expect(f.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("tightened permissions"));
    expect(f.chmodSync).not.toHaveBeenCalled();
  });

  const malformed = [
    { dev: 3 }, { dev: undefined }, { dev: -1n }, { ino: 0n }, { ino: -1n },
    { ino: 9007199254740992 }, { ino: undefined }, { uid: 501 }, { uid: undefined },
    { uid: -1n }, { uid: 502n }, { mode: 0o40777 }, { mode: undefined }, { mode: -1n },
    { mode: 0x1_0000_0000n }, { mode: 0o100777n },
    { isDirectory: () => false }, { isSymbolicLink: () => true },
  ];
  itPosix.each(malformed.map((patch, index) => ({ patch, index })))("rejects malformed admission facts $index before open", ({ patch }) => {
    const f = secureTempAdapterFixture();
    f.lstatSync.mockReturnValue({ ...exactTempStat(), ...patch } as never);
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.openSync).not.toHaveBeenCalled();
    expect(f.fchmodSync).not.toHaveBeenCalled();
    expect(f.closeSync).not.toHaveBeenCalled();
  });

  itPosix.each(malformed.map((patch, index) => ({ patch, index })))("rejects malformed descriptor facts $index and closes once", ({ patch }) => {
    const f = secureTempAdapterFixture();
    f.fstatSync.mockReturnValue({ ...exactTempStat(), ...patch } as never);
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.fchmodSync).not.toHaveBeenCalled();
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  itPosix.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid process UID %s", (uid) => {
    const f = secureTempAdapterFixture();
    f.options.getuid = () => uid;
    expect(f.resolve).toThrow("user identity is invalid");
    expect(f.lstatSync).not.toHaveBeenCalled();
    expect(f.fchmodSync).not.toHaveBeenCalled();
  });

  itPosix("cannot repair when the UID is unavailable and access fails", () => {
    const f = secureTempAdapterFixture();
    f.options.getuid = () => undefined;
    f.accessSync.mockImplementation(() => { throw tempError("EACCES"); });
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.openSync).not.toHaveBeenCalled();
    expect(f.fchmodSync).not.toHaveBeenCalled();
  });

  itPosix.each(["lstatSync", "fstatSync", "openSync", "fchmodSync", "closeSync", "constants"] as const)("makes repair unavailable with a partial descriptor bundle missing %s", (field) => {
    const f = secureTempAdapterFixture();
    delete (f.descriptor as Partial<SecureTempRootDescriptorAdapter>)[field];
    const hostOpen = vi.spyOn(fs, "openSync");
    const hostChmod = vi.spyOn(fs, "fchmodSync");
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(hostOpen).not.toHaveBeenCalled();
    expect(hostChmod).not.toHaveBeenCalled();
    expect(f.openSync).not.toHaveBeenCalled();
    expect(f.chmodSync).not.toHaveBeenCalled();
  });

  itPosix.each(["O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK"] as const)("rejects unavailable %s flags without opening", (flag) => {
    const f = secureTempAdapterFixture();
    f.descriptor.constants[flag] = undefined as never;
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.openSync).not.toHaveBeenCalled();
    expect(f.fchmodSync).not.toHaveBeenCalled();
  });

  itPosix.each([null, false, 7])("does not substitute host descriptor authority for an invalid bundle %s", (descriptor) => {
    const f = secureTempAdapterFixture();
    f.options.descriptor = descriptor as never;
    const hostOpen = vi.spyOn(fs, "openSync");
    const hostChmod = vi.spyOn(fs, "fchmodSync");
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(hostOpen).not.toHaveBeenCalled();
    expect(hostChmod).not.toHaveBeenCalled();
    expect(f.chmodSync).not.toHaveBeenCalled();
  });

  itPosix.each(["EACCES", "ELOOP", "ENOTDIR"])("does not reopen or chmod by path after open rejects with %s", (code) => {
    const f = secureTempAdapterFixture();
    f.openSync.mockImplementation(() => { throw tempError(code); });
    expect(f.resolve).toThrow("Unsafe fallback");
    expect(f.openSync).toHaveBeenCalledTimes(1);
    expect(f.fchmodSync).not.toHaveBeenCalled();
    expect(f.chmodSync).not.toHaveBeenCalled();
    expect(f.closeSync).not.toHaveBeenCalled();
  });

  itPosix("captures options, adapter functions and flags before any callback", () => {
    const f = secureTempAdapterFixture();
    const changed = vi.fn(() => { throw new Error("changed adapter used"); });
    f.options.getuid = () => {
      f.options.tmpdir = changed;
      f.options.accessSync = changed;
      f.options.warn = changed;
      f.options.preferredDir = "changed-path";
      f.descriptor.openSync = changed;
      f.descriptor.fchmodSync = changed;
      f.descriptor.closeSync = changed;
      f.descriptor.constants.O_NOFOLLOW = 0;
      return 501;
    };
    expect(f.resolve()).toBe(f.candidate);
    expect(f.fchmodSync).toHaveBeenCalledExactlyOnceWith(42, 0o700);
    expect(f.closeSync).toHaveBeenCalledExactlyOnceWith(42);
    expect(changed).not.toHaveBeenCalled();
  });
});
