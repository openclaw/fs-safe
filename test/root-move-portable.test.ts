import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeFallbackWarningsForTest } from "../src/native-fallback-warning.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
  __resetNativeFallbackWarningsForTest();
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __resetNativeFallbackWarningsForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-portable-move-");
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  await fs.writeFile(source, "source", { mode: 0o640 });
  return { directory, source, target, scoped: await root(directory) };
}

it.each(["off", "missing"])("moves the original inode in %s mode, warning once without paths", async mode => {
  const { directory, source, target, scoped } = await fixture();
  const loader = vi.fn(() => { throw new Error("native package missing"); });
  __setNativeLoaderForTest(loader);
  configureFsSafeNative({ mode: mode === "off" ? "off" : "auto" });
  const original = await fs.stat(source, { bigint: true });
  const copy = vi.spyOn(fsSync, "copyFileSync");
  const rename = vi.spyOn(fsSync, "renameSync");
  await scoped.move("source", "target");
  await scoped.move("target", "finished");
  const moved = await fs.stat(path.join(directory, "finished"), { bigint: true });
  expect(moved.dev).toBe(original.dev);
  expect(moved.ino).toBe(original.ino);
  expect(moved.mode).toBe(original.mode);
  expect(moved.nlink).toBe(1n);
  expect(await fs.readFile(path.join(directory, "finished"), "utf8")).toBe("source");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(copy).not.toHaveBeenCalled();
  if (process.platform === "win32") expect(rename).not.toHaveBeenCalled();
  else {
    expect(rename).toHaveBeenCalledTimes(2);
    expect(rename.mock.calls.map(([from]) => String(from))).toEqual([source, target]);
    expect(rename.mock.calls.every(([, to]) => path.basename(path.dirname(String(to))).startsWith(".fs-safe-move-"))).toBe(true);
  }
  expect(loader).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
  expect(process.emitWarning).toHaveBeenCalledOnce();
  expect(process.emitWarning).toHaveBeenCalledWith(expect.not.stringContaining(directory), {
    code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning",
  });
});

