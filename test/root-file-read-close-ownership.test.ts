import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { captureNativeFdClose } from "../src/native-binding.js";
import { observeCanonicalRoot } from "../src/root-file-final-admission.js";
import { createRootFileOpenBatchSync } from "../src/root-file-open-batch-sync.js";
import { openRootFileWithRetainedRootSync } from "../src/root-file.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

async function fixture() {
  const rootPath = await tempRoot("fs-safe-read-owner-");
  const absolutePath = path.join(rootPath, "source");
  fs.writeFileSync(absolutePath, "source bytes");
  const observation = observeCanonicalRoot(fs, rootPath);
  if (!observation.ok) throw observation.error;
  return { params: { rootPath, absolutePath, boundaryLabel: "read ownership" }, observation };
}

it("native-opener fake transfers its captured closer through root admission", async () => {
  const { params, observation } = await fixture();
  const realClose = fs.closeSync.bind(fs);
  const originalClose = vi.fn(realClose);
  const binding = { closeOwnedFd(fd: number) { expect(this).toBe(binding); originalClose(fd); } };
  const closeFd = captureNativeFdClose(binding);
  // Node supplies the fake's descriptor; this proves routing, not native bookkeeping.
  const fd = fs.openSync(params.absolutePath, "r");
  const nodeClose = vi.spyOn(fs, "closeSync");
  const replacementClose = vi.fn();
  binding.closeOwnedFd = replacementClose;
  configureFsSafeNative({ mode: "off" });
  try {
    const opened = openRootFileWithRetainedRootSync(params, observation, fd, closeFd);
    expect(opened.ok).toBe(true);
    if (!opened.ok || !opened.close) throw new Error("native read did not transfer its closer");
    expect(fs.readFileSync(opened.fd, "utf8")).toBe("source bytes");
    expect(originalClose).not.toHaveBeenCalled();
    opened.close();
    opened.close();
    expect(originalClose).toHaveBeenCalledExactlyOnceWith(fd);
    expect(nodeClose).not.toHaveBeenCalled();
    expect(replacementClose).not.toHaveBeenCalled();
    expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  } finally {
    if (!originalClose.mock.calls.length) { try { realClose(fd); } catch { /* Base may already close it. */ } }
  }
});

it.each([new Error("close failed"), undefined])("native-opener fake preserves rejection when its closer throws %s", async failure => {
  const { params, observation } = await fixture();
  const realClose = fs.closeSync.bind(fs);
  const nativeClose = vi.fn((fd: number) => { realClose(fd); throw failure; });
  const closeFd = captureNativeFdClose({ closeOwnedFd: nativeClose });
  const fd = fs.openSync(params.absolutePath, "r");
  const nodeClose = vi.spyOn(fs, "closeSync");
  configureFsSafeNative({ mode: "off" });
  const opened = openRootFileWithRetainedRootSync({ ...params, maxBytes: 0 }, observation, fd, closeFd);
  expect(opened).toMatchObject({ ok: false, reason: "validation", error: { code: "too-large" } });
  expect(nativeClose).toHaveBeenCalledExactlyOnceWith(fd);
  expect(nodeClose).not.toHaveBeenCalled();
  expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

it("Node fallback retains Node-owned success and rejected-admission cleanup", async () => {
  const { params } = await fixture();
  const openSync = vi.fn(fs.openSync);
  const closeSync = vi.fn(fs.closeSync);
  using batch = createRootFileOpenBatchSync();
  const options = { ...params, ioFs: { ...fs, openSync, closeSync } };
  const opened = batch.openFile(options);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  try {
    expect(opened).not.toHaveProperty("close");
    expect(closeSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(opened.fd, "utf8")).toBe("source bytes");
  } finally { closeSync(opened.fd); }
  expect(closeSync).toHaveBeenCalledExactlyOnceWith(opened.fd);
  closeSync.mockClear();
  const error = Object.assign(new Error("Node descriptor inspection failed"), { code: "EIO" });
  const rejected = batch.openFile({ ...options, ioFs: {
    ...options.ioFs, fstatSync() { throw error; },
  } });
  expect(rejected).toEqual({ ok: false, reason: "io", error });
  expect(openSync).toHaveBeenCalledTimes(2);
  const rejectedFd = openSync.mock.results[1]!.value;
  expect(closeSync).toHaveBeenCalledExactlyOnceWith(rejectedFd);
  expect(() => fs.fstatSync(rejectedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
});
