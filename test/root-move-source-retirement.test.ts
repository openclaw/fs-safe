import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

async function fixture() {
  const directory = await tempRoot("fs-safe-source-retirement-");
  const source = path.join(directory, "source"), target = path.join(directory, "target");
  await fs.writeFile(source, "original A");
  const identity = await fs.stat(source, { bigint: true });
  return { directory, source, target, identity, scoped: await root(directory) };
}

describe.skipIf(process.platform === "win32")("POSIX source retirement capture", () => {
  it.each(["file", "symlink", "directory"] as const)("preserves a substituted %s captured at final rename dispatch", async kind => {
    const { directory, source, target, identity, scoped } = await fixture();
    const retired = path.join(directory, "retired-A");
    const victim = path.join(directory, "victim");
    await fs.writeFile(victim, "unrelated B");
    const rename = fsSync.renameSync.bind(fsSync);
    const captureSpy = vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (String(from) === source) {
        rename(source, retired);
        if (kind === "file") fsSync.writeFileSync(source, "unrelated B");
        else if (kind === "symlink") fsSync.symlinkSync(victim, source);
        else { fsSync.mkdirSync(source); fsSync.writeFileSync(path.join(source, "child"), "unrelated B"); }
        rename(from, to);
        fsSync.writeFileSync(source, "new C");
      } else rename(from, to);
    });
    const unlink = vi.spyOn(fsSync, "unlinkSync");
    const error = await scoped.move("source", "target").catch(error => error);
    expect(error).toMatchObject({ code: "path-mismatch", details: { sourceConsumed: false, sourceRecovery: { status: "preserved" } } });
    const recovery = error.details.sourceRecovery.path;
    expect(captureSpy).toHaveBeenCalledOnce();
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(source, "utf8")).toBe("new C");
    expect(await fs.readFile(target, "utf8")).toBe("original A");
    expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino, nlink: 2n });
    expect(await fs.readFile(retired, "utf8")).toBe("original A");
    expect(await fs.readFile(kind === "directory" ? path.join(recovery, "child") : recovery, "utf8")).toBe("unrelated B");
    expect(await fs.readFile(victim, "utf8")).toBe("unrelated B");
    if (kind === "symlink") expect((await fs.lstat(recovery)).isSymbolicLink()).toBe(true);
  });

  it("retires the original while preserving a new public source created after capture", async () => {
    const { directory, source, target, identity, scoped } = await fixture();
    const rename = fsSync.renameSync.bind(fsSync);
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(from) === source) fsSync.writeFileSync(source, "new C");
    });
    const unlink = vi.spyOn(fsSync, "unlinkSync");
    await scoped.move("source", "target");
    expect(await fs.readFile(source, "utf8")).toBe("new C");
    expect(await fs.readFile(target, "utf8")).toBe("original A");
    expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino, nlink: 1n });
    expect(unlink).toHaveBeenCalledOnce();
    expect(String(unlink.mock.calls[0]![0])).not.toBe(source);
    expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
  });

  it.each([false, true])("preserves uncertain capture without any unlink or restoring rename (completed=%s)", async completed => {
    const { source, target, scoped } = await fixture();
    const failure = new Error("capture reply lost");
    const rename = fsSync.renameSync.bind(fsSync);
    const captureSpy = vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (completed) rename(from, to);
      throw failure;
    });
    const unlink = vi.spyOn(fsSync, "unlinkSync");
    const error = await scoped.move("source", "target").catch(error => error);
    expect(error).toMatchObject({ cause: failure, details: { sourceRecovery: { status: "indeterminate" } } });
    expect(error.details).not.toHaveProperty("sourceConsumed");
    expect(captureSpy).toHaveBeenCalledOnce();
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(completed ? error.details.sourceRecovery.path : source, "utf8")).toBe("original A");
    expect(await fs.readFile(target, "utf8")).toBe("original A");
  });

  it("preserves a replacement introduced by live authority after capture", async () => {
    const { directory, source, target, scoped } = await fixture();
    let calls = 0;
    let capture: string | undefined;
    const rename = fsSync.renameSync.bind(fsSync);
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => { rename(from, to); if (String(from) === source) capture = String(to); });
    const unlink = vi.spyOn(fsSync, "unlinkSync");
    const error = await scoped.move("source", "target", { assertBeforeMutation: () => {
      if (++calls !== 4) return;
      rename(capture!, path.join(directory, "retired-A"));
      fsSync.writeFileSync(capture!, "unrelated B");
    } }).catch(error => error);
    expect(error).toMatchObject({ code: "path-mismatch", details: { sourceConsumed: false, sourceRecovery: { status: "preserved", path: capture } } });
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(capture!, "utf8")).toBe("unrelated B");
    expect(await fs.readFile(target, "utf8")).toBe("original A");
  });

  it("preserves both directories if the quarantine pathname changes after capture", async () => {
    const { directory, source, target, scoped } = await fixture();
    const preserved = path.join(directory, "moved-quarantine");
    const rename = fsSync.renameSync.bind(fsSync);
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(from) !== source) return;
      const quarantine = path.dirname(String(to));
      rename(quarantine, preserved);
      fsSync.mkdirSync(quarantine, { mode: 0o700 });
      fsSync.writeFileSync(String(to), "unrelated B");
    });
    const unlink = vi.spyOn(fsSync, "unlinkSync"), rmdir = vi.spyOn(fsSync, "rmdirSync");
    const error = await scoped.move("source", "target").catch(error => error);
    expect(error).toMatchObject({ code: "path-mismatch", details: { sourceConsumed: false, sourceRecovery: { status: "indeterminate" } } });
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(preserved, "source"), "utf8")).toBe("original A");
    expect(await fs.readFile(error.details.sourceRecovery.path, "utf8")).toBe("unrelated B");
    expect(await fs.readFile(target, "utf8")).toBe("original A");
  });

  it("reports completed retirement when authority expires before empty-directory cleanup", async () => {
    const { source, target, scoped } = await fixture();
    const failure = new Error("cleanup authority expired");
    let calls = 0;
    const removeDirectory = vi.spyOn(fsSync, "rmdirSync");
    const error = await scoped.move("source", "target", { assertBeforeMutation: () => { if (++calls === 5) throw failure; } }).catch(error => error);
    expect(error).toMatchObject({ code: "denied-path", cause: { rejection: failure }, details: { sourceConsumed: true } });
    expect(error.details).not.toHaveProperty("sourceRecovery");
    expect(removeDirectory).not.toHaveBeenCalled();
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(target, "utf8")).toBe("original A");
  });

  it("reports completed retirement when the original descriptor close fails", async () => {
    const { source, target, scoped } = await fixture();
    const failure = new Error("source descriptor close failed");
    const open = fsSync.openSync.bind(fsSync), close = fsSync.closeSync.bind(fsSync);
    let sourceFd: number | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      if (String(file) === source) sourceFd = fd;
      return fd;
    });
    const closeSpy = vi.spyOn(fsSync, "closeSync").mockImplementation(fd => { close(fd); if (fd === sourceFd) throw failure; });
    await expect(scoped.move("source", "target")).rejects.toMatchObject({ cause: failure, details: { sourceConsumed: true } });
    expect(closeSpy.mock.calls.filter(([fd]) => fd === sourceFd)).toHaveLength(1);
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(target, "utf8")).toBe("original A");
  });

  it.each((["fstat-fault", "link-drift"] as const).flatMap(fault => [false, true].map(closeFails => ({ fault, closeFails }))))(
    "retains completed retirement after $fault (source close fails=$closeFails)", async ({ fault, closeFails }) => {
      const { directory, source, target, scoped } = await fixture();
      const statFailure = new Error("post-delete descriptor observation failed"), closeFailure = new Error("source close failed");
      const open = fsSync.openSync.bind(fsSync), close = fsSync.closeSync.bind(fsSync);
      const unlink = fsSync.unlinkSync.bind(fsSync), fstat = fsSync.fstatSync.bind(fsSync);
      let sourceFd: number | undefined;
      let deleted = false;
      vi.spyOn(fsSync, "openSync").mockImplementation((file, flags, mode) => {
        const fd = open(file, flags, mode); if (String(file) === source) sourceFd = fd; return fd;
      });
      vi.spyOn(fsSync, "unlinkSync").mockImplementation(file => {
        unlink(file); deleted = true;
        if (fault === "link-drift") fsSync.linkSync(target, path.join(directory, "new-alias"));
      });
      vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
        if (deleted && fd === sourceFd && fault === "fstat-fault") throw statFailure;
        return fstat(fd, options);
      });
      vi.spyOn(fsSync, "closeSync").mockImplementation(fd => { close(fd); if (closeFails && fd === sourceFd) throw closeFailure; });
      const error = await scoped.move("source", "target").catch(error => error);
      const operation = closeFails ? error.suppressed : error;
      expect(operation).toMatchObject({ details: { sourceConsumed: true } });
      expect(operation.details).not.toHaveProperty("sourceRecovery");
      if (fault === "fstat-fault") expect(operation.cause).toBe(statFailure);
      else expect(operation.code).toBe("path-mismatch");
      if (closeFails) expect(error).toMatchObject({ name: "SuppressedError", error: { cause: closeFailure, details: { sourceConsumed: true } } });
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(target, "utf8")).toBe("original A");
    },
  );

  it("keeps source-parent write/search-only permissions sufficient", async () => {
    const { directory, source, target, scoped } = await fixture();
    await fs.chmod(directory, 0o300);
    try {
      await scoped.move("source", "target");
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o300);
      expect(await fs.readFile(target, "utf8")).toBe("original A");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.chmod(directory, 0o700); }
  });
});
