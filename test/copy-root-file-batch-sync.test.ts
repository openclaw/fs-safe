import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRootFileCopyBatchSync, type CopyRootFileSyncOptions } from "../src/advanced.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { loadTestNative } from "./helpers/native-probe.js";
import * as directoryGuards from "../src/directory-guard.js";
import { fileSymlinkOrSkip } from "./helpers/file-symlink.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const native = loadTestNative("required-env");
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

async function fixture() {
  const directory = await tempRoot("fs-safe-copy-batch-");
  const sourceRoot = path.join(directory, "source");
  const targetRoot = path.join(directory, "target");
  for (const root of [sourceRoot, targetRoot]) fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  for (const name of ["first", "second"]) fs.writeFileSync(path.join(sourceRoot, "a", "b", name), name);
  const options = (name: string): CopyRootFileSyncOptions => ({
    source: { rootPath: sourceRoot, absolutePath: path.join(sourceRoot, "a", "b", name) },
    destination: { rootPath: targetRoot, absolutePath: path.join(targetRoot, "a", "b", name) },
    clone: "auto",
  });
  return { directory, sourceRoot, targetRoot, options };
}

describe.each([false, true])("batch revalidation (native=%s)", useNative => {
  beforeEach(context => {
    if (useNative && !native) context.skip("Native binding unavailable");
    if (useNative) __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: useNative ? "require" : "off" });
  });

  it("returns independently owned descriptors and closes metadata custody idempotently", async () => {
    const f = await fixture();
    const batch = createRootFileCopyBatchSync();
    using first = batch.copyFile(f.options("first"));
    using second = batch.copyFile(f.options("second"));
    batch.close();
    batch[Symbol.dispose]();
    expect(fs.readFileSync(first.fd, "utf8")).toBe("first");
    expect(fs.readFileSync(second.fd, "utf8")).toBe("second");
    expect(() => batch.copyFile(f.options("third"))).toThrow(expect.objectContaining({ code: "invalid-path" }));
  });

  it.each(["source", "destination"] as const)("refuses a %s ancestor replaced by a symlink back to the original tree between files", async side => {
    const f = await fixture();
    using batch = createRootFileCopyBatchSync();
    using first = batch.copyFile(f.options("first"));
    const root = side === "source" ? f.sourceRoot : f.targetRoot;
    fs.renameSync(path.join(root, "a"), path.join(root, "saved"));
    fs.symlinkSync(path.join(root, "saved"), path.join(root, "a"), process.platform === "win32" ? "junction" : "dir");
    expect(() => batch.copyFile(f.options("second"))).toThrow();
    expect(fs.existsSync(f.options("second").destination.absolutePath)).toBe(false);
    expect(fs.readFileSync(first.fd, "utf8")).toBe("first");
  });

  it.runIf(process.platform !== "win32").each(["source", "destination"] as const)("refuses a %s ancestor replaced by a real directory while preserving the leaf parent", async side => {
    const f = await fixture();
    using batch = createRootFileCopyBatchSync();
    using first = batch.copyFile(f.options("first"));
    const root = side === "source" ? f.sourceRoot : f.targetRoot;
    fs.renameSync(path.join(root, "a"), path.join(root, "saved"));
    fs.mkdirSync(path.join(root, "a"));
    fs.renameSync(path.join(root, "saved", "b"), path.join(root, "a", "b"));
    expect(() => batch.copyFile(f.options("second"))).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(fs.existsSync(f.options("second").destination.absolutePath)).toBe(false);
  });

  it.runIf(process.platform !== "win32").each(["source", "destination"] as const)("refuses a replaced %s root between files", async side => {
    const f = await fixture();
    using batch = createRootFileCopyBatchSync();
    using first = batch.copyFile(f.options("first"));
    const root = side === "source" ? f.sourceRoot : f.targetRoot;
    fs.renameSync(root, `${root}.saved`);
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    if (side === "source") fs.writeFileSync(f.options("second").source.absolutePath, "replacement");
    expect(() => batch.copyFile(f.options("second"))).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  });

  it.for(["hardlink", "symlink", "replacement", "oversize"])("does not cache source-file admission: %s", async (change, context) => {
    const f = await fixture();
    using batch = createRootFileCopyBatchSync();
    using first = batch.copyFile(f.options("first"));
    const options = f.options("second");
    const expectedSourceIdentity = fs.statSync(options.source.absolutePath, { bigint: true });
    const saved = `${options.source.absolutePath}.saved`;
    if (change === "hardlink") fs.linkSync(options.source.absolutePath, saved);
    if (change === "symlink" || change === "replacement") {
      fs.renameSync(options.source.absolutePath, saved);
      if (change === "symlink") await fileSymlinkOrSkip(saved, options.source.absolutePath, context);
      else fs.writeFileSync(options.source.absolutePath, "replacement");
    }
    if (change === "oversize") fs.appendFileSync(options.source.absolutePath, "growth");
    expect(() => batch.copyFile({ ...options, expectedSourceIdentity, maxBytes: 6 })).toThrow();
    expect(fs.existsSync(options.destination.absolutePath)).toBe(false);
  });

  it("retains exclusive creation for a collision in an already admitted parent", async () => {
    const f = await fixture();
    using batch = createRootFileCopyBatchSync();
    using first = batch.copyFile(f.options("first"));
    fs.writeFileSync(f.options("second").destination.absolutePath, "competitor");
    expect(() => batch.copyFile(f.options("second"))).toThrow(expect.objectContaining({ code: "already-exists" }));
    expect(fs.readFileSync(f.options("second").destination.absolutePath, "utf8")).toBe("competitor");
  });
});

