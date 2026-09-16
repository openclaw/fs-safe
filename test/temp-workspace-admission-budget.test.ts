import fsSync from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { realpathSync } from "../src/realpath.js";
import {
  inspectTempWorkspaceDescriptorIdentitySync,
  projectTempWorkspaceNumericIdentity,
  type TempWorkspaceIdentity,
} from "../src/temp-workspace-identity.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const supportsDirectRequestedMode = process.platform === "linux" || process.platform === "darwin";
const supportsNumericIdentityReplay =
  process.platform === "linux" || process.platform === "darwin";

function tempWorkspaceSyncWithUmask022(options: Parameters<typeof tempWorkspaceSync>[0]) {
  const previous = process.umask(0o022);
  try {
    return tempWorkspaceSync(options);
  } finally {
    process.umask(previous);
  }
}

function safeIdentityProjector() {
  const identities = new Map<string, Readonly<{ dev: number; ino: number }>>();
  let next = 1;
  return (stat: { dev: number | bigint; ino: number | bigint }): void => {
    const key = `${stat.dev}:${stat.ino}`;
    let identity = identities.get(key);
    if (!identity) {
      identity = { dev: 1000 + next, ino: 2000 + next };
      next += 1;
      identities.set(key, identity);
      if (typeof stat.dev === "bigint" && typeof stat.ino === "bigint") {
        identities.set(`${Number(stat.dev)}:${Number(stat.ino)}`, identity);
      }
    }
    stat.dev = typeof stat.dev === "bigint" ? BigInt(identity.dev) : identity.dev;
    stat.ino = typeof stat.ino === "bigint" ? BigInt(identity.ino) : identity.ino;
  };
}

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

for (const variant of ["async", "sync"] as const) {
  describe(`${variant} temp workspace observation budget`, () => {
    it.each([
      ["compatible default", false, 0o700, undefined],
      ["compatible requested 0750", false, 0o750, undefined],
      ["native capability probe", true,
        variant === "sync" && supportsDirectRequestedMode ? 0o750 : 0o700, undefined],
      ...(variant === "sync" && supportsDirectRequestedMode
        ? [["restrictive umask correction", false, 0o750, 0o077] as const]
        : []),
    ] as const)("holds %s to separate total and BigInt budgets", async (
      _label, nativeProbe, dirMode, creationUmask,
    ) => {
      const rootDir = await tempRoot("fs-safe-workspace-stat-budget-");
      let components = 1;
      for (let current = rootDir; path.dirname(current) !== current; current = path.dirname(current)) {
        components += 1;
      }
      const probe = vi.fn(() => false);
      if (nativeProbe) {
        configureFsSafeNative({ mode: "auto" });
        __setNativeLoaderForTest(() => ({
          closeOwnedFd: vi.fn(),
          renameNoReplace: vi.fn(),
          removeOwnedTree: vi.fn(),
          removeOwnedTreeSync: vi.fn(),
          ownedTreeRemovalAvailable: probe,
        }) as unknown as NativeBinding);
      }
      let observations = 0;
      let bigintObservations = 0;
      let modeChanges = 0;
      let measuring = true;
      const projectIdentity = safeIdentityProjector();
      const lstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        if (measuring) observations += 1;
        if (measuring && args[1]?.bigint === true) bigintObservations += 1;
        const stat = lstat(...args);
        if (supportsNumericIdentityReplay) projectIdentity(stat);
        return stat;
      });
      const fstat = fsSync.fstatSync.bind(fsSync);
      vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
        if (measuring) observations += 1;
        if (measuring && args[1]?.bigint === true) bigintObservations += 1;
        const stat = fstat(...args);
        if (supportsNumericIdentityReplay) projectIdentity(stat);
        return stat;
      });
      const canonicalize = vi.spyOn(realpathSync, "native");
      if (variant === "async") {
        const fchmod = fsSync.fchmod.bind(fsSync);
        vi.spyOn(fsSync, "fchmod").mockImplementation((fd, mode, callback) => {
          if (measuring) modeChanges += 1;
          return fchmod(fd, mode, callback);
        });
      } else {
        const fchmod = fsSync.fchmodSync.bind(fsSync);
        vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
          if (measuring) modeChanges += 1;
          return fchmod(fd, mode);
        });
      }
      const register = cleanup.registerTempPathForExit.bind(cleanup);
      vi.spyOn(cleanup, "registerTempPathForExit").mockImplementation((...args) => {
        measuring = false;
        return register(...args);
      });
      const options = { rootDir, prefix: "workspace-", dirMode };
      const directRequestedMode = variant === "sync" && supportsDirectRequestedMode &&
        dirMode === 0o750;
      let directInitialMode: number | undefined;
      if (directRequestedMode) {
        const mkdir = fsSync.mkdirSync.bind(fsSync);
        vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
          const result = mkdir(...args);
          if (typeof args[0] === "string" && path.dirname(args[0]) === rootDir &&
            path.basename(args[0]).startsWith("workspace-")) {
            directInitialMode = fsSync.statSync(args[0]).mode & 0o7777;
          }
          return result;
        });
      }
      let workspace;
      if (variant === "async") {
        workspace = await tempWorkspace(options);
      } else if (creationUmask !== undefined) {
        const previous = process.umask(creationUmask);
        try {
          workspace = tempWorkspaceSync(options);
        } finally {
          process.umask(previous);
        }
      } else if (directRequestedMode) {
        workspace = tempWorkspaceSyncWithUmask022(options);
      } else {
        workspace = tempWorkspaceSync(options);
      }
      if (directRequestedMode) expect(directInitialMode).toBeDefined();
      const modeCorrection = process.platform !== "win32" && dirMode !== 0o700 &&
        (!directRequestedMode || directInitialMode !== dirMode);
      const correctionObservations = !modeCorrection ? 0
        : variant === "async" ? 4
        : directRequestedMode ? 2 : 3;
      expect(observations).toBe(2 * components + 8 +
        (nativeProbe ? 1 : 0) + correctionObservations);
      if (supportsNumericIdentityReplay) {
        expect(bigintObservations).toBe(components + 1);
      }
      expect(canonicalize).toHaveBeenCalledTimes(4 +
        (nativeProbe ? 1 : 0) + (modeCorrection ? (variant === "sync" ? 1 : 2) : 0));
      expect(modeChanges).toBe(modeCorrection ? 1 : 0);
      expect(probe).toHaveBeenCalledTimes(nativeProbe ? 1 : 0);
      await workspace.cleanup();
    });
  });
}

