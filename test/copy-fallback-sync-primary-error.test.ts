import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AtomicIo, runSync } from "../src/atomic-io.js";
import { FsSafeError } from "../src/errors.js";
import { assertDestinationHardlinkPolicy } from "../src/replace-file-copy-fallback.js";
import { replaceFileAtomicSync } from "../src/replace-file.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

function captureFailure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}

function destinationAdapter(params: {
  dest: string;
  other: string;
  mismatch: boolean;
  forceCopyFallback?: boolean;
  admissionFailure?: Readonly<{ value: unknown }>;
}) {
  const closeError = new Error("destination close receipt lost");
  const destinationFds = new Set<number>();
  const observedDestinationFds = new Set<number>();
  let destinationLstats = 0;
  let destinationCloseCalls = 0;
  const fileSystem = {
    ...fsSync,
    lstatSync(candidate: fsSync.PathLike, ...options: unknown[]) {
      let inspected = candidate;
      if (String(candidate) === params.dest && ++destinationLstats === 2 && params.mismatch) {
        inspected = params.other;
      }
      return Reflect.apply(fsSync.lstatSync, undefined, [inspected, ...options]);
    },
    openSync(candidate: fsSync.PathLike, flags: fsSync.OpenMode, mode?: fsSync.Mode) {
      const fd = fsSync.openSync(candidate, flags, mode);
      if (String(candidate) === params.dest) {
        destinationFds.add(fd);
        observedDestinationFds.add(fd);
      }
      return fd;
    },
    fstatSync(fd: number, ...options: unknown[]) {
      if (destinationFds.has(fd) && params.admissionFailure) {
        throw params.admissionFailure.value;
      }
      return Reflect.apply(fsSync.fstatSync, undefined, [fd, ...options]);
    },
    closeSync(fd: number) {
      if (observedDestinationFds.has(fd)) destinationCloseCalls += 1;
      const destination = destinationFds.delete(fd);
      fsSync.closeSync(fd);
      if (destination) throw closeError;
    },
    renameSync(source: fsSync.PathLike, destination: fsSync.PathLike) {
      if (params.forceCopyFallback && String(destination) === params.dest) {
        throw Object.assign(new Error("force copy fallback"), { code: "EPERM" });
      }
      fsSync.renameSync(source, destination);
    },
  };
  return {
    closeError,
    fileSystem,
    destinationCloseCalls: () => destinationCloseCalls,
  };
}

function expectPrimary(error: unknown, code: "not-file" | "path-mismatch", message: string): void {
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({
    code,
    category: "policy",
    message,
  });
  expect(error).not.toBeInstanceOf(AggregateError);
  expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
}

function expectNoAtomicTemps(root: string): void {
  expect(fsSync.readdirSync(root).filter(name => name.startsWith(".fs-safe-replace."))).toEqual([]);
}

const FALSY_ADMISSION_FAILURES = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "zero", value: 0 },
  { label: "negative zero", value: -0 },
  { label: "bigint zero", value: 0n },
  { label: "NaN", value: Number.NaN },
  { label: "empty string", value: "" },
] as const;

describe("synchronous copy-fallback destination admission cleanup", () => {
  it("preserves the helper's exact selected error and cause while closing exactly once", async () => {
    const root = await tempRoot("fs-safe-sync-admission-helper-");
    const dest = path.join(root, "dest");
    const other = path.join(root, "other");
    await fs.writeFile(dest, "original");
    await fs.mkdir(other);
    const primaryCause = new Error("destination inspection failed");
    const primary = new FsSafeError("not-file", "selected destination admission failure", {
      cause: primaryCause,
    });
    const adapter = destinationAdapter({
      dest,
      other,
      mismatch: false,
      admissionFailure: { value: primary },
    });

    const error = captureFailure(() =>
      runSync(assertDestinationHardlinkPolicy(AtomicIo.sync(adapter.fileSystem), dest, "reject")));

    expect(error).toBe(primary);
    expect((error as Error).cause).toBe(primaryCause);
    expect(error).not.toBe(adapter.closeError);
    expect(adapter.destinationCloseCalls()).toBe(1);
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
  });

  it("still reports a lone close failure after successful helper admission", async () => {
    const root = await tempRoot("fs-safe-sync-admission-close-");
    const dest = path.join(root, "dest");
    const other = path.join(root, "other");
    await fs.writeFile(dest, "original");
    await fs.mkdir(other);
    const adapter = destinationAdapter({ dest, other, mismatch: false });

    const error = captureFailure(() =>
      runSync(assertDestinationHardlinkPolicy(AtomicIo.sync(adapter.fileSystem), dest, "reject")));

    expect(error).toBe(adapter.closeError);
    expect(adapter.destinationCloseCalls()).toBe(1);
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
  });

  const publicRoutes = [
    {
      route: "pre-rename",
      options: { destinationHardlinks: "reject" },
      forceCopyFallback: false,
      code: "path-mismatch",
      message: "Atomic replace destination changed while opening",
    },
    {
      route: "pinned copy-fallback",
      options: {
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 64,
      },
      forceCopyFallback: true,
      code: "not-file",
      message: "Copy fallback destination must be a regular file",
    },
  ] as const;

  it.each(publicRoutes)("preserves the public $route admission failure and cleans its stage", async (route) => {
    const root = await tempRoot("fs-safe-sync-admission-public-");
    const dest = path.join(root, "dest");
    const other = path.join(root, "other");
    await fs.writeFile(dest, "original");
    await fs.mkdir(other);
    const adapter = destinationAdapter({ dest, other, mismatch: true, forceCopyFallback: route.forceCopyFallback });

    const error = captureFailure(() => replaceFileAtomicSync({
      filePath: dest,
      content: "replacement",
      fileSystem: adapter.fileSystem,
      ...route.options,
    }));

    expectPrimary(error, route.code, `${route.message}: ${dest}`);
    expect(error).not.toBe(adapter.closeError);
    expect(adapter.destinationCloseCalls()).toBe(1);
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
    expectNoAtomicTemps(root);
  });

  describe.each([
    { route: "helper", forceCopyFallback: false, options: undefined },
    ...publicRoutes,
  ])("$route falsy failures", (route) => {
    it.each(FALSY_ADMISSION_FAILURES)("preserves $label admission failure by exact identity", async ({ value }) => {
      const root = await tempRoot("fs-safe-sync-admission-falsy-");
      const dest = path.join(root, "dest");
      const other = path.join(root, "other");
      await fs.writeFile(dest, "original");
      await fs.mkdir(other);
      const adapter = destinationAdapter({
        dest,
        other,
        mismatch: false,
        forceCopyFallback: route.forceCopyFallback,
        admissionFailure: { value },
      });

      const error = captureFailure(() => route.options
        ? replaceFileAtomicSync({
          filePath: dest,
          content: "replacement",
          fileSystem: adapter.fileSystem,
          ...route.options,
        })
        : runSync(assertDestinationHardlinkPolicy(AtomicIo.sync(adapter.fileSystem), dest, "reject")));

      expect(Object.is(error, value)).toBe(true);
      expect(adapter.destinationCloseCalls()).toBe(1);
      await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
      if (route.options) expectNoAtomicTemps(root);
    });
  });
});
