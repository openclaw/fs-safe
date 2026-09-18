import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Built by platform jobs. */ }
const supported = ["darwin", "linux", "win32"].includes(process.platform);

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawnSync).mockReset().mockImplementation(actual.spawnSync);
  configureFsSafeNative({ mode: "off" });
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-root-command-integration-");
  const sourceParent = path.join(directory, "incoming");
  const targetParent = path.join(directory, "archive");
  await Promise.all([fs.mkdir(sourceParent), fs.mkdir(targetParent)]);
  const source = path.join(sourceParent, "source");
  const target = path.join(targetParent, "target");
  await fs.writeFile(source, "original source", { mode: 0o640 });
  const identity = await fs.stat(source, { bigint: true });
  const scoped = await root(directory);
  return { directory, sourceParent, targetParent, source, target, identity, scoped };
}

describe.runIf(supported)("real portable Root.move no-replace command", () => {
  it.each(["auto", "off"] as const)("fails closed when an awaited hook changes %s to require", async mode => {
    const f = await fixture();
    __setNativeLoaderForTest(() => { throw new Error("missing addon"); });
    configureFsSafeNative({ mode });
    let hookRan = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async () => {
        await Promise.resolve();
        configureFsSafeNative({ mode: "require" });
        hookRan = true;
      },
    });

    await expect(f.scoped.move("incoming/source", "archive/target")).rejects.toMatchObject({ code: "helper-unavailable" });

    expect(hookRan).toBe(true);
    expect(spawnSync).not.toHaveBeenCalled();
    expect((await fs.stat(f.source, { bigint: true })).ino).toBe(f.identity.ino);
    expect(await fs.readFile(f.source, "utf8")).toBe("original source");
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["auto", "off"] as const)("fails closed when final authority changes %s to require", async mode => {
    const f = await fixture();
    __setNativeLoaderForTest(() => { throw new Error("missing addon"); });
    configureFsSafeNative({ mode });
    let authorityRan = false;

    await expect(f.scoped.move("incoming/source", "archive/target", {
      assertBeforeMutation: () => {
        configureFsSafeNative({ mode: "require" });
        authorityRan = true;
      },
    })).rejects.toMatchObject({ code: "helper-unavailable" });

    expect(authorityRan).toBe(true);
    expect(spawnSync).not.toHaveBeenCalled();
    expect((await fs.stat(f.source, { bigint: true })).ino).toBe(f.identity.ino);
    expect(await fs.readFile(f.source, "utf8")).toBe("original source");
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["off", "auto"] as const)("retains exact inode, mode and contents in %s mode", async mode => {
    const f = await fixture();
    const loader = vi.fn(() => { throw new Error("missing addon"); });
    __setNativeLoaderForTest(loader);
    configureFsSafeNative({ mode });
    const link = vi.spyOn(fs, "link");
    const copy = vi.spyOn(fs, "copyFile");
    const unlink = vi.spyOn(fs, "unlink");

    await f.scoped.move("incoming/source", "archive/target");

    const target = await fs.stat(f.target, { bigint: true });
    expect({ dev: target.dev, ino: target.ino, mode: target.mode, nlink: target.nlink }).toEqual({
      dev: f.identity.dev, ino: f.identity.ino, mode: f.identity.mode, nlink: 1n,
    });
    expect(await fs.readFile(f.target, "utf8")).toBe("original source");
    await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(link).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    if (mode === "off") expect(loader).not.toHaveBeenCalled();
    else expect(loader).toHaveBeenCalledOnce();
  });

  it("preserves a competitor introduced by the final authority callback", async () => {
    const f = await fixture();
    await expect(f.scoped.move("incoming/source", "archive/target", {
      assertBeforeMutation: () => fsSync.writeFileSync(f.target, "competitor"),
    })).rejects.toMatchObject({ code: "already-exists", details: { commit: "unknown" } });
    expect(await fs.readFile(f.target, "utf8")).toBe("competitor");
    expect((await fs.stat(f.source, { bigint: true })).ino).toBe(f.identity.ino);
    expect(await fs.readFile(f.source, "utf8")).toBe("original source");
  });

  it.each([false, true])("retains an indeterminate receipt after transport failure (renamed: %s)", async renamed => {
    const f = await fixture();
    const failure = Object.assign(new Error("command reply lost"), { code: "ETIMEDOUT" });
    vi.mocked(spawnSync).mockImplementation(() => {
      if (renamed) fsSync.renameSync(f.source, f.target);
      return { pid: 42, status: null, signal: "SIGKILL", error: failure, stdout: "", stderr: "", output: [] };
    });
    let observed: unknown;
    try { await f.scoped.move("incoming/source", "archive/target"); } catch (error) { observed = error; }
    expect(observed).toMatchObject({ details: { commit: "unknown" } });
    expect((observed as { details: object }).details).not.toHaveProperty("sourceConsumed");
    expect(spawnSync).toHaveBeenCalledOnce();
    expect((await fs.stat(renamed ? f.target : f.source, { bigint: true })).ino).toBe(f.identity.ino);
    await expect(fs.lstat(renamed ? f.source : f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("distinguishes a command proven not to have started", async () => {
    const f = await fixture();
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0, status: null, signal: null,
      error: Object.assign(new Error("command unavailable"), { code: "ENOENT" }),
      stdout: "", stderr: "", output: [],
    });
    await expect(f.scoped.move("incoming/source", "archive/target")).rejects.toMatchObject({
      details: { commit: "not-attempted" },
    });
    expect(spawnSync).toHaveBeenCalledOnce();
    expect((await fs.stat(f.source, { bigint: true })).ino).toBe(f.identity.ino);
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns final authority rejection without mistaking its errno for a command receipt", async () => {
    const f = await fixture();
    const failure = Object.assign(new Error("lease expired"), { code: "EEXIST", commit: "committed" });
    await expect(f.scoped.move("incoming/source", "archive/target", {
      assertBeforeMutation: () => { throw failure; },
    })).rejects.toBe(failure);
    expect(spawnSync).not.toHaveBeenCalled();
    expect((await fs.stat(f.source, { bigint: true })).ino).toBe(f.identity.ino);
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks a rejected parent alias after final authority", async () => {
    const f = await fixture();
    const parked = path.join(f.directory, "parked");
    await expect(f.scoped.move("incoming/source", "archive/target", {
      mutationSymlinks: "reject",
      assertBeforeMutation: () => {
        fsSync.renameSync(f.targetParent, parked);
        fsSync.symlinkSync(parked, f.targetParent, process.platform === "win32" ? "junction" : "dir");
      },
    })).rejects.toMatchObject({ code: "not-file" });
    expect(spawnSync).not.toHaveBeenCalled();
    expect((await fs.stat(f.source, { bigint: true })).ino).toBe(f.identity.ino);
    await expect(fs.lstat(path.join(parked, "target"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("selects the source after awaited admission hooks", async () => {
    const f = await fixture();
    const parked = path.join(f.sourceParent, "parked");
    let replacement: fsSync.BigIntStats | undefined;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async () => {
        await fs.rename(f.source, parked);
        await fs.writeFile(f.source, "hook replacement");
        replacement = await fs.stat(f.source, { bigint: true });
      },
    });
    await f.scoped.move("incoming/source", "archive/target");
    expect((await fs.stat(f.target, { bigint: true })).ino).toBe(replacement!.ino);
    expect((await fs.stat(parked, { bigint: true })).ino).toBe(f.identity.ino);
    expect(await fs.readFile(f.target, "utf8")).toBe("hook replacement");
  });

  it("does not reselect a source replaced by the final authority callback", async () => {
    const f = await fixture();
    const parked = path.join(f.sourceParent, "parked");
    await expect(f.scoped.move("incoming/source", "archive/target", {
      assertBeforeMutation: () => {
        fsSync.renameSync(f.source, parked);
        fsSync.writeFileSync(f.source, "replacement");
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect((await fs.stat(parked, { bigint: true })).ino).toBe(f.identity.ino);
    expect(await fs.readFile(f.source, "utf8")).toBe("replacement");
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["root", "source", "target"] as const)("rechecks the %s boundary after authority", async boundary => {
    const f = await fixture();
    const base = await tempRoot("fs-safe-root-command-moved-");
    const moved = path.join(base, "moved");
    const changed = boundary === "root" ? f.directory : boundary === "source" ? f.sourceParent : f.targetParent;
    await expect(f.scoped.move("incoming/source", "archive/target", {
      assertBeforeMutation: () => { fsSync.renameSync(changed, moved); fsSync.mkdirSync(changed); },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    const original = boundary === "root" ? path.join(moved, "incoming/source")
      : boundary === "source" ? path.join(moved, "source") : f.source;
    expect((await fs.stat(original, { bigint: true })).ino).toBe(f.identity.ino);
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["directory", "symlink", "hardlink"] as const)("keeps the %s source restriction", async kind => {
    const f = await fixture();
    if (kind === "directory") { await fs.unlink(f.source); await fs.mkdir(f.source); }
    if (kind === "symlink") {
      await fs.rename(f.source, path.join(f.sourceParent, "original"));
      await fs.symlink("original", f.source);
    }
    if (kind === "hardlink") await fs.link(f.source, path.join(f.sourceParent, "other"));
    await expect(f.scoped.move("incoming/source", "archive/target")).rejects.toMatchObject({
      code: kind === "directory" ? "invalid-path" : kind === "symlink" ? "symlink" : "hardlink",
    });
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.lstat(f.source)).toBeDefined();
  });

  it("retains the committed receipt when target verification fails", async () => {
    const f = await fixture();
    const failure = Object.assign(new Error("target verification failed"), { code: "EIO" });
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const result = lstat(...args);
      if (String(args[0]) === f.target) throw failure;
      return result;
    });

    await expect(f.scoped.move("incoming/source", "archive/target")).rejects.toMatchObject({
      details: { commit: "committed", sourceConsumed: true },
    });
    expect((await fs.stat(f.target, { bigint: true })).ino).toBe(f.identity.ino);
    await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("retains the committed receipt when borrowed source close fails", async () => {
    const f = await fixture();
    const failure = Object.assign(new Error("source close failed"), { code: "EIO" });
    const open = fsSync.openSync.bind(fsSync);
    const close = fsSync.closeSync.bind(fsSync);
    let sourceFd: number | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (String(args[0]) === f.source) sourceFd = fd;
      return fd;
    });
    vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
      close(fd);
      if (fd === sourceFd) { sourceFd = undefined; throw failure; }
    });

    await expect(f.scoped.move("incoming/source", "archive/target")).rejects.toMatchObject({
      cause: failure, details: { commit: "committed", sourceConsumed: true },
    });
    expect((await fs.stat(f.target, { bigint: true })).ino).toBe(f.identity.ino);
    await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("normalizes disappearance while pinning the selected source", async () => {
    const f = await fixture();
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      if (String(args[0]) === f.source) fsSync.unlinkSync(f.source);
      return open(...args);
    });
    await expect(f.scoped.move("incoming/source", "archive/target")).rejects.toMatchObject({ code: "not-found" });
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe.runIf(process.platform === "darwin" && native)("Darwin unreadable source parity", () => {
  it.each(["off", "require"] as const)("moves mode 000 source using %s without changing its mode", async mode => {
    const f = await fixture();
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode });
    await fs.chmod(f.source, 0);
    try {
      await f.scoped.move("incoming/source", "archive/target");
      const target = await fs.stat(f.target, { bigint: true });
      expect(target.ino).toBe(f.identity.ino);
      expect(target.mode & 0o777n).toBe(0n);
      expect(target.nlink).toBe(1n);
      await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.chmod(f.target, 0o600).catch(() => undefined);
      await fs.chmod(f.source, 0o600).catch(() => undefined);
    }
  });

  it.each(["off", "require"] as const)("documents the final-name swap window with %s dispatch", async mode => {
    const f = await fixture();
    const parked = path.join(f.sourceParent, "parked");
    const replacement = path.join(f.sourceParent, "replacement");
    await fs.writeFile(replacement, "replacement source", { mode: 0 });
    const replacementIdentity = await fs.stat(replacement, { bigint: true });
    await fs.chmod(f.source, 0);
    let swapped = false;
    const swapAfterFinalIdentityCheck = () => {
      fsSync.renameSync(f.source, parked);
      fsSync.renameSync(replacement, f.source);
      swapped = true;
    };
    if (mode === "off") {
      const { spawnSync: spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(spawnSync).mockImplementation((...args) => {
        if (args[0] === "/usr/bin/osascript") swapAfterFinalIdentityCheck();
        return spawn(...args);
      });
    } else {
      __setNativeLoaderForTest(() => ({
        ...native!,
        renameNoReplace: (...args) => { swapAfterFinalIdentityCheck(); native!.renameNoReplace(...args); },
      }));
    }
    configureFsSafeNative({ mode });
    try {
      const moving = f.scoped.move("incoming/source", "archive/target");
      if (mode === "off") {
        // The command adds a postcheck, but cannot undo the name-based rename.
        await expect(moving).rejects.toMatchObject({ code: "path-mismatch", details: { commit: "committed" } });
      } else {
        await moving;
      }
      expect(swapped).toBe(true);
      expect((await fs.stat(f.target, { bigint: true })).ino).toBe(replacementIdentity.ino);
      expect((await fs.stat(parked, { bigint: true })).ino).toBe(f.identity.ino);
      await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const file of [f.source, f.target, parked, replacement]) await fs.chmod(file, 0o600).catch(() => undefined);
    }
  });
});