it.each(["source", "destination"] as const)("detects a %s ancestor symlink swap during a warmed byte copy", async side => {
  configureFsSafeNative({ mode: "off" });
  const f = await fixture();
  using batch = createRootFileCopyBatchSync();
  using first = batch.copyFile(f.options("first"));
  const read = fs.readSync;
  let swapped = false;
  vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const result = Reflect.apply(read, fs, args);
    if (!swapped) {
      swapped = true;
      const root = side === "source" ? f.sourceRoot : f.targetRoot;
      fs.renameSync(path.join(root, "a"), path.join(root, "saved"));
      fs.symlinkSync(path.join(root, "saved"), path.join(root, "a"), process.platform === "win32" ? "junction" : "dir");
    }
    return result;
  });
  expect(() => batch.copyFile(f.options("second"))).toThrow();
  expect(swapped).toBe(true);
  expect(fs.readFileSync(f.options("second").source.absolutePath, "utf8")).toBe("second");
});

it.runIf(native && process.platform !== "win32").each(["source", "destination"] as const)("detects a %s ancestor swap after warmed native transfer", async side => {
  __setNativeLoaderForTest(() => native!);
  configureFsSafeNative({ mode: "require" });
  const f = await fixture();
  using batch = createRootFileCopyBatchSync();
  using first = batch.copyFile(f.options("first"));
  __setNativeLoaderForTest(() => ({ ...native!, copyFileExclusiveSync(...args) {
    const result = native!.copyFileExclusiveSync!(...args);
    const root = side === "source" ? f.sourceRoot : f.targetRoot;
    fs.renameSync(path.join(root, "a"), path.join(root, "saved"));
    fs.symlinkSync(path.join(root, "saved"), path.join(root, "a"), "dir");
    return result;
  } }));
  expect(() => batch.copyFile(f.options("second"))).toThrow();
  expect(fs.existsSync(f.options("second").destination.absolutePath)).toBe(false);
});

it.each(["source", "destination"] as const)("never admits raw parent traversal through a warmed %s cache", async side => {
  configureFsSafeNative({ mode: "off" });
  const f = await fixture();
  using batch = createRootFileCopyBatchSync();
  using first = batch.copyFile(f.options("first"));
  const options = f.options("second");
  options[side].absolutePath = `${options[side].rootPath}${path.sep}..${path.sep}outside`;
  expect(() => batch.copyFile(options)).toThrow();
  expect(fs.existsSync(f.options("second").destination.absolutePath)).toBe(false);
});

it.runIf(process.platform !== "win32").each(["source", "destination"] as const)("retains the first admitted %s parent identity while filling the cache", async side => {
  configureFsSafeNative({ mode: "off" });
  const f = await fixture();
  using batch = createRootFileCopyBatchSync();
  const options = f.options("first");
  const parent = path.dirname(options[side].absolutePath);
  const capture = directoryGuards.captureDirectoryGuard;
  let observations = 0;
  vi.spyOn(directoryGuards, "captureDirectoryGuard").mockImplementation((...args: Parameters<typeof capture>) => {
    if (args[0] === parent && ++observations === 2) {
      fs.renameSync(parent, `${parent}.saved`);
      fs.mkdirSync(parent);
      if (side === "source") fs.writeFileSync(options.source.absolutePath, "replacement");
    }
    return Reflect.apply(capture, directoryGuards, args);
  });
  expect(() => batch.copyFile(options)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(observations).toBe(2);
  expect(fs.existsSync(options.destination.absolutePath)).toBe(false);
});
