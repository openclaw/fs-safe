import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { assertDestinationHardlinkPolicySync } from "../src/replace-file-copy-fallback.js";
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
      assertDestinationHardlinkPolicySync(adapter.fileSystem, dest, "reject"));

    expect(error).toBe(primary);
    expect((error as Error).cause).toBe(primaryCause);
    expect(error).not.toBe(adapter.closeError);
    expect(adapter.destinationCloseCalls()).toBe(1);
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
  });

  it.each(FALSY_ADMISSION_FAILURES)(
    "preserves a direct $label admission failure by exact identity",
    async ({ value }) => {
      const root = await tempRoot("fs-safe-sync-admission-falsy-helper-");
      const dest = path.join(root, "dest");
      const other = path.join(root, "other");
      await fs.writeFile(dest, "original");
      await fs.mkdir(other);
      const adapter = destinationAdapter({
        dest,
        other,
        mismatch: false,
        admissionFailure: { value },
      });

      const error = captureFailure(() =>
        assertDestinationHardlinkPolicySync(adapter.fileSystem, dest, "reject"));

      expect(Object.is(error, value)).toBe(true);
      expect(adapter.destinationCloseCalls()).toBe(1);
      await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
    },
  );

  it("still reports a lone close failure after successful helper admission", async () => {
    const root = await tempRoot("fs-safe-sync-admission-close-");
    const dest = path.join(root, "dest");
    const other = path.join(root, "other");
    await fs.writeFile(dest, "original");
    await fs.mkdir(other);
    const adapter = destinationAdapter({ dest, other, mismatch: false });

    const error = captureFailure(() =>
      assertDestinationHardlinkPolicySync(adapter.fileSystem, dest, "reject"));

    expect(error).toBe(adapter.closeError);
    expect(adapter.destinationCloseCalls()).toBe(1);
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
  });

  it("preserves the public pre-rename admission failure and cleans its stage", async () => {
    const root = await tempRoot("fs-safe-sync-admission-public-");
    const dest = path.join(root, "dest");
    const other = path.join(root, "other");
    await fs.writeFile(dest, "original");
    await fs.mkdir(other);
    const adapter = destinationAdapter({ dest, other, mismatch: true });

    const error = captureFailure(() => replaceFileAtomicSync({
      filePath: dest,
      content: "replacement",
      fileSystem: adapter.fileSystem,
      destinationHardlinks: "reject",
    }));

    expectPrimary(error, "path-mismatch", `Atomic replace destination changed while opening: ${dest}`);
    expect(error).not.toBe(adapter.closeError);
    expect(adapter.destinationCloseCalls()).toBe(1);
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
    expectNoAtomicTemps(root);
  });

  it.each(FALSY_ADMISSION_FAILURES)(
    "preserves a public pre-rename $label admission failure by exact identity",
    async ({ value }) => {
      const root = await tempRoot("fs-safe-sync-admission-falsy-public-");
      const dest = path.join(root, "dest");
      const other = path.join(root, "other");
      await fs.writeFile(dest, "original");
      await fs.mkdir(other);
      const adapter = destinationAdapter({
        dest,
        other,
        mismatch: false,
        admissionFailure: { value },
      });

      const error = captureFailure(() => replaceFileAtomicSync({
        filePath: dest,
        content: "replacement",
        fileSystem: adapter.fileSystem,
        destinationHardlinks: "reject",
      }));

      expect(Object.is(error, value)).toBe(true);
      expect(adapter.destinationCloseCalls()).toBe(1);
      await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
      expectNoAtomicTemps(root);
    },
  );

  it("preserves pinned copy-fallback admission failure through the public adapter", async () => {
    const root = await tempRoot("fs-safe-sync-pinned-public-");
    const dest = path.join(root, "dest");
    const other = path.join(root, "other");
    await fs.writeFile(dest, "original");
    await fs.mkdir(other);
    const adapter = destinationAdapter({
      dest,
      other,
      mismatch: true,
      forceCopyFallback: true,
    });

    const error = captureFailure(() => replaceFileAtomicSync({
      filePath: dest,
      content: "replacement",
      fileSystem: adapter.fileSystem,
      copyFallbackOnPermissionError: true,
      copyFallbackRestore: "restore-original",
      maxRestoreBytes: 64,
    }));

    expectPrimary(error, "not-file", `Copy fallback destination must be a regular file: ${dest}`);
    expect(error).not.toBe(adapter.closeError);
    expect(adapter.destinationCloseCalls()).toBe(1);
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
    expectNoAtomicTemps(root);
  });

  it.each(FALSY_ADMISSION_FAILURES)(
    "preserves a public pinned copy-fallback $label admission failure by exact identity",
    async ({ value }) => {
      const root = await tempRoot("fs-safe-sync-pinned-falsy-public-");
      const dest = path.join(root, "dest");
      const other = path.join(root, "other");
      await fs.writeFile(dest, "original");
      await fs.mkdir(other);
      const adapter = destinationAdapter({
        dest,
        other,
        mismatch: false,
        forceCopyFallback: true,
        admissionFailure: { value },
      });

      const error = captureFailure(() => replaceFileAtomicSync({
        filePath: dest,
        content: "replacement",
        fileSystem: adapter.fileSystem,
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 64,
      }));

      expect(Object.is(error, value)).toBe(true);
      expect(adapter.destinationCloseCalls()).toBe(1);
      await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
      expectNoAtomicTemps(root);
    },
  );
});