describe.runIf(supportsNumericIdentityReplay)("temp workspace numeric identity replay", () => {
  it.each(["device", "inode", "unsafe"] as const)(
    "rejects a definite numeric %s mismatch without an exact retry",
    async (change) => {
      const dir = await tempRoot("fs-safe-workspace-numeric-identity-");
      const fd = fsSync.openSync(dir, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY);
      try {
        const expected = fsSync.fstatSync(fd, { bigint: true });
        expected.dev = 101n;
        expected.ino = 202n;
        const numeric = projectTempWorkspaceNumericIdentity(expected)!;
        const fstat = fsSync.fstatSync.bind(fsSync);
        let exactReplays = 0;
        vi.spyOn(fsSync, "fstatSync").mockImplementation((candidate, options) => {
          const current = fstat(candidate, options);
          if (candidate !== fd) return current;
          if (options?.bigint === true) exactReplays += 1;
          else {
            (current as { dev: number; ino: number }).dev = numeric.dev;
            (current as { dev: number; ino: number }).ino = numeric.ino;
            if (change === "device") (current as { dev: number }).dev += 1;
            else if (change === "inode") (current as { ino: number }).ino += 1;
            else (current as { ino: number }).ino = Number.MAX_SAFE_INTEGER + 1;
          }
          return current;
        });
        expect(() => inspectTempWorkspaceDescriptorIdentitySync(fd, expected, numeric))
          .toThrowError(expect.objectContaining({ code: "path-mismatch" }));
        expect(exactReplays).toBe(0);
      } finally {
        fsSync.closeSync(fd);
      }
    },
  );

  it("uses one exact replay directly when the retained identity is unsafe", async () => {
    const dir = await tempRoot("fs-safe-workspace-unsafe-identity-");
    const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const expected: TempWorkspaceIdentity = { dev: unsafe, ino: unsafe + 1n };
    const fd = fsSync.openSync(dir, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY);
    try {
      const fstat = fsSync.fstatSync.bind(fsSync);
      let numericReplays = 0;
      let exactReplays = 0;
      vi.spyOn(fsSync, "fstatSync").mockImplementation((candidate, options) => {
        const current = fstat(candidate, options);
        if (candidate !== fd) return current;
        if (options?.bigint === true && typeof current.dev === "bigint") {
          exactReplays += 1;
          current.dev = expected.dev;
          current.ino = expected.ino;
        } else {
          numericReplays += 1;
        }
        return current;
      });
      const current = inspectTempWorkspaceDescriptorIdentitySync(fd, expected, undefined);
      expect(current).toMatchObject(expected);
      expect(numericReplays).toBe(0);
      expect(exactReplays).toBe(1);
    } finally {
      fsSync.closeSync(fd);
    }
  });
});
