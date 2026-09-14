import type { Stats } from "node:fs";
import fsSync from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDirectoryIdentitySync,
  assertAsyncDirectoryGuard,
  assertSyncDirectoryGuard,
  type AnyAsyncDirectoryGuard,
  createAsyncDirectoryGuard,
  createNearestExistingDirectoryGuard,
  createNearestExistingSyncDirectoryGuard,
  createSyncDirectoryGuard,
  inspectDirectoryIdentity,
  readDirectoryIdentity,
} from "../src/directory-guard.js";
import * as realpath from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const aliasError = {
  code: "invalid-path",
  details: { reason: "windows-path-alias" },
};

function simulateWindows(): void {
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
}

function withSingleReadFields(guard: AnyAsyncDirectoryGuard): {
  guard: AnyAsyncDirectoryGuard;
  reads: () => [number, number, number];
} {
  let dirReads = 0;
  let realPathReads = 0;
  let statReads = 0;
  return {
    guard: {
      get dir() {
        dirReads += 1;
        if (dirReads > 1) throw new Error("dir read more than once");
        return guard.dir;
      },
      get realPath() {
        realPathReads += 1;
        if (realPathReads > 1) throw new Error("realPath read more than once");
        return guard.realPath;
      },
      get stat() {
        statReads += 1;
        if (statReads > 1) throw new Error("stat read more than once");
        return guard.stat;
      },
    },
    reads: () => [dirReads, realPathReads, statReads],
  };
}

