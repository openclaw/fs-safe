import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeBinding } from "../src/native-binding.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { mutationObservationsCurrent } from "../src/pinned-mutation-observation.js";
import { realpathSync } from "../src/realpath.js";
import {
  assertPolicyStagedDirectoryCurrent,
  describePolicyStagedDirectory,
  refreshPolicyStagedDirectoryObservation,
} from "../src/staged-directory.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let binding: NativeBinding | undefined;
if (process.platform !== "win32" && !process.versions.bun) {
  try { binding = __loadBundledNativeForTest(); }
  catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
}
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function openDirectory(pathname: string): number {
  return fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
}

describe.runIf(process.platform !== "win32" && !process.versions.bun)("optional pinned directory observation", () => {
  it.each(["absent", "malformed", "unavailable"] as const)(
    "retains full pathname observation when the helper is %s",
    async (kind) => {
      const directory = await tempRoot("fs-safe-native-observation-fallback-");
      const fd = openDirectory(directory);
      const candidate = {
        observeDirectoryFd: kind === "absent" ? undefined : () => {
          if (kind === "unavailable") throw Object.assign(new Error("unavailable"), { code: "OBSERVATION_UNAVAILABLE" });
          return { dev: 1, ino: 2, realPath: directory };
        },
      } as unknown as NativeBinding;
      try {
        const canonical = vi.spyOn(realpathSync, "native");
        const captured = describePolicyStagedDirectory(fd, directory, candidate);
        expect(canonical).toHaveBeenCalledTimes(2);
        expect(captured.observeCurrent).toBeUndefined();
        expect(assertPolicyStagedDirectoryCurrent(captured).ino).toBe(fs.fstatSync(fd, { bigint: true }).ino);
      } finally { fs.closeSync(fd); }
    },
  );

  it.each([
    ["dev", 64n], ["ino", 64n], ["mode", 32n], ["nlink", 64n],
  ] as const)("retains pathname observation for an out-of-range native %s", async (field, bits) => {
    const directory = await tempRoot("fs-safe-native-observation-range-");
    const fd = openDirectory(directory);
    const exact = fs.fstatSync(fd, { bigint: true });
    const candidate = {
      observeDirectoryFd: () => ({
        dev: exact.dev, ino: exact.ino, mode: exact.mode, nlink: exact.nlink,
        realPath: directory, [field]: 1n << bits,
      }),
    } as unknown as NativeBinding;
    try {
      const canonical = vi.spyOn(realpathSync, "native");
      const captured = describePolicyStagedDirectory(fd, directory, candidate);
      expect(canonical).toHaveBeenCalledTimes(2);
      expect(captured.observeCurrent).toBeUndefined();
      expect(assertPolicyStagedDirectoryCurrent(captured).ino).toBe(exact.ino);
    } finally { fs.closeSync(fd); }
  });

  it("does not fall back after a concrete native identity mismatch", async () => {
    const directory = await tempRoot("fs-safe-native-observation-mismatch-");
    const fd = openDirectory(directory);
    const candidate = {
      observeDirectoryFd() { throw Object.assign(new Error("changed"), { code: "path-mismatch" }); },
    } as unknown as NativeBinding;
    try {
      const lstat = vi.spyOn(fs, "lstatSync");
      const canonical = vi.spyOn(realpathSync, "native");
      expect(() => describePolicyStagedDirectory(fd, directory, candidate)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(lstat).not.toHaveBeenCalled();
      expect(canonical).not.toHaveBeenCalled();
    } finally { fs.closeSync(fd); }
  });
});

describe.runIf(typeof binding?.observeDirectoryFd === "function")("retained POSIX directory observation", () => {
  it("keeps fresh exact checks while avoiding JavaScript pathname canonicalization", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-observation-current-");
    const fd = openDirectory(directory);
    try {
      const lstat = vi.spyOn(fs, "lstatSync");
      const canonical = vi.spyOn(realpathSync, "native");
      const captured = describePolicyStagedDirectory(fd, directory, binding);
      expect(captured.observeCurrent).toBeTypeOf("function");
      expect(mutationObservationsCurrent([], [captured.observation])).toBe(true);
      expect(assertPolicyStagedDirectoryCurrent(captured).ino).toBe(captured.stat.ino);
      const refreshed = refreshPolicyStagedDirectoryObservation(captured);
      expect(refreshed.identity).toEqual(captured.observation.identity);
      expect(lstat).not.toHaveBeenCalled();
      expect(canonical).not.toHaveBeenCalled();
      captured.disposeObservation?.();
    } finally { fs.closeSync(fd); }
  });

  it.each(["mode", "replacement", "link-count"] as const)(
    "rejects a fresh %s change instead of reusing the captured facts",
    async (change) => {
      const directory = await tempRoot("fs-safe-native-observation-change-");
      const parent = path.join(directory, "parent");
      fs.mkdirSync(parent, { mode: 0o700 });
      const fd = openDirectory(parent);
      try {
        const captured = describePolicyStagedDirectory(fd, parent, binding);
        if (change === "mode") fs.chmodSync(parent, 0o711);
        else if (change === "link-count") fs.mkdirSync(path.join(parent, "child"));
        else {
          fs.renameSync(parent, path.join(directory, "saved"));
          fs.mkdirSync(parent);
        }
        expect(mutationObservationsCurrent([], [captured.observation])).toBe(false);
        expect(() => assertPolicyStagedDirectoryCurrent(captured)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
        if (change === "link-count") {
          expect(refreshPolicyStagedDirectoryObservation(captured).identity.nlink)
            .toBe(fs.lstatSync(parent, { bigint: true }).nlink);
        }
        captured.disposeObservation?.();
      } finally { fs.closeSync(fd); }
    },
  );

  it("revokes observations before the caller releases descriptor ownership", async () => {
    const directory = await tempRoot("fs-safe-native-observation-dispose-");
    const fd = openDirectory(directory);
    try {
      const observe = vi.spyOn(binding!, "observeDirectoryFd");
      const captured = describePolicyStagedDirectory(fd, directory, binding);
      captured.disposeObservation?.();
      observe.mockClear();
      expect(mutationObservationsCurrent([], [captured.observation])).toBe(false);
      expect(() => assertPolicyStagedDirectoryCurrent(captured)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(observe).not.toHaveBeenCalled();
    } finally { fs.closeSync(fd); }
  });
});
