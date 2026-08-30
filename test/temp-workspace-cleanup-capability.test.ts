import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync, withTempWorkspace, withTempWorkspaceSync } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // Admission rejection remains testable without an installed binding.
}
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe.each(["async", "sync", "with-async", "with-sync"] as const)("%s workspace creation admission", (variant) => {
  function create(rootDir: string, run = vi.fn()) {
    const options = { rootDir, prefix: "workspace-" };
    if (variant === "async") return tempWorkspace(options);
    if (variant === "sync") return tempWorkspaceSync(options);
    if (variant === "with-async") return withTempWorkspace(options, run);
    return withTempWorkspaceSync(options, run);
  }

  it.each(["off", "absent-auto", "absent-require", "missing-auto", "missing-require"])(
    "rejects %s before opening a parent or creating a child",
    async (availability) => {
      const rootDir = path.join(await tempRoot("fs-safe-workspace-admission-"), "root");
      configureFsSafeNative({ mode: availability === "off" ? "off" : availability.endsWith("require") ? "require" : "auto" });
      const loader = vi.fn(() => {
        if (availability.startsWith("missing")) return {} as NativeBinding;
        throw new Error("injected unavailable binding");
      });
      __setNativeLoaderForTest(loader);
      const opened = vi.spyOn(fsSync, "openSync");
      const closed = vi.spyOn(fsSync, "closeSync");
      const mkdtemp = vi.spyOn(fs, "mkdtemp");
      const mkdtempSync = vi.spyOn(fsSync, "mkdtempSync");
      const run = vi.fn();
      await expect(async () => create(rootDir, run)).rejects.toEqual(expect.objectContaining({
        code: "helper-unavailable", name: "FsSafeError",
      }));
      expect(await fs.readdir(rootDir)).toEqual([]);
      expect(mkdtemp).not.toHaveBeenCalled();
      expect(mkdtempSync).not.toHaveBeenCalled();
      expect(opened).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(loader).toHaveBeenCalledTimes(availability === "off" ? 0 : 1);
    },
  );

  it("rejects an unavailable parent descriptor before creating a child", async () => {
    const rootDir = path.join(await tempRoot("fs-safe-workspace-descriptor-"), "root");
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => ({ renameNoReplace: vi.fn() }) as unknown as NativeBinding);
    const failure = Object.assign(new Error("directory descriptor unavailable"), { code: "EISDIR" });
    const open = fsSync.openSync;
    vi.spyOn(fsSync, "openSync").mockImplementation((name, ...args) => {
      if (name === rootDir) throw failure;
      return open(name, ...args);
    });
    const closed = vi.spyOn(fsSync, "closeSync");
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    const mkdtempSync = vi.spyOn(fsSync, "mkdtempSync");
    const run = vi.fn();
    await expect(async () => create(rootDir, run)).rejects.toMatchObject({ code: "helper-unavailable", cause: failure });
    expect(await fs.readdir(rootDir)).toEqual([]);
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(mkdtempSync).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32").each([1, 2])("closes once if retained-parent validation %s fails", async (inspection) => {
    const rootDir = await tempRoot("fs-safe-workspace-parent-validation-");
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => ({ renameNoReplace: vi.fn() }) as unknown as NativeBinding);
    const failure = new Error("parent descriptor inspection failed");
    const opened = vi.spyOn(fsSync, "openSync");
    const fstat = fsSync.fstatSync;
    let inspections = 0;
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      if (++inspections === inspection) throw failure;
      return fstat(...args);
    });
    const closed = vi.spyOn(fsSync, "closeSync");
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    const mkdtempSync = vi.spyOn(fsSync, "mkdtempSync");
    await expect(async () => create(rootDir)).rejects.toMatchObject({ code: "helper-unavailable", cause: failure });
    const fd = opened.mock.results[0]!.value as number;
    cleanup.__cleanupRegisteredTempPathsForTest();
    expect(closed.mock.calls).toEqual([[fd]]);
    expect(() => fstat(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(mkdtempSync).not.toHaveBeenCalled();
    expect(await fs.readdir(rootDir)).toEqual([]);
  });
});

