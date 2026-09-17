import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { fileStoreSync } from "../src/store.js";
import {
  __cleanupRegisteredTempPathForTest,
  __cleanupRegisteredTempPathsForTest,
} from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

type Captured =
  | Readonly<{ kind: "returned" }>
  | Readonly<{ kind: "threw"; error: unknown }>;
type PublicFailureScenario = "cleanup-reported" | "cleanup-suppressed" | "close";

const FAILURE_VALUES = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "+0", value: 0 },
  { label: "-0", value: -0 },
  { label: "0n", value: 0n },
  { label: "empty string", value: "" },
  { label: "NaN", value: Number.NaN },
  { label: "Error", value: new Error("control failure") },
] as const;

const PUBLIC_FAILURE_SCENARIOS: readonly PublicFailureScenario[] = [
  "cleanup-reported",
  "cleanup-suppressed",
  "close",
];

afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
});

async function captureAsync(run: () => Promise<unknown>): Promise<Captured> {
  try {
    await run();
    return { kind: "returned" };
  } catch (error) {
    return { kind: "threw", error };
  }
}

function captureSync(run: () => unknown): Captured {
  try {
    run();
    return { kind: "returned" };
  } catch (error) {
    return { kind: "threw", error };
  }
}

function thrownValue(outcome: Captured): unknown {
  expect(outcome.kind).toBe("threw");
  if (outcome.kind !== "threw") throw new Error("Expected a thrown settlement");
  return outcome.error;
}

function consumeRetainedRegistration(pathname: string): void {
  const lstat = vi.spyOn(fsSync, "lstatSync");
  try {
    __cleanupRegisteredTempPathForTest(pathname);
    expect(lstat).toHaveBeenCalledWith(pathname, { bigint: true });
  } finally {
    lstat.mockRestore();
    fsSync.rmSync(pathname, { force: true });
  }
}

function expectCleanupWrapper(actual: unknown, operation: unknown, cleanup: unknown): void {
  expect(actual).toBeInstanceOf(Error);
  expect(actual).not.toBeInstanceOf(AggregateError);
  const wrapped = actual as Error & { cause?: unknown };
  expect(Object.hasOwn(wrapped, "cause")).toBe(true);
  expect(Object.is(wrapped.cause, operation)).toBe(true);
  expect(wrapped.message).toBe(
    `Atomic file replace failed (${String(operation)}); cleanup also failed (${String(cleanup)})`,
  );
}

function expectAggregate(
  actual: unknown,
  message: string,
  first: unknown,
  second: unknown,
): void {
  expect(actual).toBeInstanceOf(AggregateError);
  const aggregate = actual as AggregateError;
  expect(aggregate.message).toBe(message);
  expect(aggregate.errors).toHaveLength(2);
  expect(Object.is(aggregate.errors[0], first)).toBe(true);
  expect(Object.is(aggregate.errors[1], second)).toBe(true);
}

function expectPublicFailure(params: {
  outcome: Captured;
  operation: unknown;
  cleanupFailure: Error;
  closeFailure: Error;
  scenario: PublicFailureScenario;
}): void {
  const actual = thrownValue(params.outcome);
  if (params.scenario === "cleanup-reported") {
    expectCleanupWrapper(actual, params.operation, params.cleanupFailure);
  } else if (params.scenario === "cleanup-suppressed") {
    expect(Object.is(actual, params.operation)).toBe(true);
  } else {
    expectAggregate(
      actual,
      "Atomic file replace and close failed",
      params.operation,
      params.closeFailure,
    );
  }
}

