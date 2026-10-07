import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyRootFileSync, openRootFileSync, type CopyRootFileSyncOptions } from "../src/advanced.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import * as creation from "../src/create.js";
import { probeTreeClone, readCloneFileMetadata } from "../src/copy.js";
import { fileSymlinkOrSkip } from "./helpers/file-symlink.js";

const { tempRoot } = useRealTempDirs();
const native = loadTestNative("required-env");
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});
async function fixture(content: string | Buffer = "captured bytes", base?: string) {
  const directory = base ?? await tempRoot("fs-safe-sync-copy-");
  const sourceRoot = path.join(directory, "source");
  const targetRoot = path.join(directory, "target");
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.mkdirSync(targetRoot, { mode: 0o700 });
  const source = path.join(sourceRoot, "input");
  const target = path.join(targetRoot, "output");
  fs.writeFileSync(source, content);
  const options: CopyRootFileSyncOptions = {
    source: { rootPath: sourceRoot, absolutePath: source },
    destination: { rootPath: targetRoot, absolutePath: target },
  };
  return { directory, sourceRoot, targetRoot, source, target, options, content };
}
function enableNative() {
  __setNativeLoaderForTest(() => native!);
  configureFsSafeNative({ mode: "require" });
}
function sourceIdentity(fd: number) {
  const { dev, ino } = fs.fstatSync(fd, { bigint: true });
  return { dev, ino };
}

describe.each([false, true])("expected source identity (native=%s)", useNative => {
  beforeEach(context => {
    if (useNative && !native) context.skip("Native binding unavailable");
    if (useNative) enableNative();
  });
  it("copies the caller-pinned source without taking ownership or moving its cursor", async () => {
    const f = await fixture();
    const opened = openRootFileSync({ ...f.options.source, boundaryLabel: "caller source" });
    if (!opened.ok) throw opened.error;
    try {
      const expectedSourceIdentity = sourceIdentity(opened.fd);
      const byte = Buffer.alloc(1);
      fs.readSync(opened.fd, byte, 0, 1, null);
      using copied = copyRootFileSync({ ...f.options, expectedSourceIdentity, clone: "auto" });
      expect(copied.sourceIdentity).toEqual(expectedSourceIdentity);
      expect(Object.isFrozen(copied.sourceIdentity)).toBe(true);
      expect(copied.identity).not.toEqual(copied.sourceIdentity);
      expect(fs.readFileSync(copied.fd, "utf8")).toBe(f.content);
      expect(sourceIdentity(opened.fd)).toEqual(expectedSourceIdentity);
      fs.readSync(opened.fd, byte, 0, 1, null);
      expect(byte.toString()).toBe(f.content[1]);
    } finally { fs.closeSync(opened.fd); }
  });
  it("refuses a source replaced after the caller's pin before creating a destination", async () => {
    const f = await fixture();
    const opened = openRootFileSync({ ...f.options.source, boundaryLabel: "caller source" });
    if (!opened.ok) throw opened.error;
    try {
      const expectedSourceIdentity = sourceIdentity(opened.fd);
      fs.renameSync(f.source, `${f.source}.old`);
      fs.writeFileSync(f.source, "replacement");
      const create = vi.spyOn(creation, "createFileWithAdmissionSync");
      const transfer = vi.fn();
      if (useNative) __setNativeLoaderForTest(() => ({ ...native!, copyFileExclusiveSync: transfer }));
      expect(() => copyRootFileSync({ ...f.options, expectedSourceIdentity, clone: "auto" }))
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(create).not.toHaveBeenCalled();
      expect(transfer).not.toHaveBeenCalled();
      expect(fs.readdirSync(f.targetRoot)).toEqual([]);
      expect(fs.readFileSync(opened.fd, "utf8")).toBe(f.content);
      expect(fs.readFileSync(f.source, "utf8")).toBe("replacement");
    } finally { fs.closeSync(opened.fd); }
  });
  it.each(["dev", "ino"] as const)("rejects an expected %s mismatch", async field => {
    const f = await fixture();
    const { dev, ino } = fs.statSync(f.source, { bigint: true });
    const expectedSourceIdentity = { dev, ino };
    expectedSourceIdentity[field] += 1n;
    expect(() => copyRootFileSync({ ...f.options, expectedSourceIdentity }))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(fs.readdirSync(f.targetRoot)).toEqual([]);
  });
});

