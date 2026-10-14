import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRootFileOpenBatchSync } from "../src/root-file-open-batch-sync.js";
import { openRootFileSync, type OpenRootFileSyncParams } from "../src/root-file.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { fileSymlinkOrSkip } from "./helpers/file-symlink.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { allowWindowsFilesystemStalls, useRealTempDirs } from "./helpers/vitest.js";

allowWindowsFilesystemStalls();
const { tempRoot } = useRealTempDirs();
const native = process.platform === "win32" ? loadTestNative("required-env") : undefined;
const itNativeWindows = it.runIf(Boolean(native));
beforeEach(() => { if (native) __setNativeLoaderForTest(() => native); });
afterEach(() => { vi.restoreAllMocks(); __resetNativeLoaderForTest(); });

async function fixture() {
  const rootPath = path.join(await tempRoot("fs-safe-open-batch-"), "root");
  const parent = path.join(rootPath, "a", "b", "c", "d");
  fs.mkdirSync(parent, { recursive: true });
  for (const name of ["first", "second"]) fs.writeFileSync(path.join(parent, name), name);
  const options = (name: string): OpenRootFileSyncParams => ({
    rootPath, absolutePath: path.join(parent, name), boundaryLabel: "batch fixture",
  });
  return { rootPath, parent, options };
}

function readAndClose(result: ReturnType<typeof openRootFileSync>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  try { return fs.readFileSync(result.fd, "utf8"); }
  finally { fs.closeSync(result.fd); }
}

it("transfers independent descriptors and closes only retained roots", async () => {
  const f = await fixture();
  const batch = createRootFileOpenBatchSync();
  const first = batch.openFile(f.options("first"));
  const second = batch.openFile(f.options("second"));
  batch.close();
  batch[Symbol.dispose]();
  expect(readAndClose(first)).toBe("first");
  expect(readAndClose(second)).toBe("second");
  expect(batch.openFile(f.options("first"))).toMatchObject({ ok: false, reason: "validation", error: { code: "invalid-path" } });
});

itNativeWindows("rejects a replaced root between files", async () => {
  const f = await fixture();
  using batch = createRootFileOpenBatchSync();
  readAndClose(batch.openFile(f.options("first")));
  fs.renameSync(f.rootPath, `${f.rootPath}.saved`);
  fs.mkdirSync(f.parent, { recursive: true });
  fs.writeFileSync(f.options("second").absolutePath, "replacement");
  expect(batch.openFile(f.options("second"))).toMatchObject({ ok: false, reason: "validation", error: { code: "path-mismatch" } });
});

itNativeWindows("rejects a cached ancestor replaced by a junction to the original tree", async () => {
  const f = await fixture();
  using batch = createRootFileOpenBatchSync();
  readAndClose(batch.openFile(f.options("first")));
  const ancestor = path.join(f.rootPath, "a");
  fs.renameSync(ancestor, `${ancestor}.saved`);
  fs.symlinkSync(`${ancestor}.saved`, ancestor, "junction");
  const lstat = vi.spyOn(fs, "lstatSync");
  expect(batch.openFile(f.options("second"))).toMatchObject({ ok: false, reason: "validation", error: { code: "symlink" } });
  // A real UNC target could initiate network authentication during this observation.
  expect(lstat.mock.calls.some(([name]) => String(name).endsWith(`${path.sep}second`))).toBe(false);
});

it.each(["rootPath", "absolutePath"] as const)("preserves validation classification for invalid %s inputs", async field => {
  const f = await fixture();
  using batch = createRootFileOpenBatchSync();
  const options = { ...f.options("first"), [field]: 42 } as unknown as OpenRootFileSyncParams;
  const ordinary = openRootFileSync(options);
  const batched = batch.openFile(options);
  expect(batched.ok).toBe(false);
  expect(ordinary.ok).toBe(false);
  if (ordinary.ok || batched.ok) throw new Error("invalid fixture was accepted");
  expect(batched.reason).toBe(ordinary.reason);
});

