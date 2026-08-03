import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSecureTempRoot, type ResolveSecureTempRootOptions } from "../src/secure-temp-dir.js";

type TmpDirOptions = ResolveSecureTempRootOptions;

function nodeErrorWithCode(code: string) {
  const err = new Error(code) as Error & { code?: string };
  err.code = code;
  return err;
}

function secureDirStat(uid = 501) {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid,
    mode: 0o40700,
  };
}

function makeDirStat(params?: {
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
  uid?: number;
  mode?: number;
}) {
  return {
    isDirectory: () => params?.isDirectory ?? true,
    isSymbolicLink: () => params?.isSymbolicLink ?? false,
    uid: params?.uid ?? 501,
    mode: params?.mode ?? 0o40700,
  };
}

function resolveWithMocks(params: {
  preferredDir?: string;
  lstatSync: NonNullable<TmpDirOptions["lstatSync"]>;
  fallbackLstatSync?: NonNullable<TmpDirOptions["lstatSync"]>;
  accessSync?: NonNullable<TmpDirOptions["accessSync"]>;
  chmodSync?: NonNullable<TmpDirOptions["chmodSync"]>;
  warn?: NonNullable<TmpDirOptions["warn"]>;
  uid?: number;
  tmpdirPath?: string;
}) {
  const uid = params.uid ?? 501;
  const preferredDir = params.preferredDir ?? "/tmp/example";
  const fallbackPath = path.join("/var/fallback", `example-${uid}`);
  const accessSync = params.accessSync ?? vi.fn();
  const chmodSync = params.chmodSync ?? vi.fn();
  const warn = params.warn ?? vi.fn();
  const wrappedLstatSync = vi.fn((target: string) => {
    if (target === preferredDir) {
      return params.lstatSync(target);
    }
    if (target === fallbackPath) {
      return params.fallbackLstatSync ? params.fallbackLstatSync(target) : secureDirStat(uid);
    }
    return secureDirStat(uid);
  }) as NonNullable<TmpDirOptions["lstatSync"]>;
  const mkdirSync = vi.fn();
  const tmpdir = vi.fn(() => params.tmpdirPath ?? "/var/fallback");
  const resolved = resolveSecureTempRoot({
    accessSync,
    chmodSync,
    fallbackPrefix: "example",
    getuid: vi.fn(() => uid),
    lstatSync: wrappedLstatSync,
    mkdirSync,
    preferredDir,
    tmpdir,
    unsafeFallbackLabel: "Example temp dir",
    warn,
    warningPrefix: "[example]",
  });
  return { resolved, accessSync, chmodSync, lstatSync: wrappedLstatSync, mkdirSync, tmpdir };
}

describe("resolveSecureTempRoot", () => {
  it.each(["", ".", "..", "../escape", "nested/escape", "nested\\escape", "C:escape", "bad\0name"])(
    "rejects a fallback prefix that is not one safe path segment: %j",
    (fallbackPrefix) => {
      const mkdirSync = vi.fn();
      expect(() =>
        resolveSecureTempRoot({
          fallbackPrefix,
          getuid: vi.fn(() => 501),
          mkdirSync,
          tmpdir: vi.fn(() => "/var/fallback"),
        }),
      ).toThrow(/fallback temp prefix/u);
      expect(mkdirSync).not.toHaveBeenCalled();
    },
  );

  it("prefers an existing secure preferred directory", () => {
    const { resolved, tmpdir } = resolveWithMocks({
      lstatSync: vi.fn(() => secureDirStat()),
    });

    expect(resolved).toBe("/tmp/example");
    expect(tmpdir).not.toHaveBeenCalled();
  });

  it("creates the preferred directory when the parent is writable", () => {
    const lstatSync = vi
      .fn<NonNullable<TmpDirOptions["lstatSync"]>>()
      .mockImplementationOnce(() => {
        throw nodeErrorWithCode("ENOENT");
      })
      .mockImplementationOnce(() => secureDirStat());

    const { resolved, accessSync, mkdirSync } = resolveWithMocks({ lstatSync });

    expect(resolved).toBe("/tmp/example");
    expect(accessSync).toHaveBeenCalledWith("/tmp", expect.any(Number));
    expect(mkdirSync).toHaveBeenCalledWith("/tmp/example", { recursive: true, mode: 0o700 });
  });

  it("falls back to a uid-scoped secure temp directory", () => {
    const { resolved, tmpdir } = resolveWithMocks({
      accessSync: vi.fn((target: string) => {
        if (target === "/tmp") {
          throw new Error("read-only");
        }
      }),
      lstatSync: vi.fn(() => {
        throw nodeErrorWithCode("ENOENT");
      }),
    });

    expect(resolved).toBe(path.join("/var/fallback", "example-501"));
    expect(tmpdir).toHaveBeenCalled();
  });

  it("repairs broad permissions before accepting a directory", () => {
    let preferredMode = 0o40777;
    const chmodSync = vi.fn((target: string, mode: number) => {
      if (target === "/tmp/example" && mode === 0o700) {
        preferredMode = 0o40700;
      }
    });
    const warn = vi.fn();

    const { resolved } = resolveWithMocks({
      chmodSync,
      lstatSync: vi.fn(() => makeDirStat({ mode: preferredMode })),
      warn,
    });

    expect(resolved).toBe("/tmp/example");
    expect(chmodSync).toHaveBeenCalledWith("/tmp/example", 0o700);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[example] tightened permissions"));
  });

  it("skips the preferred POSIX path on Windows when requested", () => {
    const winFallback = path.win32.join("C:\\Temp", "example-501");
    const result = resolveSecureTempRoot({
      accessSync: vi.fn(),
      chmodSync: vi.fn(),
      fallbackPrefix: "example",
      getuid: vi.fn(() => 501),
      lstatSync: vi.fn((target: string) => {
        if (target === "/tmp/example" || target === winFallback) {
          return secureDirStat();
        }
        throw nodeErrorWithCode("ENOENT");
      }),
      mkdirSync: vi.fn(),
      platform: "win32",
      preferredDir: "/tmp/example",
      skipPreferredOnWindows: true,
      tmpdir: vi.fn(() => "C:\\Temp"),
      warn: vi.fn(),
    });

    expect(result).toBe(winFallback);
  });
});