it("keeps require mode's explicit native loading requirement", async () => {
  const { source, target, scoped } = await fixture();
  __setNativeLoaderForTest(() => { throw new Error("native package missing"); });
  configureFsSafeNative({ mode: "require" });
  await expect(scoped.move("source", "target")).rejects.toMatchObject({ code: "helper-unavailable" });
  expect(await fs.readFile(source, "utf8")).toBe("source");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses the portable path when a loaded binding lacks no-replace rename", async () => {
  const { source, target, scoped } = await fixture();
  const open = vi.fn();
  __setNativeLoaderForTest(() => ({ openBeneath: open, closeOwnedFd: vi.fn() }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  await scoped.move("source", "target");
  expect(open).not.toHaveBeenCalled();
  expect(await fs.readFile(target, "utf8")).toBe("source");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([0o200, 0o400, 0o600, 0o644])("preserves the original mode %i across portable publication", async mode => {
  const { source, target, scoped } = await fixture();
  await fs.chmod(source, mode);
  const before = await fs.stat(source);
  await scoped.move("source", "target");
  expect((await fs.stat(target)).mode).toBe(before.mode);
  if (mode === 0o200) await fs.chmod(target, 0o600);
  expect(await fs.readFile(target, "utf8")).toBe("source");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it("atomically refuses a competitor created at link dispatch", async () => {
  const { source, target, scoped } = await fixture();
  const link = fsSync.linkSync.bind(fsSync);
  vi.spyOn(fsSync, "linkSync").mockImplementation((from, to) => {
    fsSync.writeFileSync(target, "competitor", { flag: "wx" });
    link(from, to);
  });
  const unlink = vi.spyOn(fsSync, "unlinkSync");
  await expect(scoped.move("source", "target")).rejects.toMatchObject({ code: "already-exists" });
  expect(await fs.readFile(source, "utf8")).toBe("source");
  expect(await fs.readFile(target, "utf8")).toBe("competitor");
  expect(unlink).not.toHaveBeenCalled();
});

it.each([1, 2])("reauthorizes before mutation %s and retains every published name on expiry", async phase => {
  const { source, target, scoped } = await fixture();
  const expired = new Error("expired");
  let calls = 0;
  const unlink = vi.spyOn(fsSync, "unlinkSync");
  await expect(scoped.move("source", "target", {
    assertBeforeMutation: () => { if (++calls === phase) throw expired; },
  })).rejects.toBe(expired);
  expect(await fs.readFile(source, "utf8")).toBe("source");
  if (phase === 1) await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  else expect(await fs.readFile(target, "utf8")).toBe("source");
  expect(calls).toBe(phase);
  expect(unlink).not.toHaveBeenCalled();
});

it.each([1, 2])("rejects source replacement before mutation %s without deleting either inode", async phase => {
  const { directory, source, target, scoped } = await fixture();
  const retired = path.join(directory, "retired");
  let calls = 0;
  await expect(scoped.move("source", "target", {
    assertBeforeMutation: () => {
      if (++calls !== phase) return;
      fsSync.renameSync(source, retired);
      fsSync.writeFileSync(source, "replacement");
    },
  })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(await fs.readFile(source, "utf8")).toBe("replacement");
  expect(await fs.readFile(retired, "utf8")).toBe("source");
  if (phase === 1) await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  else expect(await fs.readFile(target, "utf8")).toBe("source");
});

it("rejects replacement of the published target before retiring the source", async () => {
  const { directory, source, target, scoped } = await fixture();
  const retired = path.join(directory, "retired");
  let calls = 0;
  await expect(scoped.move("source", "target", {
    assertBeforeMutation: () => {
      if (++calls !== 2) return;
      fsSync.renameSync(target, retired);
      fsSync.writeFileSync(target, "competitor");
    },
  })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(await fs.readFile(source, "utf8")).toBe("source");
  expect(await fs.readFile(target, "utf8")).toBe("competitor");
  expect(await fs.readFile(retired, "utf8")).toBe("source");
});

it("retains the source inode across an awaited mutation hook", async () => {
  const { directory, source, target, scoped } = await fixture();
  const retired = path.join(directory, "retired");
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation: async () => {
      await fs.rename(source, retired);
      await fs.writeFile(source, "replacement");
    },
  });
  const link = vi.spyOn(fsSync, "linkSync");
  await expect(scoped.move("source", "target")).rejects.toMatchObject({ code: "path-mismatch" });
  expect(link).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("replacement");
  expect(await fs.readFile(retired, "utf8")).toBe("source");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32")("never removes its destination after the captured source has disappeared", async () => {
  const { source, target, scoped } = await fixture();
  const failure = Object.assign(new Error("unlink response lost"), { code: "EIO" });
  const unlink = fsSync.unlinkSync.bind(fsSync);
  const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation(from => { unlink(from); throw failure; });
  await expect(scoped.move("source", "target")).rejects.toMatchObject({
    code: "helper-failed", cause: failure, details: { sourceRecovery: { status: "indeterminate" } },
  });
  expect(unlinkSpy).toHaveBeenCalledOnce();
  expect(await fs.readFile(target, "utf8")).toBe("source");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32")("preserves both links if private source unlink fails and closes each retained descriptor once", async () => {
  const { source, target, scoped } = await fixture();
  const failure = Object.assign(new Error("unlink failed"), { code: "EIO" });
  vi.spyOn(fsSync, "unlinkSync").mockImplementation(() => { throw failure; });
  const close = vi.spyOn(fsSync, "closeSync");
  const error = await scoped.move("source", "target").catch(error => error);
  expect(error).toMatchObject({ code: "helper-failed", cause: failure, details: { sourceRecovery: { status: "indeterminate" } } });
  expect(error.details).not.toHaveProperty("sourceConsumed");
  const recovery = error.details.sourceRecovery.path;
  expect(await fs.readFile(recovery, "utf8")).toBe("source");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(target, "utf8")).toBe("source");
  expect((await fs.stat(recovery)).nlink).toBe(2);
  expect(close).toHaveBeenCalledTimes(2);
  expect(new Set(close.mock.calls.map(([fd]) => fd)).size).toBe(2);
});

it.skipIf(process.platform === "win32")("retains the published inode and both failure causes when private unlink and source close fail", async () => {
  const { source, target, scoped } = await fixture();
  const failure = Object.assign(new Error("unlink failed"), { code: "EIO" });
  const closeFailure = Object.assign(new Error("close failed"), { code: "EIO" });
  vi.spyOn(fsSync, "unlinkSync").mockImplementation(() => { throw failure; });
  const open = fsSync.openSync.bind(fsSync);
  let sourceFd: number | undefined;
  vi.spyOn(fsSync, "openSync").mockImplementation((file, flags, mode) => {
    const fd = open(file, flags, mode);
    if (String(file) === source) sourceFd = fd;
    return fd;
  });
  const close = fsSync.closeSync.bind(fsSync);
  const closeSpy = vi.spyOn(fsSync, "closeSync").mockImplementation(fd => { close(fd); if (fd === sourceFd) throw closeFailure; });
  const error = await scoped.move("source", "target").catch(error => error);
  expect(error).toMatchObject({
    name: "SuppressedError", error: closeFailure, suppressed: { cause: failure, details: { sourceRecovery: { status: "indeterminate" } } },
  });
  expect(await fs.readFile(error.suppressed.details.sourceRecovery.path, "utf8")).toBe("source");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(target, "utf8")).toBe("source");
  expect(closeSpy.mock.calls.filter(([fd]) => fd === sourceFd)).toHaveLength(1);
});

it.each(["ENOSYS", "ENOTSUP", "EINVAL", "EIO"])("propagates an %s hook failure without link dispatch", async code => {
  const { source, target, scoped } = await fixture();
  const failure = Object.assign(new Error("hook failed"), { code });
  __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: async () => { throw failure; } });
  const link = vi.spyOn(fsSync, "linkSync");
  await expect(scoped.move("source", "target")).rejects.toBe(failure);
  expect(link).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("source");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["source", "target"])("rejects denied %s mutations with native disabled", async denied => {
  const { directory, source, target } = await fixture();
  const scoped = await root(directory, { denyMutations: { paths: [path.join(directory, denied)] } });
  const link = vi.spyOn(fsSync, "linkSync");
  await expect(scoped.move("source", "target")).rejects.toMatchObject({ code: "denied-path" });
  expect(link).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("source");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects an initially hardlinked source", async () => {
  const { directory, source, target, scoped } = await fixture();
  await fs.link(source, path.join(directory, "alias"));
  await expect(scoped.move("source", "target")).rejects.toMatchObject({ code: "hardlink" });
  expect(await fs.readFile(source, "utf8")).toBe("source");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a link added by live authority before source removal", async () => {
  const { directory, source, target, scoped } = await fixture();
  let calls = 0;
  await expect(scoped.move("source", "target", {
    assertBeforeMutation: () => { if (++calls === 2) fsSync.linkSync(source, path.join(directory, "alias")); },
  })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(await fs.readFile(source, "utf8")).toBe("source");
  expect(await fs.readFile(target, "utf8")).toBe("source");
});