it.for(["symlink", "hardlink", "oversize"])("checks each file after warming its root: %s", async (change, context) => {
  const f = await fixture();
  using batch = createRootFileOpenBatchSync();
  readAndClose(batch.openFile(f.options("first")));
  const options = f.options("second");
  const saved = `${options.absolutePath}.saved`;
  if (change === "symlink") {
    fs.renameSync(options.absolutePath, saved);
    await fileSymlinkOrSkip(saved, options.absolutePath, context);
  } else if (change === "hardlink") fs.linkSync(options.absolutePath, saved);
  else fs.appendFileSync(options.absolutePath, "growth");
  expect(batch.openFile({ ...options, maxBytes: 6 })).toMatchObject({ ok: false, reason: "validation", error: { code: change === "oversize" ? "too-large" : change } });
});

it("retains allowed hardlinks and exact descriptor identities", async () => {
  const f = await fixture();
  fs.linkSync(f.options("first").absolutePath, f.options("alias").absolutePath);
  using batch = createRootFileOpenBatchSync();
  const opened = batch.openFile({ ...f.options("first"), rejectHardlinks: false });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  const stat = fs.fstatSync(opened.fd, { bigint: true });
  expect(opened.exactIdentity).toEqual({ dev: stat.dev, ino: stat.ino });
  expect(readAndClose(opened)).toBe("first");
});

itNativeWindows("rejects a leaf swap after native open and closes its descriptor", async () => {
  const f = await fixture();
  using batch = createRootFileOpenBatchSync();
  readAndClose(batch.openFile(f.options("first")));
  let descriptor: number | undefined;
  __setNativeLoaderForTest(() => ({ ...native!, openBeneath(...args) {
    const result = native!.openBeneath!(...args);
    descriptor = result.fd;
    fs.renameSync(f.options("second").absolutePath, `${f.options("second").absolutePath}.saved`);
    fs.writeFileSync(f.options("second").absolutePath, "replacement");
    return result;
  } }));
  expect(batch.openFile(f.options("second"))).toMatchObject({ ok: false, reason: "validation", error: { code: "path-mismatch" } });
  expect(descriptor).toBeDefined();
  expect(() => fs.fstatSync(descriptor!)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

it("never rounds a descriptor identity when checking the opened leaf", async () => {
  const f = await fixture();
  using batch = createRootFileOpenBatchSync();
  readAndClose(batch.openFile(f.options("first")));
  const fstat = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
    const stat = Reflect.apply(fstat, fs, args);
    return args[1]?.bigint ? Object.assign(Object.create(stat), { ino: BigInt(stat.ino) + (1n << 64n) }) : stat;
  }) as typeof fs.fstatSync);
  expect(batch.openFile(f.options("second"))).toMatchObject({ ok: false, reason: "validation", error: { code: "path-mismatch" } });
});

it("preserves contained symlink opt-in and raw traversal rejection", async context => {
  const f = await fixture();
  const alias = f.options("alias").absolutePath;
  await fileSymlinkOrSkip(f.options("first").absolutePath, alias, context);
  using batch = createRootFileOpenBatchSync();
  expect(readAndClose(batch.openFile({ ...f.options("alias"), symlinks: "follow-within-root" }))).toBe("first");
  expect(batch.openFile({ ...f.options("first"), absolutePath: `${f.rootPath}${path.sep}..${path.sep}outside` }).ok).toBe(false);
  expect(batch.openFile(f.options("missing"))).toMatchObject({ ok: false, reason: "path" });
});

itNativeWindows("reuses native root admission without skipping file checks", async () => {
  const f = await fixture();
  const lstat = vi.spyOn(fs, "lstatSync");
  const count = (run: () => void) => { lstat.mockClear(); run(); return lstat.mock.calls.length; };
  const single = count(() => readAndClose(openRootFileSync(f.options("second"))));
  using batch = createRootFileOpenBatchSync();
  readAndClose(batch.openFile(f.options("first")));
  const repeated = count(() => readAndClose(batch.openFile(f.options("second"))));
  expect(repeated).toBeLessThan(single);
  expect(lstat.mock.calls.some(([name]) => String(name) === f.options("second").absolutePath)).toBe(true);
});