function withSingleReadIdentity(guard: AnyAsyncDirectoryGuard): {
  guard: AnyAsyncDirectoryGuard;
  reads: () => [number, number, number, number, number];
} {
  const expectedStat = guard.stat;
  let devReads = 0;
  let inoReads = 0;
  const stat = Object.create(expectedStat) as AnyAsyncDirectoryGuard["stat"];
  Object.defineProperties(stat, {
    dev: {
      get() {
        devReads += 1;
        if (devReads > 1) throw new Error("dev read more than once");
        return expectedStat.dev;
      },
    },
    ino: {
      get() {
        inoReads += 1;
        if (inoReads > 1) throw new Error("ino read more than once");
        return expectedStat.ino;
      },
    },
  });
  const wrapped = withSingleReadFields({ ...guard, stat });
  return {
    guard: wrapped.guard,
    reads: () => [...wrapped.reads(), devReads, inoReads],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("directory guard Windows pathname admission", () => {
  it("admits public identity paths before receipt access or filesystem work", async () => {
    const directory = await tempRoot("fs-safe-directory-public-raw-");
    simulateWindows();
    const alias = `${directory}:stream`;
    const reads = { dev: 0, ino: 0, realPath: 0 };
    const expected = Object.defineProperties({}, {
      dev: { get() { reads.dev += 1; throw new Error("dev must not be read"); } },
      ino: { get() { reads.ino += 1; throw new Error("ino must not be read"); } },
      realPath: { get() { reads.realPath += 1; throw new Error("realPath must not be read"); } },
    }) as Parameters<typeof assertDirectoryIdentitySync>[1];
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const canonicalize = vi.spyOn(realpath.realpathSync, "native");

    await expect(readDirectoryIdentity(alias)).rejects.toMatchObject(aliasError);
    expect(() => assertDirectoryIdentitySync(alias, expected))
      .toThrow(expect.objectContaining(aliasError));
    expect(reads).toEqual({ dev: 0, ino: 0, realPath: 0 });
    expect(lstat).not.toHaveBeenCalled();
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("snapshots public identity receipts and admits their canonical path before I/O", async () => {
    const directory = await tempRoot("fs-safe-directory-public-receipt-");
    const stable = await readDirectoryIdentity(directory);
    simulateWindows();
    const reads = { dev: 0, ino: 0, realPath: 0 };
    const expected = {
      get dev() { reads.dev += 1; return stable.dev; },
      get ino() { reads.ino += 1; return stable.ino; },
      get realPath() { reads.realPath += 1; return `${stable.realPath}:stream`; },
    };
    const lstat = vi.spyOn(fsSync, "lstatSync");

    expect(() => assertDirectoryIdentitySync(directory, expected))
      .toThrow(expect.objectContaining(aliasError));
    expect(reads).toEqual({ dev: 1, ino: 1, realPath: 1 });
    expect(lstat).not.toHaveBeenCalled();
  });

  it("reads valid public identity receipt fields once and rejects canonical aliases", async () => {
    const directory = await tempRoot("fs-safe-directory-public-canonical-");
    const stable = await readDirectoryIdentity(directory);
    const reads = { dev: 0, ino: 0, realPath: 0 };
    const expected = {
      get dev() { reads.dev += 1; return stable.dev; },
      get ino() { reads.ino += 1; return stable.ino; },
      get realPath() { reads.realPath += 1; return stable.realPath; },
    };

    expect(assertDirectoryIdentitySync(directory, expected)).toBeUndefined();
    expect(reads).toEqual({ dev: 1, ino: 1, realPath: 1 });

    simulateWindows();
    const alias = `${directory}:stream`;
    const canonicalize = vi.spyOn(realpath.realpathSync, "native").mockReturnValue(alias);
    expect(() => assertDirectoryIdentitySync(directory, stable))
      .toThrow(expect.objectContaining(aliasError));
    expect(canonicalize).toHaveBeenCalledTimes(1);
    canonicalize.mockClear();
    await expect(readDirectoryIdentity(directory)).rejects.toMatchObject(aliasError);
    expect(canonicalize).toHaveBeenCalledTimes(1);
  });

  it("rejects raw aliases before identity or canonical filesystem work", async () => {
    const directory = await tempRoot("fs-safe-directory-guard-raw-");
    simulateWindows();
    const alias = `${directory}:stream`;
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const canonicalize = vi.spyOn(realpath.realpathSync, "native");

    await expect(createAsyncDirectoryGuard(alias)).rejects.toMatchObject(aliasError);
    await expect(createAsyncDirectoryGuard(alias, { bigint: true }))
      .rejects.toMatchObject(aliasError);
    expect(() => createSyncDirectoryGuard(alias))
      .toThrow(expect.objectContaining(aliasError));
    expect(lstat).not.toHaveBeenCalled();
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("admits nearest-existing and direct identity inputs before normalization or I/O", async () => {
    const directory = await tempRoot("fs-safe-directory-guard-nearest-");
    const exact = await createAsyncDirectoryGuard(directory, { bigint: true });
    simulateWindows();
    const erasedAlias = `${directory}\\child:stream\\..`;
    const missing = `${directory}\\missing\\child`;
    const lstat = vi.spyOn(fsSync, "lstatSync");

    await expect(createNearestExistingDirectoryGuard(erasedAlias, missing))
      .rejects.toMatchObject(aliasError);
    await expect(createNearestExistingDirectoryGuard(directory, erasedAlias))
      .rejects.toMatchObject(aliasError);
    expect(() => createNearestExistingSyncDirectoryGuard(erasedAlias, missing))
      .toThrow(expect.objectContaining(aliasError));
    expect(() => createNearestExistingSyncDirectoryGuard(directory, erasedAlias))
      .toThrow(expect.objectContaining(aliasError));
    await expect(inspectDirectoryIdentity(erasedAlias)).rejects.toMatchObject(aliasError);
    await expect(inspectDirectoryIdentity(erasedAlias, exact.stat))
      .rejects.toMatchObject(aliasError);
    expect(lstat).not.toHaveBeenCalled();
  });

  it("rejects canonical aliases from every creation variant", async () => {
    const directory = await tempRoot("fs-safe-directory-guard-canonical-");
    const alias = `${directory}:stream`;
    simulateWindows();

    for (const options of [undefined, { bigint: true }] as const) {
      const canonicalize = vi.spyOn(realpath.realpathSync, "native").mockReturnValue(alias);
      const pending = options === undefined
        ? createAsyncDirectoryGuard(directory)
        : createAsyncDirectoryGuard(directory, options);
      await expect(pending).rejects.toMatchObject(aliasError);
      expect(canonicalize).toHaveBeenCalledTimes(1);
      canonicalize.mockRestore();
    }

    const canonicalize = vi.spyOn(realpath, "realpathSync").mockReturnValue(alias);
    expect(() => createSyncDirectoryGuard(directory))
      .toThrow(expect.objectContaining(aliasError));
    expect(canonicalize).toHaveBeenCalledTimes(1);
  });

  it("rejects aliased stored guard fields before filesystem work and snapshots them once", async () => {
    const directory = await tempRoot("fs-safe-directory-guard-stored-");
    const numeric = await createAsyncDirectoryGuard(directory);
    const exact = await createAsyncDirectoryGuard(directory, { bigint: true });
    const sync = createSyncDirectoryGuard(directory);
    simulateWindows();
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const cases: Array<{
      guard: AnyAsyncDirectoryGuard;
      assert: (guard: AnyAsyncDirectoryGuard) => Promise<void>;
    }> = [
      { guard: numeric, assert: assertAsyncDirectoryGuard },
      { guard: exact, assert: assertAsyncDirectoryGuard },
      { guard: sync, assert: async (guard) => assertSyncDirectoryGuard(guard) },
      { guard: exact, assert: async (guard) => assertSyncDirectoryGuard(guard) },
    ];

    for (const { guard, assert } of cases) {
      for (const field of ["dir", "realPath"] as const) {
        const aliasedGuard = {
          ...guard,
          [field]: `${guard[field]}:stream`,
        };
        const wrapped = withSingleReadFields(aliasedGuard);
        await expect(assert(wrapped.guard)).rejects.toMatchObject(aliasError);
        expect(wrapped.reads()).toEqual(field === "dir" ? [1, 0, 0] : [1, 1, 0]);
      }
    }
    expect(lstat).not.toHaveBeenCalled();
  });

  it("rejects freshly canonicalized aliases from every assertion variant", async () => {
    const directory = await tempRoot("fs-safe-directory-guard-recheck-");
    const numeric = await createAsyncDirectoryGuard(directory);
    const exact = await createAsyncDirectoryGuard(directory, { bigint: true });
    const sync = createSyncDirectoryGuard(directory);
    const alias = `${directory}:stream`;
    simulateWindows();

    for (const guard of [numeric, exact]) {
      const canonicalize = vi.spyOn(realpath.realpathSync, "native").mockReturnValue(alias);
      await expect(assertAsyncDirectoryGuard(guard)).rejects.toMatchObject(aliasError);
      expect(canonicalize).toHaveBeenCalledTimes(1);
      canonicalize.mockRestore();
    }

    const canonicalizeSync = vi.spyOn(realpath, "realpathSync").mockReturnValue(alias);
    expect(() => assertSyncDirectoryGuard(sync))
      .toThrow(expect.objectContaining(aliasError));
    expect(canonicalizeSync).toHaveBeenCalledTimes(1);
    canonicalizeSync.mockRestore();

    const canonicalizeExact = vi.spyOn(realpath.realpathSync, "native").mockReturnValue(alias);
    expect(() => assertSyncDirectoryGuard(exact))
      .toThrow(expect.objectContaining(aliasError));
    expect(canonicalizeExact).toHaveBeenCalledTimes(1);
  });

  it("reads valid guard fields once during asynchronous and synchronous assertions", async () => {
    const directory = await tempRoot("fs-safe-directory-guard-accessor-");
    const guards: AnyAsyncDirectoryGuard[] = [
      await createAsyncDirectoryGuard(directory),
      await createAsyncDirectoryGuard(directory, { bigint: true }),
    ];
    const assertions: Array<(guard: AnyAsyncDirectoryGuard) => Promise<void>> = [
      assertAsyncDirectoryGuard,
      async (guard) => assertSyncDirectoryGuard(guard),
    ];

    for (const guard of guards) {
      for (const assert of assertions) {
        const wrapped = withSingleReadIdentity(guard);
        await expect(assert(wrapped.guard)).resolves.toBeUndefined();
        expect(wrapped.reads()).toEqual([1, 1, 1, 1, 1]);
      }
    }
  });

  it("preserves asynchronous identity-mismatch precedence without canonical work", async () => {
    const directory = await tempRoot("fs-safe-directory-guard-mismatch-");
    const guard = await createAsyncDirectoryGuard(directory);
    const expectedStat = Object.assign(Object.create(guard.stat), {
      dev: 1,
      ino: 1,
    }) as Stats;
    const observedStat = Object.assign(Object.create(guard.stat), {
      dev: 2,
      ino: 1,
    }) as Stats;
    vi.spyOn(fsSync, "lstatSync").mockReturnValue(observedStat);
    const canonicalize = vi.spyOn(realpath.realpathSync, "native").mockImplementation(() => {
      throw new Error("canonicalization must be skipped after an identity mismatch");
    });

    await expect(assertAsyncDirectoryGuard({ ...guard, stat: expectedStat }))
      .rejects.toMatchObject({ code: "path-mismatch" });
    expect(canonicalize).not.toHaveBeenCalled();
  });
});
