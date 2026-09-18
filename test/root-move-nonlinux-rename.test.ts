import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as darwin from "../src/darwin-move-command.js";
import * as windows from "../src/windows-move-command.js";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const actualPlatform = process.platform;
const renameDarwin = darwin.renameDarwinNoReplace;
const renameWindows = windows.moveWindowsFileNoReplaceSync;

for (const backend of ["darwin", "win32"] as const) {
  describe.skipIf(actualPlatform === "win32" && backend === "darwin")(`${backend} Root fallback without hardlinks`, () => {
    const opened: { path: string; fd: number }[] = [];
    beforeEach(() => {
      opened.length = 0;
      configureFsSafeNative({ mode: "off" });
      vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
      if (actualPlatform !== backend) vi.spyOn(process, "platform", "get").mockReturnValue(backend);
      const open = fsSync.openSync.bind(fsSync);
      vi.spyOn(fsSync, "openSync").mockImplementation((file, flags, mode) => {
        const fd = open(file, actualPlatform !== "darwin" && backend === "darwin" && typeof flags === "number" ? flags & ~0x4000_0000 : flags, mode);
        opened.push({ path: String(file), fd });
        return fd;
      });
    });
    afterEach(() => { vi.restoreAllMocks(); __setFsSafeTestHooksForTest(); __resetFsSafeNativeConfigForTest(); });

    async function fixture(code = "EPERM") {
      const directory = await tempRoot("fs-safe-no-hardlinks-root-");
      const rootPath = path.join(directory, "root");
      const sourceParent = path.join(rootPath, "incoming"), targetParent = path.join(rootPath, "outgoing");
      await fs.mkdir(sourceParent, { recursive: true }); await fs.mkdir(targetParent);
      const source = path.join(sourceParent, "source-é-🦀"), target = path.join(targetParent, "target-é-🦀");
      await fs.writeFile(source, "original A", { mode: 0o600 });
      const identity = await fs.stat(source, { bigint: true });
      const scoped = await root(rootPath);
      const failure = Object.assign(new Error("filesystem cannot create hardlinks"), { code });
      const link = vi.spyOn(fsSync, "linkSync").mockImplementation(() => { throw failure; });
      const command = vi.fn((input: unknown) => {
        if (backend === actualPlatform) {
          if (backend === "darwin") renameDarwin(input as darwin.DarwinRenameNoReplaceInput);
          else renameWindows(input as windows.WindowsFileMoveCommandInput);
        } else {
          // Other hosts model caller settlement with real files/descriptors.
          if (fsSync.existsSync(target)) throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
          fsSync.renameSync(source, target);
        }
      });
      vi.spyOn(darwin, "renameDarwinNoReplace").mockImplementation(command);
      vi.spyOn(windows, "moveWindowsFileNoReplaceSync").mockImplementation(command);
      const move = (options?: Parameters<typeof scoped.move>[2]) => scoped.move(`incoming/${path.basename(source)}`, `outgoing/${path.basename(target)}`, options);
      return { directory, rootPath, sourceParent, targetParent, source, target, identity, failure, link, command, move };
    }

    it.each(["EPERM", "ENOTSUP"])("moves the pinned original after %s without replaying admission hooks", async code => {
      const { source, target, identity, link, command, move } = await fixture(code);
      const hook = vi.fn(async () => undefined), authority = vi.fn();
      __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: hook });
      const perform = command.getMockImplementation()!;
      command.mockImplementation(input => {
        const sourceFd = opened.find(entry => entry.path === source)!.fd;
        expect(fsSync.fstatSync(sourceFd, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino, nlink: 1n });
        perform(input);
      });
      const close = vi.spyOn(fsSync, "closeSync"), copy = vi.spyOn(fsSync, "copyFileSync"), unlink = vi.spyOn(fsSync, "unlinkSync");
      await move({ assertBeforeMutation: authority });
      expect(link).toHaveBeenCalledOnce(); expect(command).toHaveBeenCalledOnce();
      expect(hook).toHaveBeenCalledOnce(); expect(authority).toHaveBeenCalledTimes(2);
      const sourceFd = opened.find(entry => entry.path === source)!.fd;
      expect(close.mock.calls.filter(([fd]) => fd === sourceFd)).toHaveLength(1);
      expect(close).toHaveBeenCalledTimes(backend === "darwin" ? 3 : 1);
      expect(new Set(close.mock.calls.map(([fd]) => fd)).size).toBe(backend === "darwin" ? 3 : 1);
      if (backend === "win32") expect(opened).toHaveLength(1);
      expect(copy).not.toHaveBeenCalled(); expect(unlink).not.toHaveBeenCalled();
      expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino, nlink: 1n, mode: identity.mode });
      expect(await fs.readFile(target, "utf8")).toBe("original A");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    }, 35_000);

    it("preserves an unclassified link I/O failure without command dispatch", async () => {
      const { source, target, failure, command, move } = await fixture("EIO");
      await expect(move()).rejects.toBe(failure);
      expect(command).not.toHaveBeenCalled();
      expect(await fs.readFile(source, "utf8")).toBe("original A");
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps the original source admission when authority replaces its public name", async () => {
      const { directory, source, target, command, move } = await fixture();
      let calls = 0;
      const retired = path.join(directory, "retired-A");
      await expect(move({ assertBeforeMutation: () => {
        if (++calls !== 2) return;
        fsSync.renameSync(source, retired); fsSync.writeFileSync(source, "replacement B");
      } })).rejects.toMatchObject({ code: "path-mismatch" });
      expect(command).not.toHaveBeenCalled();
      expect(await fs.readFile(retired, "utf8")).toBe("original A");
      expect(await fs.readFile(source, "utf8")).toBe("replacement B");
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["root", "source-parent", "target-parent"] as const)("refences a replaced %s after fallback authority", async boundary => {
      const { directory, rootPath, sourceParent, targetParent, source, target, command, move } = await fixture();
      const changed = boundary === "root" ? rootPath : boundary === "source-parent" ? sourceParent : targetParent;
      const preserved = path.join(directory, "preserved");
      let calls = 0;
      await expect(move({ assertBeforeMutation: () => {
        if (++calls !== 2) return;
        fsSync.renameSync(changed, preserved); fsSync.mkdirSync(changed);
      } })).rejects.toMatchObject({ code: "path-mismatch" });
      expect(command).not.toHaveBeenCalled();
      const original = boundary === "root" ? path.join(preserved, "incoming", path.basename(source))
        : boundary === "source-parent" ? path.join(preserved, path.basename(source)) : source;
      expect(await fs.readFile(original, "utf8")).toBe("original A");
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a competitor introduced at atomic command dispatch", async () => {
      const { source, target, command, move } = await fixture();
      const perform = command.getMockImplementation()!;
      command.mockImplementation(input => { fsSync.writeFileSync(target, "competitor B", { flag: "wx" }); perform(input); });
      await expect(move()).rejects.toMatchObject({ code: "already-exists" });
      expect(command).toHaveBeenCalledOnce();
      expect(await fs.readFile(source, "utf8")).toBe("original A");
      expect(await fs.readFile(target, "utf8")).toBe("competitor B");
    }, 35_000);

    it("does not retry or roll back an unknown reply after rename", async () => {
      const { source, target, command, link, move } = await fixture();
      const perform = command.getMockImplementation()!;
      const failure = new FsSafeError("helper-failed", "reply lost", { details: { commit: "unknown" } });
      command.mockImplementation(input => { perform(input); throw failure; });
      const unlink = vi.spyOn(fsSync, "unlinkSync");
      await expect(move()).rejects.toBe(failure);
      expect(command).toHaveBeenCalledOnce(); expect(link).toHaveBeenCalledOnce(); expect(unlink).not.toHaveBeenCalled();
      expect(await fs.readFile(target, "utf8")).toBe("original A");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    }, 35_000);

    it.skipIf(backend !== "win32").each([false, true])("preserves a committed Windows failure (source close also fails=%s)", async closeFails => {
      const { source, target, command, move } = await fixture();
      const perform = command.getMockImplementation()!;
      const failure = new FsSafeError("helper-failed", "committed verification failed", { details: { commit: "committed" } });
      command.mockImplementation(input => { perform(input); throw failure; });
      const closeFailure = new Error("source close failed");
      const close = fsSync.closeSync.bind(fsSync);
      const closing = vi.spyOn(fsSync, "closeSync").mockImplementation(fd => { close(fd); if (closeFails) throw closeFailure; });
      const error = await move().catch(error => error);
      const operation = closeFails ? error.suppressed : error;
      expect(operation).toMatchObject({ cause: failure, details: { sourceConsumed: true, commit: "committed" } });
      if (closeFails) expect(error).toMatchObject({ name: "SuppressedError", error: { cause: closeFailure, details: { sourceConsumed: true } } });
      expect(closing).toHaveBeenCalledOnce();
      expect(await fs.readFile(target, "utf8")).toBe("original A");
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    }, 35_000);

    it.skipIf(backend !== "darwin" || actualPlatform !== "darwin" || process.getuid?.() === 0)("keeps write/search-only parent permissions sufficient for Darwin rename", async () => {
      const { sourceParent, targetParent, source, target, move } = await fixture();
      await fs.chmod(sourceParent, 0o300); await fs.chmod(targetParent, 0o300);
      try {
        expect(() => fsSync.openSync(sourceParent, fsSync.constants.O_RDONLY)).toThrow(expect.objectContaining({ code: "EACCES" }));
        await move();
        expect(await fs.readFile(target, "utf8")).toBe("original A");
        await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.stat(sourceParent)).mode & 0o777).toBe(0o300);
        expect((await fs.stat(targetParent)).mode & 0o777).toBe(0o300);
      } finally { await fs.chmod(sourceParent, 0o700); await fs.chmod(targetParent, 0o700); }
    }, 35_000);
  });
}
