import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSecureTempRoot,
  type ResolveSecureTempRootOptions,
} from "../src/secure-temp-dir.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const aliasError = {
  code: "invalid-path",
  details: { reason: "windows-path-alias" },
};

function simulateHost(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
}

function secureDirStat() {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    mode: 0o40700,
    uid: 501,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("secure temp host pathname admission", () => {
  it.each(["linux", "darwin"] as const)(
    "keeps Windows admission with a %s platform adapter before default or injected I/O",
    (platform) => {
      simulateHost("win32");
      const access = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
      const chmod = vi.spyOn(fs, "chmodSync").mockImplementation(() => undefined);
      const lstat = vi.spyOn(fs, "lstatSync").mockReturnValue(secureDirStat() as fs.Stats);
      const mkdir = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);

      for (const adapters of ["default", "injected"] as const) {
        for (const source of ["preferred", "fallback"] as const) {
          const options: ResolveSecureTempRootOptions = {
            fallbackPrefix: "fixture",
            getuid: () => 501,
            platform,
            preferredDir: source === "preferred" ? "C:\\Temp\\scope:alias" : undefined,
            tmpdir: () => source === "fallback" ? "C:\\Temp\\scope:alias" : "C:\\Temp",
            ...(adapters === "injected" ? {
              accessSync: (candidate: string, mode?: number) => fs.accessSync(candidate, mode),
              chmodSync: (candidate: string, mode: number) => fs.chmodSync(candidate, mode),
              lstatSync: (candidate: string) => fs.lstatSync(candidate),
              mkdirSync: (candidate: string, mkdirOptions: { recursive: boolean; mode?: number }) => {
                fs.mkdirSync(candidate, mkdirOptions);
              },
            } : {}),
          };

          expect(() => resolveSecureTempRoot(options), `${adapters} ${source}`)
            .toThrow(expect.objectContaining(aliasError));
          for (const operation of [access, chmod, lstat, mkdir]) {
            expect(operation).not.toHaveBeenCalled();
          }
        }
      }
    },
  );

  it("keeps platform selection separate from actual Windows admission", () => {
    simulateHost("win32");
    const preferredDir = "C:\\Temp\\preferred";
    const tmpdir = vi.fn(() => "C:\\Temp");
    const lstatSync = vi.fn(secureDirStat);
    const accessSync = vi.fn();
    const mkdirSync = vi.fn();
    const chmodSync = vi.fn();

    expect(resolveSecureTempRoot({
      fallbackPrefix: "fixture",
      getuid: () => 501,
      platform: "linux",
      skipPreferredOnWindows: true,
      preferredDir,
      tmpdir,
      lstatSync,
      accessSync,
      mkdirSync,
      chmodSync,
    })).toBe(preferredDir);
    expect(lstatSync).toHaveBeenCalledWith(preferredDir);
    expect(accessSync).toHaveBeenCalledWith(preferredDir, expect.any(Number));
    expect(tmpdir).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(chmodSync).not.toHaveBeenCalled();
  });

  it.each(["linux", "darwin"] as const)(
    "preserves colon-bearing preferred and fallback paths on a %s host",
    (platform) => {
      simulateHost(platform);
      const base = "/tmp/scope:stable";
      for (const source of ["preferred", "fallback"] as const) {
        const lstatSync = vi.fn(secureDirStat);
        const accessSync = vi.fn();
        const mkdirSync = vi.fn();
        const chmodSync = vi.fn();
        const expected = source === "preferred" ? base : path.join(base, "fixture-501");

        expect(resolveSecureTempRoot({
          fallbackPrefix: "fixture",
          getuid: () => 501,
          preferredDir: source === "preferred" ? base : undefined,
          tmpdir: () => base,
          lstatSync,
          accessSync,
          mkdirSync,
          chmodSync,
        })).toBe(expected);
        expect(lstatSync).toHaveBeenCalledWith(expected);
        expect(accessSync).toHaveBeenCalledWith(expected, expect.any(Number));
        expect(mkdirSync).not.toHaveBeenCalled();
        expect(chmodSync).not.toHaveBeenCalled();
      }
    },
  );
});
