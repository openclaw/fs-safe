import path from "node:path";
import { vi } from "vitest";
import { resolveSecureTempRoot, type ResolveSecureTempRootOptions, type SecureTempRootDescriptorAdapter } from "../../src/secure-temp-dir.js";

export function tempError(code: string) { return Object.assign(new Error(code), { code }); }

export function exactTempStat(ino = 17n, mode = 0o40777n) {
  return { dev: 3n, ino, uid: 501n, mode, isDirectory: () => true, isSymbolicLink: () => false };
}

export function secureTempAdapterFixture() {
  const base = path.resolve("synthetic-secure-temp");
  const candidate = path.join(base, "fixture-501");
  const state = { exists: true, named: exactTempStat(), pinned: exactTempStat(), createdMode: 0o40700n };
  const lstatSync = vi.fn((_path: string, _options: { bigint: true }) => {
    if (!state.exists) throw tempError("ENOENT");
    return { ...state.named };
  });
  const fstatSync = vi.fn((_fd: number, _options: { bigint: true }) => ({ ...state.pinned }));
  const openSync = vi.fn((_path: string, _flags: number) => { state.pinned = state.named; return 42; });
  const fchmodSync = vi.fn((_fd: number, mode: number) => { state.pinned.mode = 0o40000n | BigInt(mode); });
  const closeSync = vi.fn();
  const descriptor: SecureTempRootDescriptorAdapter = {
    lstatSync, fstatSync, openSync, fchmodSync, closeSync,
    constants: { O_RDONLY: 0, O_DIRECTORY: 0x10000, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 },
  };
  const accessSync = vi.fn((target: string) => {
    if (target === candidate && (state.named.mode & 0o300n) !== 0o300n) throw tempError("EACCES");
  });
  const legacyLstat = vi.fn(() => {
    if (!state.exists) throw tempError("ENOENT");
    return { ...state.named, uid: Number(state.named.uid), mode: Number(state.named.mode) };
  });
  const mkdirSync = vi.fn(() => { state.exists = true; state.named = exactTempStat(17n, state.createdMode); });
  const chmodSync = vi.fn(() => { throw new Error("deprecated pathname chmod invoked"); });
  const warn = vi.fn();
  const options: ResolveSecureTempRootOptions = {
    fallbackPrefix: "fixture", tmpdir: () => base, getuid: () => 501, platform: "linux",
    descriptor, accessSync, lstatSync: legacyLstat, mkdirSync, chmodSync, warn,
  };
  return {
    base, candidate, state, options, descriptor, lstatSync, fstatSync, openSync,
    fchmodSync, closeSync, accessSync, legacyLstat, mkdirSync, chmodSync, warn,
    resolve: () => resolveSecureTempRoot(options),
  };
}
