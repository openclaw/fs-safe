import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const FALSY_THROWN_VALUES = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "+0", value: 0 },
  { label: "-0", value: -0 },
  { label: "empty string", value: "" },
  { label: "zero bigint", value: 0n },
  { label: "NaN", value: Number.NaN },
] as const;

type Failure = { error: unknown };

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
    expect(Object.is(aggregate.errors[index], expected)).toBe(true);
  });
}

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
      expect(writes).toBe(2);
      await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.alloc(0));
      expect(await fs.readdir(root)).toEqual(["value"]);
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
      expect(writes).toBe(2);
      await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.alloc(0));
      expect(await fs.readdir(root)).toEqual(["value"]);
    });
  }
});