describe.runIf(native && process.platform !== "win32").each(["async", "sync"] as const)("%s retained cleanup capability", (variant) => {
  it.each(["mkdtemp", "lstat", "invalid-child", "registration"])("closes once after creation fails at %s", async (stage) => {
    configureFsSafeNative({ mode: "require" });
    const rootDir = await tempRoot("fs-safe-workspace-create-failure-");
    const failure = new Error("injected creation failure");
    const opened = vi.spyOn(fsSync, "openSync");
    const closed = vi.spyOn(fsSync, "closeSync");
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    if (stage === "mkdtemp") {
      if (variant === "async") vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(failure);
      else vi.spyOn(fsSync, "mkdtempSync").mockImplementationOnce(() => { throw failure; });
    } else if (stage === "registration") {
      vi.spyOn(cleanup, "registerTempPathForExit").mockImplementationOnce(() => { throw failure; });
    } else {
      const inspect = (candidate: fsSync.PathLike) => {
        if (path.dirname(String(candidate)) !== rootDir) return;
        if (stage === "lstat") throw failure;
        fsSync.rmdirSync(candidate);
        fsSync.writeFileSync(candidate, "replacement");
      };
      if (variant === "async") {
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
          inspect(candidate);
          return lstat(candidate, options);
        });
      } else {
        const lstat = fsSync.lstatSync;
        vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
          inspect(candidate);
          return lstat(candidate, options);
        });
      }
    }
    const options = { rootDir, prefix: "workspace-" };
    await expect(async () => variant === "async" ? tempWorkspace(options) : tempWorkspaceSync(options))
      .rejects.toThrow(stage === "invalid-child" ? "Temp workspace must be a directory" : failure);
    const index = opened.mock.calls.findIndex(([name]) => name === rootDir);
    const fd = opened.mock.results[index]!.value as number;
    cleanup.__cleanupRegisteredTempPathsForTest();
    expect(closed.mock.calls.filter(([candidate]) => candidate === fd)).toHaveLength(1);
    expect(() => fsSync.fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
    expect(rm).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
    expect((await fs.readdir(rootDir)).length).toBe(stage === "mkdtemp" ? 0 : 1);
  });

  it.each(["manual", "dispose", "exit"])("uses the captured binding after mode off and loader reset for %s cleanup", async (method) => {
    configureFsSafeNative({ mode: "require" });
    const rename = vi.fn((...args: Parameters<NativeBinding["renameNoReplace"]>) => native!.renameNoReplace(...args));
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace: rename }));
    const rootDir = await tempRoot("fs-safe-workspace-captured-binding-");
    const options = { rootDir, prefix: "workspace-" };
    const opened = vi.spyOn(fsSync, "openSync");
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    await workspace.write("owned.txt", "owned");
    const index = opened.mock.calls.findIndex(([name]) => name === rootDir);
    const fd = opened.mock.results[index]!.value as number;
    const closed = vi.spyOn(fsSync, "closeSync");
    configureFsSafeNative({ mode: "off" });
    __resetNativeLoaderForTest();
    const loader = vi.fn(() => { throw new Error("must not reload"); });
    __setNativeLoaderForTest(loader);
    if (method === "manual") expect(await workspace.cleanup()).toBe("removed");
    else if (method === "exit") cleanup.__cleanupRegisteredTempPathsForTest();
    else if (Symbol.asyncDispose in workspace) await workspace[Symbol.asyncDispose]();
    else workspace[Symbol.dispose]();
    expect(await workspace.cleanup()).toBe("missing");
    cleanup.__cleanupRegisteredTempPathsForTest();
    expect(closed.mock.calls.filter(([candidate]) => candidate === fd)).toHaveLength(1);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it.each([false, true])("cleans after withTempWorkspace changes native mode (callback throws: %s)", async (throws) => {
    configureFsSafeNative({ mode: "require" });
    const rootDir = await tempRoot("fs-safe-workspace-with-captured-");
    const options = { rootDir, prefix: "workspace-" };
    const failure = new FsSafeError("denied-path", "callback failure");
    const run = (workspace: { dir: string }) => {
      fsSync.writeFileSync(path.join(workspace.dir, "owned.txt"), "owned");
      configureFsSafeNative({ mode: "off" });
      __resetNativeLoaderForTest();
      if (throws) throw failure;
      return "done";
    };
    const operation = async () => variant === "async"
      ? withTempWorkspace(options, async (workspace) => run(workspace))
      : withTempWorkspaceSync(options, run);
    if (throws) await expect(operation()).rejects.toBe(failure);
    else expect(await operation()).toBe("done");
    expect(await fs.readdir(rootDir)).toEqual([]);
  });
});