describe("public atomic settlement boundary", () => {
  it.each(FAILURE_VALUES.flatMap((failure) =>
    PUBLIC_FAILURE_SCENARIOS.map((scenario) => ({ failure, scenario }))))(
    "preserves async $failure.label through $scenario",
    async ({ failure, scenario }) => {
      const root = await tempRoot(`fs-safe-public-atomic-settlement-async-${scenario}-`);
      const filePath = path.join(root, "target");
      await fs.writeFile(filePath, "old");
      const cleanupFailure = new Error("cleanup failure");
      const closeFailure = new Error("close failure");
      let tempPath = "";
      let cleanupAttempts = 0;
      let closeAttempts = 0;
      const open: typeof fs.open = async (candidate, flags, mode) => {
        const handle = await fs.open(candidate, flags, mode);
        if (typeof candidate === "string" && candidate.includes(".fs-safe-replace.")) {
          const close = handle.close.bind(handle);
          Object.defineProperty(handle, "close", {
            configurable: true,
            value: async () => {
              closeAttempts += 1;
              await close();
              if (scenario === "close") throw closeFailure;
            },
          });
        }
        return handle;
      };
      const unlink: typeof fs.unlink = async (candidate) => {
        if (candidate === tempPath) {
          cleanupAttempts += 1;
          if (scenario !== "close") throw cleanupFailure;
        }
        await fs.unlink(candidate);
      };

      const outcome = await captureAsync(async () => await replaceFileAtomic({
        filePath,
        content: "new",
        throwOnCleanupError: scenario === "cleanup-reported",
        fileSystem: { promises: { ...fs, open, unlink } },
        beforeRename: async ({ tempPath: candidate }) => {
          tempPath = candidate;
          throw failure.value;
        },
      }));

      expectPublicFailure({
        outcome,
        operation: failure.value,
        cleanupFailure,
        closeFailure,
        scenario,
      });
      expect(cleanupAttempts).toBe(1);
      expect(closeAttempts).toBe(1);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("old");
      if (scenario === "close") {
        await expect(fs.lstat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(tempPath, "utf8")).resolves.toBe("new");
        consumeRetainedRegistration(tempPath);
        await expect(fs.lstat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each(FAILURE_VALUES.flatMap((failure) =>
    PUBLIC_FAILURE_SCENARIOS.map((scenario) => ({ failure, scenario }))))(
    "preserves sync $failure.label through $scenario",
    async ({ failure, scenario }) => {
      const root = await tempRoot(`fs-safe-public-atomic-settlement-sync-${scenario}-`);
      const filePath = path.join(root, "target");
      fsSync.writeFileSync(filePath, "old");
      const cleanupFailure = new Error("cleanup failure");
      const closeFailure = new Error("close failure");
      const openSync = fsSync.openSync.bind(fsSync);
      const unlinkSync = fsSync.unlinkSync.bind(fsSync);
      const closeSync = fsSync.closeSync.bind(fsSync);
      let tempPath = "";
      let tempFd: number | undefined;
      let cleanupAttempts = 0;
      let closeAttempts = 0;
      const fileSystem = {
        ...fsSync,
        openSync: ((candidate: fsSync.PathLike, flags: fsSync.OpenMode, mode?: fsSync.Mode) => {
          const fd = openSync(candidate, flags, mode);
          if (typeof candidate === "string" && candidate.includes(".fs-safe-replace.")) {
            tempFd = fd;
          }
          return fd;
        }) as typeof fsSync.openSync,
        unlinkSync: ((candidate: fsSync.PathLike) => {
          if (candidate === tempPath) {
            cleanupAttempts += 1;
            if (scenario !== "close") throw cleanupFailure;
          }
          unlinkSync(candidate);
        }) as typeof fsSync.unlinkSync,
        closeSync: ((fd: number) => {
          if (fd === tempFd) {
            closeAttempts += 1;
            closeSync(fd);
            if (scenario === "close") throw closeFailure;
            return;
          }
          closeSync(fd);
        }) as typeof fsSync.closeSync,
      };

      const outcome = captureSync(() => replaceFileAtomicSync({
        filePath,
        content: "new",
        throwOnCleanupError: scenario === "cleanup-reported",
        fileSystem,
        beforeRename: ({ tempPath: candidate }) => {
          tempPath = candidate;
          throw failure.value;
        },
      }));

      expectPublicFailure({
        outcome,
        operation: failure.value,
        cleanupFailure,
        closeFailure,
        scenario,
      });
      expect(cleanupAttempts).toBe(1);
      expect(closeAttempts).toBe(1);
      expect(fsSync.readFileSync(filePath, "utf8")).toBe("old");
      if (scenario === "close") {
        expect(() => fsSync.lstatSync(tempPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
      } else {
        expect(fsSync.readFileSync(tempPath, "utf8")).toBe("new");
        consumeRetainedRegistration(tempPath);
        expect(() => fsSync.lstatSync(tempPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
      }
    },
  );

  it("keeps a synchronous store's thrown undefined distinct from a close failure", async () => {
    const root = await tempRoot("fs-safe-store-settlement-undefined-close-");
    const filePath = path.join(root, "target");
    fsSync.writeFileSync(filePath, "old");
    const store = fileStoreSync({ rootDir: root, durable: false });
    const openSync = fsSync.openSync.bind(fsSync);
    const renameSync = fsSync.renameSync.bind(fsSync);
    const closeSync = fsSync.closeSync.bind(fsSync);
    const closeFailure = new Error("store temp close failure");
    let tempPath = "";
    let tempFd: number | undefined;
    let closeAttempts = 0;

    vi.spyOn(fsSync, "openSync").mockImplementation(((candidate, flags, mode) => {
      const fd = openSync(candidate, flags, mode);
      if (typeof candidate === "string" && candidate.includes(".fs-safe-")) {
        tempPath = candidate;
        tempFd = fd;
      }
      return fd;
    }) as typeof fsSync.openSync);
    vi.spyOn(fsSync, "renameSync").mockImplementation(((source, destination) => {
      if (source === tempPath) throw undefined;
      renameSync(source, destination);
    }) as typeof fsSync.renameSync);
    vi.spyOn(fsSync, "closeSync").mockImplementation(((fd) => {
      if (fd === tempFd) {
        closeAttempts += 1;
        closeSync(fd);
        throw closeFailure;
      }
      closeSync(fd);
    }) as typeof fsSync.closeSync);

    const outcome = captureSync(() => store.write("target", "new", { durable: false }));
    expectAggregate(
      thrownValue(outcome),
      "Atomic file replace and close failed",
      undefined,
      closeFailure,
    );
    expect(closeAttempts).toBe(1);
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("old");
    expect(() => fsSync.lstatSync(tempPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
});


describe("public post-publication settlement", () => {
  it.each(FAILURE_VALUES.flatMap((failure) =>
    ["async", "sync", "store"].map((api) => ({ failure, api }))))(
    "preserves $api successful-publication close throwing $failure.label",
    async ({ failure, api }) => {
      const root = await tempRoot(`fs-safe-published-settlement-${api}-`);
      const filePath = path.join(root, "target");
      await fs.writeFile(filePath, "old");
      let closeAttempts = 0;
      let outcome: Captured;
      const isTemp = (candidate: fsSync.PathLike) =>
        path.basename(String(candidate)).startsWith(".fs-safe-");

      if (api === "async") {
        const open: typeof fs.open = async (candidate, flags, mode) => {
          const handle = await fs.open(candidate, flags, mode);
          if (isTemp(candidate)) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              closeAttempts += 1;
              await close();
              throw failure.value;
            };
          }
          return handle;
        };
        outcome = await captureAsync(() => replaceFileAtomic({
          filePath,
          content: "published",
          fileSystem: { promises: { ...fs, open } },
        }));
      } else {
        const realOpen = fsSync.openSync.bind(fsSync);
        const realClose = fsSync.closeSync.bind(fsSync);
        const tempDescriptors = new Set<number>();
        const openSync: typeof fsSync.openSync = (candidate, flags, mode) => {
          const fd = realOpen(candidate, flags, mode);
          if (isTemp(candidate)) tempDescriptors.add(fd);
          return fd;
        };
        const closeSync: typeof fsSync.closeSync = (fd) => {
          const owned = tempDescriptors.delete(fd);
          realClose(fd);
          if (owned) {
            closeAttempts += 1;
            throw failure.value;
          }
        };
        if (api === "store") {
          vi.spyOn(fsSync, "openSync").mockImplementation(openSync);
          vi.spyOn(fsSync, "closeSync").mockImplementation(closeSync);
          const store = fileStoreSync({ rootDir: root, durable: false });
          outcome = captureSync(() => store.write("target", "published"));
        } else {
          outcome = captureSync(() => replaceFileAtomicSync({
            filePath,
            content: "published",
            fileSystem: { ...fsSync, openSync, closeSync },
          }));
        }
      }

      expect(Object.is(thrownValue(outcome), failure.value)).toBe(true);
      expect(closeAttempts).toBe(1);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("published");
      expect(await fs.readdir(root)).toEqual(["target"]);
    },
  );

  it("retains store publication when rename commits then throws undefined and close throws false", async () => {
    const root = await tempRoot("fs-safe-store-post-publication-settlement-");
    const filePath = path.join(root, "target");
    await fs.writeFile(filePath, "old");
    const store = fileStoreSync({ rootDir: root, durable: false });
    const realOpen = fsSync.openSync.bind(fsSync);
    const realClose = fsSync.closeSync.bind(fsSync);
    const realRename = fsSync.renameSync.bind(fsSync);
    const tempDescriptors = new Set<number>();
    let closeAttempts = 0;
    vi.spyOn(fsSync, "openSync").mockImplementation((candidate, flags, mode) => {
      const fd = realOpen(candidate, flags, mode);
      if (path.basename(String(candidate)).startsWith(".fs-safe-")) tempDescriptors.add(fd);
      return fd;
    });
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      realRename(from, to);
      throw undefined;
    });
    vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
      const owned = tempDescriptors.delete(fd);
      realClose(fd);
      if (owned) {
        closeAttempts += 1;
        throw false;
      }
    });

    const outcome = captureSync(() => store.write("target", "published"));
    expectAggregate(
      thrownValue(outcome),
      "Atomic file replace and close failed",
      undefined,
      false,
    );
    expect(closeAttempts).toBe(1);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("published");
    expect(await fs.readdir(root)).toEqual(["target"]);
  });
});