it.each(["never", "auto"] as const)("copies bytes with native off and clone=%s, returning the owned destination", async clone => {
  const f = await fixture(Buffer.alloc(512 * 1024 + 17, 0x5a));
  const copied = copyRootFileSync({ ...f.options, clone });
  expect(copied.method).toBe("copy");
  expect(copied.bytes).toBe(f.content.length);
  expect(copied.path).toBe(f.target);
  expect(copied.identity).toEqual(expect.objectContaining({ dev: expect.any(BigInt), ino: expect.any(BigInt) }));
  expect(fs.fstatSync(copied.fd, { bigint: true })).toMatchObject(copied.identity);
  expect(fs.statSync(f.source, { bigint: true })).toMatchObject(copied.sourceIdentity);
  expect(Object.keys(copied.sourceIdentity).sort()).toEqual(["dev", "ino"]);
  expect(fs.readFileSync(copied.fd).equals(Buffer.from(f.content))).toBe(true);
  fs.writeSync(copied.fd, Buffer.from("independent"), 0, 11, 0);
  expect(fs.readFileSync(f.source).equals(Buffer.from(f.content))).toBe(true);
  copied[Symbol.dispose]();
  copied.close();
  expect(() => fs.fstatSync(copied.fd)).toThrow();
  expect(fs.existsSync(f.target)).toBe(true);
});

it("refuses mandatory cloning without the native capability", async () => {
  const f = await fixture();
  expect(() => copyRootFileSync({ ...f.options, clone: "always" })).toThrow(expect.objectContaining({ code: "unsupported-platform" }));
  expect(fs.readdirSync(f.targetRoot)).toEqual([]);
});

it.each([0, 4, 13])("enforces maxBytes=%s without retaining an over-budget destination", async maxBytes => {
  const f = await fixture("fourteen bytes");
  expect(() => copyRootFileSync({ ...f.options, maxBytes })).toThrow(expect.objectContaining({ code: "too-large" }));
  expect(fs.readdirSync(f.targetRoot)).toEqual([]);
});
it("accepts an empty source with a zero budget", async () => {
  const f = await fixture("");
  using copied = copyRootFileSync({ ...f.options, maxBytes: 0 });
  expect(copied.bytes).toBe(0);
});
it.each([-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid budgets before creation: %s", async maxBytes => {
  const f = await fixture();
  expect(() => copyRootFileSync({ ...f.options, maxBytes })).toThrow(RangeError);
  expect(fs.existsSync(f.target)).toBe(false);
});

it.for(["file", "directory", "dangling-link"])("refuses a pre-existing %s", async (kind, context) => {
  const f = await fixture();
  const absent = path.join(f.targetRoot, "absent");
  if (kind === "directory") fs.mkdirSync(f.target);
  else if (kind === "dangling-link") {
    await fileSymlinkOrSkip(absent, f.target, context);
  } else fs.writeFileSync(f.target, "existing");
  expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "already-exists" }));
  expect(fs.existsSync(absent)).toBe(false);
  if (kind === "file") expect(fs.readFileSync(f.target, "utf8")).toBe("existing");
});

it("rejects source hardlinks unless explicitly admitted", async () => {
  const f = await fixture();
  fs.linkSync(f.source, path.join(f.sourceRoot, "alias"));
  expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "hardlink" }));
  using copied = copyRootFileSync({ ...f.options, sourceHardlinks: "allow" });
  expect(fs.readFileSync(copied.fd, "utf8")).toBe(f.content);
});

it.each(["source", "destination"] as const)("rejects an escaping %s route", async side => {
  const f = await fixture();
  f.options[side].absolutePath = `${f.options[side].rootPath}${path.sep}..${path.sep}escape`;
  expect(() => copyRootFileSync(f.options)).toThrow();
  expect(fs.readdirSync(f.targetRoot)).toEqual([]);
});

it("refuses a source swap during a byte copy and cleans its destination", async () => {
  const f = await fixture();
  const read = fs.readSync;
  let swapped = false;
  vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const result = Reflect.apply(read, fs, args);
    if (!swapped) {
      swapped = true;
      fs.renameSync(f.source, `${f.source}.old`);
      fs.writeFileSync(f.source, "replacement");
    }
    return result;
  });
  expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(fs.readdirSync(f.targetRoot)).toEqual([]);
  expect(fs.readFileSync(f.source, "utf8")).toBe("replacement");
});

it("bounds growth after admission and does not write the overflow byte", async () => {
  const f = await fixture("original");
  const read = fs.readSync;
  let grew = false;
  vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const result = Reflect.apply(read, fs, args);
    if (!grew) { grew = true; fs.appendFileSync(f.source, "growth"); }
    return result;
  });
  expect(() => copyRootFileSync({ ...f.options, maxBytes: 8 })).toThrow(expect.objectContaining({ code: "too-large" }));
  expect(fs.existsSync(f.target)).toBe(false);
});

