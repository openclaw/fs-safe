import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { __cleanupRegisteredTempPathForTest } from "../src/temp-cleanup.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const TEMP_PREFIX = ".fs-safe-falsy-settlement";
const FALSY_THROWN_VALUES = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "zero", value: 0 },
  { label: "empty string", value: "" },
  { label: "zero bigint", value: 0n },
  { label: "NaN", value: Number.NaN },
] as const;

type Failure = { error: unknown };

afterEach(() => {
  vi.restoreAllMocks();
});

async function captureAsyncFailure(run: () => Promise<unknown>): Promise<Failure> {
  try {
    await run();
  } catch (error) {
    return { error };
  }
  throw new Error("Expected asynchronous operation to throw");
}

function captureSyncFailure(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    return { error };
  }
  throw new Error("Expected synchronous operation to throw");
}

function asyncAdapter(params: {
  closeFailure?: Failure;
  unlinkFailure?: Failure;
} = {}) {
  const tempPaths = new Set<string>();
  const open: typeof fs.open = async (candidate, flags, mode) => {
    const handle = await fs.open(candidate, flags, mode);
    if (!String(candidate).includes(TEMP_PREFIX)) return handle;
    tempPaths.add(String(candidate));
    return new Proxy(handle, {
      get(target, property) {
        if (property === "close") {
          return async () => {
            await target.close();
            if (params.closeFailure !== undefined) throw params.closeFailure.error;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FileHandle;
  };
  const unlink: typeof fs.unlink = async (candidate) => {
    if (tempPaths.has(String(candidate)) && params.unlinkFailure !== undefined) {
      throw params.unlinkFailure.error;
    }
    await fs.unlink(candidate);
  };
  return { promises: { ...fs, open, unlink } };
}

function syncAdapter(params: {
  closeFailure?: Failure;
  unlinkFailure?: Failure;
} = {}) {
  const tempDescriptors = new Set<number>();
  const openSync: typeof fsSync.openSync = (candidate, flags, mode) => {
    const descriptor = fsSync.openSync(candidate, flags, mode);
    if (String(candidate).includes(TEMP_PREFIX)) tempDescriptors.add(descriptor);
    return descriptor;
  };
  const closeSync: typeof fsSync.closeSync = (descriptor) => {
    const isTemp = tempDescriptors.delete(descriptor);
    fsSync.closeSync(descriptor);
    if (isTemp && params.closeFailure !== undefined) throw params.closeFailure.error;
  };
  const unlinkSync: typeof fsSync.unlinkSync = (candidate) => {
    if (String(candidate).includes(TEMP_PREFIX) && params.unlinkFailure !== undefined) {
      throw params.unlinkFailure.error;
    }
    fsSync.unlinkSync(candidate);
  };
  return { ...fsSync, closeSync, openSync, unlinkSync };
}

function expectAggregate(
  value: unknown,
  message: string,
  expectedErrors: readonly unknown[],
): void {
  expect(value).toBeInstanceOf(AggregateError);
  const aggregate = value as AggregateError;
  expect(aggregate.message).toBe(message);
  expect(aggregate.errors).toHaveLength(expectedErrors.length);
  expectedErrors.forEach((expected, index) => {
    expect(aggregate.errors[index]).toBe(expected);
  });
}

describe("atomic replacement falsy settlement", () => {
  for (const testCase of FALSY_THROWN_VALUES) {
    it(`preserves an async successful-publication close throwing ${testCase.label}`, async () => {
      const root = await tempRoot("fs-safe-falsy-close-async-");
      const filePath = path.join(root, "value");
      const failure = await captureAsyncFailure(() => replaceFileAtomic({
        filePath,
        content: "published",
        fileSystem: asyncAdapter({ closeFailure: { error: testCase.value } }),
        tempPrefix: TEMP_PREFIX,
      }));

      expect(failure.error).toBe(testCase.value);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("published");
    });

    it(`preserves a sync successful-publication close throwing ${testCase.label}`, async () => {
      const root = await tempRoot("fs-safe-falsy-close-sync-");
      const filePath = path.join(root, "value");
      const failure = captureSyncFailure(() => replaceFileAtomicSync({
        filePath,
        content: "published",
        fileSystem: syncAdapter({ closeFailure: { error: testCase.value } }),
        tempPrefix: TEMP_PREFIX,
      }));

      expect(failure.error).toBe(testCase.value);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("published");
    });
  }

  it("preserves an async original throw undefined after successful cleanup", async () => {
    const root = await tempRoot("fs-safe-falsy-original-clean-async-");
    const filePath = path.join(root, "value");
    let tempPath = "";
    const failure = await captureAsyncFailure(() => replaceFileAtomic({
      filePath,
      content: "staged",
      fileSystem: asyncAdapter(),
      tempPrefix: TEMP_PREFIX,
      beforeRename: async (entry) => {
        tempPath = entry.tempPath;
        throw undefined;
      },
    }));

    expect(failure.error).toBeUndefined();
    await expect(fs.access(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a sync original throw undefined after successful cleanup", async () => {
    const root = await tempRoot("fs-safe-falsy-original-clean-sync-");
    const filePath = path.join(root, "value");
    let tempPath = "";
    const failure = captureSyncFailure(() => replaceFileAtomicSync({
      filePath,
      content: "staged",
      fileSystem: syncAdapter(),
      tempPrefix: TEMP_PREFIX,
      beforeRename: (entry) => {
        tempPath = entry.tempPath;
        throw undefined;
      },
    }));

    expect(failure.error).toBeUndefined();
    await expect(fs.access(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  for (const testCase of FALSY_THROWN_VALUES) {
    it(`preserves async strict cleanup after original undefined when unlink throws ${testCase.label}`, async () => {
      const root = await tempRoot("fs-safe-falsy-unlink-async-");
      const filePath = path.join(root, "value");
      let tempPath = "";
      try {
        const failure = await captureAsyncFailure(() => replaceFileAtomic({
          filePath,
          content: "staged",
          fileSystem: asyncAdapter({ unlinkFailure: { error: testCase.value } }),
          tempPrefix: TEMP_PREFIX,
          throwOnCleanupError: true,
          beforeRename: async (entry) => {
            tempPath = entry.tempPath;
            throw undefined;
          },
        }));

        expect(failure.error).toBeInstanceOf(Error);
        const cleanupError = failure.error as Error & { cause?: unknown };
        expect(cleanupError.message).toBe(
          `Atomic file replace failed (undefined); cleanup also failed (${String(testCase.value)})`,
        );
        expect(Object.hasOwn(cleanupError, "cause")).toBe(true);
        expect(cleanupError.cause).toBeUndefined();
        await expect(fs.readFile(tempPath, "utf8")).resolves.toBe("staged");
      } finally {
        if (tempPath) __cleanupRegisteredTempPathForTest(tempPath);
      }
    });

    it(`preserves sync strict cleanup after original undefined when unlink throws ${testCase.label}`, async () => {
      const root = await tempRoot("fs-safe-falsy-unlink-sync-");
      const filePath = path.join(root, "value");
      let tempPath = "";
      try {
        const failure = captureSyncFailure(() => replaceFileAtomicSync({
          filePath,
          content: "staged",
          fileSystem: syncAdapter({ unlinkFailure: { error: testCase.value } }),
          tempPrefix: TEMP_PREFIX,
          throwOnCleanupError: true,
          beforeRename: (entry) => {
            tempPath = entry.tempPath;
            throw undefined;
          },
        }));

        expect(failure.error).toBeInstanceOf(Error);
        const cleanupError = failure.error as Error & { cause?: unknown };
        expect(cleanupError.message).toBe(
          `Atomic file replace failed (undefined); cleanup also failed (${String(testCase.value)})`,
        );
        expect(Object.hasOwn(cleanupError, "cause")).toBe(true);
        expect(cleanupError.cause).toBeUndefined();
        await expect(fs.readFile(tempPath, "utf8")).resolves.toBe("staged");
      } finally {
        if (tempPath) __cleanupRegisteredTempPathForTest(tempPath);
      }
    });

    it(`retains async original undefined before close throwing ${testCase.label}`, async () => {
      const root = await tempRoot("fs-safe-falsy-original-close-async-");
      const filePath = path.join(root, "value");
      const failure = await captureAsyncFailure(() => replaceFileAtomic({
        filePath,
        content: "staged",
        fileSystem: asyncAdapter({ closeFailure: { error: testCase.value } }),
        tempPrefix: TEMP_PREFIX,
        beforeRename: async () => {
          throw undefined;
        },
      }));

      expectAggregate(
        failure.error,
        "Atomic file replace and close failed",
        [undefined, testCase.value],
      );
    });

    it(`retains sync original undefined before close throwing ${testCase.label}`, async () => {
      const root = await tempRoot("fs-safe-falsy-original-close-sync-");
      const filePath = path.join(root, "value");
      const failure = captureSyncFailure(() => replaceFileAtomicSync({
        filePath,
        content: "staged",
        fileSystem: syncAdapter({ closeFailure: { error: testCase.value } }),
        tempPrefix: TEMP_PREFIX,
        beforeRename: () => {
          throw undefined;
        },
      }));

      expectAggregate(
        failure.error,
        "Atomic file replace and close failed",
        [undefined, testCase.value],
      );
    });
  }

  it("retains async cleanup and close faults after original undefined", async () => {
    const root = await tempRoot("fs-safe-falsy-both-async-");
    const filePath = path.join(root, "value");
    const unlinkFailure = null;
    const closeFailure = false;
    let tempPath = "";
    try {
      const failure = await captureAsyncFailure(() => replaceFileAtomic({
        filePath,
        content: "staged",
        fileSystem: asyncAdapter({
          unlinkFailure: { error: unlinkFailure },
          closeFailure: { error: closeFailure },
        }),
        tempPrefix: TEMP_PREFIX,
        throwOnCleanupError: true,
        beforeRename: async (entry) => {
          tempPath = entry.tempPath;
          throw undefined;
        },
      }));

      expect(failure.error).toBeInstanceOf(AggregateError);
      const aggregate = failure.error as AggregateError;
      const cleanupError = aggregate.errors[0] as Error & { cause?: unknown };
      expect(aggregate.message).toBe("Atomic temp cleanup and close failed");
      expect(cleanupError.message).toBe(
        "Atomic file replace failed (undefined); cleanup also failed (null)",
      );
      expect(Object.hasOwn(cleanupError, "cause")).toBe(true);
      expect(cleanupError.cause).toBeUndefined();
      expect(aggregate.errors[1]).toBe(closeFailure);
    } finally {
      if (tempPath) __cleanupRegisteredTempPathForTest(tempPath);
    }
  });

  it("retains sync cleanup and close faults after original undefined", async () => {
    const root = await tempRoot("fs-safe-falsy-both-sync-");
    const filePath = path.join(root, "value");
    const unlinkFailure = null;
    const closeFailure = false;
    let tempPath = "";
    try {
      const failure = captureSyncFailure(() => replaceFileAtomicSync({
        filePath,
        content: "staged",
        fileSystem: syncAdapter({
          unlinkFailure: { error: unlinkFailure },
          closeFailure: { error: closeFailure },
        }),
        tempPrefix: TEMP_PREFIX,
        throwOnCleanupError: true,
        beforeRename: (entry) => {
          tempPath = entry.tempPath;
          throw undefined;
        },
      }));

      expect(failure.error).toBeInstanceOf(AggregateError);
      const aggregate = failure.error as AggregateError;
      const cleanupError = aggregate.errors[0] as Error & { cause?: unknown };
      expect(aggregate.message).toBe("Atomic temp cleanup and close failed");
      expect(cleanupError.message).toBe(
        "Atomic file replace failed (undefined); cleanup also failed (null)",
      );
      expect(Object.hasOwn(cleanupError, "cause")).toBe(true);
      expect(cleanupError.cause).toBeUndefined();
      expect(aggregate.errors[1]).toBe(closeFailure);
    } finally {
      if (tempPath) __cleanupRegisteredTempPathForTest(tempPath);
    }
  });
});

describe("copy fallback restoration falsy causes", () => {
  for (const testCase of FALSY_THROWN_VALUES) {
    it(`retains async restoration failure ${testCase.label} in the cause chain`, async () => {
      const root = await tempRoot("fs-safe-falsy-restore-async-");
      const filePath = path.join(root, "value");
      await fs.writeFile(filePath, "original");
      const writeFailure = new Error("replacement write failed");
      let writes = 0;
      const open: typeof fs.open = async (candidate, flags, mode) => {
        const handle = await fs.open(candidate, flags, mode);
        if (candidate !== filePath || typeof flags !== "number" ||
          !(flags & fsSync.constants.O_RDWR)) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "write") {
              return async () => {
                writes += 1;
                if (writes === 1) throw writeFailure;
                throw testCase.value;
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as FileHandle;
      };

      const failure = await captureAsyncFailure(() => replaceFileAtomic({
        filePath,
        content: "replacement",
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 1024,
        fileSystem: {
          promises: {
            ...fs,
            open,
            rename: async () => {
              throw Object.assign(new Error("rename denied"), { code: "EPERM" });
            },
          },
        },
      }));

      const restoreFailure = failure.error as Error & {
        cause: unknown;
        code: unknown;
        details: unknown;
      };
      expect(restoreFailure.code).toBe("helper-failed");
      expect(restoreFailure.details).toEqual({ cleanup: "restore-failed" });
      expectAggregate(
        restoreFailure.cause,
        "copy fallback and original restoration both failed",
        [writeFailure, testCase.value],
      );
    });

    it(`retains sync restoration failure ${testCase.label} in the cause chain`, async () => {
      const root = await tempRoot("fs-safe-falsy-restore-sync-");
      const filePath = path.join(root, "value");
      await fs.writeFile(filePath, "original");
      const writeFailure = new Error("replacement write failed");
      let destinationDescriptor: number | undefined;
      let writes = 0;
      const fileSystem = {
        ...fsSync,
        renameSync: () => {
          throw Object.assign(new Error("rename denied"), { code: "EPERM" });
        },
        openSync: ((candidate: fsSync.PathLike, flags: fsSync.OpenMode, mode?: fsSync.Mode) => {
          const descriptor = fsSync.openSync(candidate, flags, mode);
          if (candidate === filePath && typeof flags === "number" &&
            (flags & fsSync.constants.O_RDWR)) destinationDescriptor = descriptor;
          return descriptor;
        }) as typeof fsSync.openSync,
        writeSync: ((descriptor: number) => {
          if (descriptor !== destinationDescriptor) {
            throw new Error("Unexpected non-destination writeSync call");
          }
          writes += 1;
          if (writes === 1) throw writeFailure;
          throw testCase.value;
        }) as typeof fsSync.writeSync,
      };

      const failure = captureSyncFailure(() => replaceFileAtomicSync({
        filePath,
        content: "replacement",
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 1024,
        fileSystem,
      }));

      const restoreFailure = failure.error as Error & {
        cause: unknown;
        code: unknown;
        details: unknown;
      };
      expect(restoreFailure.code).toBe("helper-failed");
      expect(restoreFailure.details).toEqual({ cleanup: "restore-failed" });
      expectAggregate(
        restoreFailure.cause,
        "copy fallback and original restoration both failed",
        [writeFailure, testCase.value],
      );
    });
  }
});
