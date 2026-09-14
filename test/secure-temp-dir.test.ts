import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSecureTempRoot, type ResolveSecureTempRootOptions } from "../src/secure-temp-dir.js";
import { itPosix } from "./helpers/vitest.js";

type TmpDirOptions = ResolveSecureTempRootOptions;

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("uses the injected identity as the effective uid for naming and admission", () => {
    const realUid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const effectiveUid = realUid + 1;
    const fallbackPath = path.join("/var/fallback", `example-${effectiveUid}`);
    const lstatSync = vi.fn((target: string) => {
      expect(target).toBe(fallbackPath);
      return secureDirStat(effectiveUid);
    });

    expect(resolveSecureTempRoot({
      accessSync: vi.fn(),
      chmodSync: vi.fn(),
      fallbackPrefix: "example",
      getuid: () => effectiveUid,
      lstatSync,
      mkdirSync: vi.fn(),
      platform: "linux",
      tmpdir: () => "/var/fallback",
    })).toBe(fallbackPath);
    expect(lstatSync).toHaveBeenCalledTimes(1);
  });

  itPosix("uses the process effective uid instead of its real uid", () => {
    const actualUid = process.geteuid!();
    const effectiveUid = actualUid === 0 ? 1 : actualUid - 1;
    const fallbackPath = path.join("/var/fallback", `example-${effectiveUid}`);
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(actualUid);
    const geteuid = vi.spyOn(process, "geteuid").mockReturnValue(effectiveUid);

    expect(resolveSecureTempRoot({
      accessSync: vi.fn(),
      chmodSync: vi.fn(),
      fallbackPrefix: "example",
      lstatSync: vi.fn((target: string) => {
        expect(target).toBe(fallbackPath);
        return secureDirStat(effectiveUid);
      }),
      mkdirSync: vi.fn(),
      tmpdir: () => "/var/fallback",
    })).toBe(fallbackPath);
    expect(geteuid).toHaveBeenCalledTimes(1);
    expect(getuid).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", () => undefined],
    ["throwing", () => { throw new Error("identity unavailable"); }],
    ["negative", () => -1],
    ["fractional", () => 501.5],
    ["unsafe integer", () => Number.MAX_SAFE_INTEGER + 1],
  ] as const)("fails closed for a %s effective uid on POSIX", (_label, getuid) => {
    const lstatSync = vi.fn(() => secureDirStat());
    expect(() => resolveSecureTempRoot({
      fallbackPrefix: "example",
      getuid,
      lstatSync,
      platform: "linux",
    })).toThrow("Unable to determine effective user identity");
    expect(lstatSync).not.toHaveBeenCalled();
  });

  it.each([
    ["different", secureDirStat(502)],
    ["missing", { ...makeDirStat(), uid: undefined }],
  ])("rejects a preferred directory with %s owner identity", (_label, preferredStat) => {
    const { resolved } = resolveWithMocks({
      fallbackLstatSync: vi.fn(() => secureDirStat(501)),
      lstatSync: vi.fn(() => preferredStat),
      uid: 501,
    });

    expect(resolved).toBe(path.join("/var/fallback", "example-501"));
  });

  it("preserves the uid-less Windows fallback without an adapter", () => {
    const fallbackPath = path.win32.join("C:\\Temp", "example");
    const chmodSync = vi.fn();
    expect(resolveSecureTempRoot({
      accessSync: vi.fn(),
      chmodSync,
      fallbackPrefix: "example",
      lstatSync: vi.fn(() => ({ ...makeDirStat({ mode: 0o40777 }), uid: undefined })),
      mkdirSync: vi.fn(),
      platform: "win32",
      tmpdir: () => "C:\\Temp",
    })).toBe(fallbackPath);
    expect(chmodSync).not.toHaveBeenCalled();
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