it("preserves a destination replacement when source verification fails", async () => {
  const f = await fixture();
  const write = fs.writeSync;
  let replaced = false;
  vi.spyOn(fs, "writeSync").mockImplementation((...args: Parameters<typeof fs.writeSync>) => {
    const result = Reflect.apply(write, fs, args);
    if (!replaced) {
      replaced = true;
      fs.renameSync(f.target, `${f.target}.owned`);
      fs.writeFileSync(f.target, "replacement destination");
      fs.renameSync(f.source, `${f.source}.old`);
      fs.writeFileSync(f.source, "replacement source");
    }
    return result;
  });
  expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(fs.readFileSync(f.target, "utf8")).toBe("replacement destination");
});

it.for(["source", "destination"] as const)("rejects a symlinked %s parent", async (side, context) => {
  const f = await fixture();
  const rootPath = f.options[side].rootPath;
  fs.mkdirSync(path.join(rootPath, "real"));
  try { fs.symlinkSync(path.join(rootPath, "real"), path.join(rootPath, "link"), process.platform === "win32" ? "junction" : "dir"); }
  catch { context.skip("Directory links unavailable"); }
  f.options[side].absolutePath = path.join(rootPath, "link", "file");
  expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "symlink" }));
  expect(fs.readdirSync(path.join(rootPath, "real"))).toEqual([]);
});

it("binds portable creation to its admitted parent before copying source bytes", async () => {
  const f = await fixture();
  const outside = path.join(f.directory, "outside");
  for (const directory of [f.targetRoot, outside]) fs.mkdirSync(path.join(directory, "nested"), { recursive: true });
  f.options.destination.absolutePath = path.join(f.targetRoot, "nested", "output");
  const create = creation.createFileWithAdmissionSync;
  vi.spyOn(creation, "createFileWithAdmissionSync").mockImplementation((target, options, admission) => {
    expect(admission?.expectedParentIdentity).toMatchObject({ dev: expect.any(BigInt), ino: expect.any(BigInt) });
    fs.renameSync(f.targetRoot, `${f.targetRoot}.old`);
    fs.symlinkSync(outside, f.targetRoot, process.platform === "win32" ? "junction" : "dir");
    return create(target, options, admission);
  });
  expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(fs.readdirSync(path.join(outside, "nested"))).toEqual([]);
});

it.each(["off", "auto"] as const)("rejects a destination hardlink added during mode finalization (%s)", async mode => {
  configureFsSafeNative({ mode });
  const f = await fixture();
  const chmod = fs.fchmodSync;
  vi.spyOn(fs, "fchmodSync").mockImplementation((fd, selected) => {
    chmod(fd, selected);
    fs.linkSync(f.target, path.join(f.targetRoot, "alias"));
  });
  expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(fs.existsSync(f.target)).toBe(false);
  expect(fs.readFileSync(path.join(f.targetRoot, "alias"), "utf8")).toBe(f.content);
});

it("refuses a destination swap during mode finalization", async () => {
  const f = await fixture();
  const chmod = fs.fchmodSync;
  vi.spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
    chmod(fd, mode);
    fs.renameSync(f.target, `${f.target}.owned`);
    fs.writeFileSync(f.target, "replacement");
  });
  expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(fs.readFileSync(f.target, "utf8")).toBe("replacement");
});

it.runIf(process.platform !== "win32").each([
  { mode: undefined, preserveSourceMode: false, expected: 0o600 & ~process.umask() },
  { mode: undefined, preserveSourceMode: true, expected: 0o751 },
  { mode: 0o640, preserveSourceMode: true, expected: 0o640 },
  { mode: 0, preserveSourceMode: false, expected: 0 },
])("selects the copy mode: $expected", async ({ mode, preserveSourceMode, expected }) => {
  const f = await fixture();
  fs.chmodSync(f.source, 0o751);
  using copied = copyRootFileSync({ ...f.options, mode, preserveSourceMode });
  expect(fs.fstatSync(copied.fd).mode & 0o777).toBe(expected);
});

describe.runIf(native)("native synchronous copying", () => {
  it.for(["auto", "never", "always"] as const)("copies with clone=%s through a readable/writable descriptor", async (clone, context) => {
    enableNative();
    const f = await fixture(Buffer.alloc(128 * 1024 + 1, 0x31));
    if (clone === "always" && (process.platform === "win32" || !probeTreeClone(f.targetRoot))) {
      context.skip("Synchronous cloning is unavailable on this host");
    }
    if (process.platform !== "win32") expect(native!.copyFileExclusiveSync).toBeTypeOf("function");
    using copied = copyRootFileSync({ ...f.options, clone, maxBytes: f.content.length });
    expect(fs.readFileSync(copied.fd).equals(Buffer.from(f.content))).toBe(true);
    expect(fs.writeSync(copied.fd, Buffer.from("independent"), 0, 11, 0)).toBe(11);
    expect(fs.readFileSync(f.source).equals(Buffer.from(f.content))).toBe(true);
    expect(copied.bytes).toBe(f.content.length);
    expect(fs.statSync(f.source, { bigint: true })).toMatchObject(copied.sourceIdentity);
    if (clone === "never" || process.platform === "win32") expect(copied.method).toBe("copy");
    if (clone === "always") expect(copied.method).toBe("clone");
  });
  it.runIf(process.platform !== "win32").for([0o400, 0o444])("clones a read-only source with mode %s without restricting its owned descriptor", async (mode, context) => {
    enableNative();
    const f = await fixture();
    if (!probeTreeClone(f.targetRoot)) context.skip("Host filesystem cannot clone files");
    fs.chmodSync(f.source, mode);
    using copied = copyRootFileSync({ ...f.options, clone: "always", preserveSourceMode: true });
    expect(copied.method).toBe("clone");
    expect(fs.readFileSync(copied.fd, "utf8")).toBe(f.content);
    expect(fs.writeSync(copied.fd, Buffer.from("independent"), 0, 11, 0)).toBe(11);
    expect(fs.fstatSync(copied.fd).mode & 0o777).toBe(mode);
    expect(fs.statSync(f.source).mode & 0o777).toBe(mode);
    expect(fs.readFileSync(f.source, "utf8")).toBe(f.content);
  });
  it.each(["auto", "never", "always"] as const)("enforces the native size limit with clone=%s", async clone => {
    enableNative();
    const f = await fixture();
    expect(() => copyRootFileSync({ ...f.options, clone, maxBytes: 1 })).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(fs.readdirSync(f.targetRoot)).toEqual([]);
  });
  it.runIf(process.platform !== "win32")("refuses a source swap after native transfer and removes only its copy", async () => {
    enableNative();
    const f = await fixture();
    __setNativeLoaderForTest(() => ({ ...native!, copyFileExclusiveSync(...args) {
      const result = native!.copyFileExclusiveSync!(...args);
      fs.renameSync(f.source, `${f.source}.old`);
      fs.writeFileSync(f.source, "replacement");
      return result;
    } }));
    expect(() => copyRootFileSync({ ...f.options, clone: "auto" })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(fs.readdirSync(f.targetRoot)).toEqual([]);
  });
  it.runIf(process.platform !== "win32").each(["EIO", "EACCES", "EPERM"])("does not fall back on a native %s outside the clone classifier", async code => {
    enableNative();
    const f = await fixture();
    __setNativeLoaderForTest(() => ({ ...native!, copyFileExclusiveSync() {
      throw Object.assign(new Error("copy failed"), { code });
    } }));
    expect(() => copyRootFileSync({ ...f.options, clone: "auto" })).toThrow(expect.objectContaining({ code: "helper-failed" }));
    expect(fs.readdirSync(f.targetRoot)).toEqual([]);
  });
  it.runIf(process.platform !== "win32")("cleans an owned native descriptor when bounded transfer reports an error", async () => {
    enableNative();
    const f = await fixture();
    let fd: number | undefined;
    __setNativeLoaderForTest(() => ({ ...native!, copyFileExclusiveSync(...args) {
      const result = native!.copyFileExclusiveSync!(...args);
      fd = result.fd;
      return { ...result, errorCode: "too-large", errorMessage: "grew during copy" };
    } }));
    expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(fs.readdirSync(f.targetRoot)).toEqual([]);
    expect(() => fs.fstatSync(fd!)).toThrow();
  });
  it.runIf(process.platform === "darwin")("clones on APFS and shares the data-stream identity", async () => {
    enableNative();
    const f = await fixture(Buffer.alloc(4 * 1024 * 1024, 0x4a));
    expect(probeTreeClone(f.targetRoot)).toBe("apfs");
    using copied = copyRootFileSync({ ...f.options, clone: "always" });
    expect(copied.method).toBe("clone");
    expect(fs.statSync(f.source, { bigint: true })).toMatchObject(copied.sourceIdentity);
    expect(fs.readFileSync(copied.fd).equals(Buffer.from(f.content))).toBe(true);
    const [source, target] = await readCloneFileMetadata([f.source, f.target]);
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    expect(target!.cloneId).toBe(source!.cloneId);
  }, 30_000);
  it.runIf(process.platform === "linux")("uses copy_file_range on tmpfs after FICLONE is unavailable", async () => {
    enableNative();
    const directory = fs.mkdtempSync("/dev/shm/fs-safe-sync-copy-");
    try {
      const f = await fixture(Buffer.alloc(65537, 0x42), directory);
      using copied = copyRootFileSync({ ...f.options, clone: "auto", maxBytes: f.content.length });
      expect(copied.method).toBe("copy-file-range");
      expect(fs.statSync(f.source, { bigint: true })).toMatchObject(copied.sourceIdentity);
      expect(fs.readFileSync(copied.fd).equals(Buffer.from(f.content))).toBe(true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
