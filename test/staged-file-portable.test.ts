import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageFileInDirectory } from "../src/advanced.js";
import { pinDirectory } from "../src/durability.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeFallbackWarningsForTest } from "../src/native-fallback-warning.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
  __resetNativeFallbackWarningsForTest();
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  __resetNativeFallbackWarningsForTest();
});

describe("portable staged ownership", () => {
  it.each(["", "snowman ☃", new Uint8Array([0, 255, 13, 10])])("retains exact prepared bytes %j and closes once", async (content) => {
    const directory = await tempRoot("fs-safe-node-stage-bytes-");
    const before = await fs.lstat(directory, { bigint: true });
    const warning = vi.mocked(process.emitWarning);
    const close = vi.spyOn(fsSync, "closeSync");
    const staged = await stageFileInDirectory({ directory, content });
    const temporary = path.join(directory, staged.receipt.temporaryBasename);
    expect(await fs.readFile(temporary)).toEqual(Buffer.from(content));
    const prepared = await fs.lstat(temporary, { bigint: true });
    expect(staged.receipt).toMatchObject({
      targeting: "guarded-pathname",
      directory: { identity: { dev: before.dev, ino: before.ino } },
      identity: { dev: prepared.dev, ino: prepared.ino, size: prepared.size, nlink: 1n },
    });
    if (process.platform !== "win32") expect(prepared.mode & 0o777n).toBe(0o600n);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("cleanup cannot follow a moved parent directory"),
      { code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning" },
    );
    const cleanup = await staged.cleanup();
    expect(cleanup).toMatchObject({ status: "removed", resources: "closed", targeting: "guarded-pathname" });
    expect(await staged.cleanup()).toEqual(cleanup);
    await staged[Symbol.asyncDispose]();
    expect(close).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each([false, true])("publishes an independent final name with overwrite=%s", async (overwrite) => {
    const directory = await tempRoot("fs-safe-node-stage-publish-");
    const final = path.join(directory, "final");
    if (overwrite) await fs.writeFile(final, "old");
    await using staged = await stageFileInDirectory({ directory, content: "published bytes", mode: 0o640 });
    const receipt = await staged.publish("final", { overwrite });
    expect(receipt).toMatchObject({ status: "published", method: overwrite ? "rename" : "link-unlink" });
    expect(await fs.readFile(final, "utf8")).toBe("published bytes");
    const actual = await fs.lstat(final, { bigint: true });
    expect(actual).toMatchObject({ dev: staged.receipt.identity.dev, ino: staged.receipt.identity.ino, nlink: 1n });
    if (process.platform !== "win32") expect(actual.mode & 0o777n).toBe(0o640n);
    expect(await staged.cleanup()).toMatchObject({ status: "not-needed", publication: receipt });
    expect(await fs.readdir(directory)).toEqual(["final"]);
  });

  it.each(["file", "directory"])("preserves a no-replace %s collision and permits retry", async (kind) => {
    const directory = await tempRoot("fs-safe-node-stage-collision-");
    const final = path.join(directory, "final");
    if (kind === "directory") {
      await fs.mkdir(final);
      await fs.writeFile(path.join(final, "sentinel"), "unchanged");
    } else await fs.writeFile(final, "unchanged");
    const before = await fs.lstat(final, { bigint: true });
    await using staged = await stageFileInDirectory({ directory, content: "new" });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      code: "already-exists", details: { publication: { status: "not-published" } },
    });
    expect(await fs.lstat(final, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
    expect(await fs.readFile(kind === "directory" ? path.join(final, "sentinel") : final, "utf8")).toBe("unchanged");
    await staged.assertCurrent();
    await staged.publish("other", { overwrite: false });
    expect(await fs.readFile(path.join(directory, "other"), "utf8")).toBe("new");
  });

  it.each(["replacement", "rename-only", "ancestor"])("preserves the original and replacement sentinels after %s drift", async (kind) => {
    const base = await tempRoot("fs-safe-node-stage-drift-");
    const ancestor = path.join(base, "ancestor");
    const directory = path.join(ancestor, "parent");
    await fs.mkdir(directory, { recursive: true });
    const staged = await stageFileInDirectory({ directory, content: "owned" });
    const name = staged.receipt.temporaryBasename;
    const moved = path.join(base, "moved");
    await fs.rename(kind === "ancestor" ? ancestor : directory, moved);
    const original = kind === "ancestor" ? path.join(moved, "parent") : moved;
    if (kind !== "rename-only") {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, name), "stage sentinel");
      await fs.writeFile(path.join(directory, "final"), "final sentinel");
    }
    await expect(staged.assertCurrent()).rejects.toBeTruthy();
    await expect(staged.publish("final", { overwrite: true })).rejects.toMatchObject({
      details: { publication: { status: "not-published" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "preserved", resources: "closed", targeting: "guarded-pathname" });
    await expect(staged[Symbol.asyncDispose]()).rejects.toMatchObject({ code: "not-removable" });
    expect(await fs.readFile(path.join(original, name), "utf8")).toBe("owned");
    if (kind !== "rename-only") {
      expect(await fs.readFile(path.join(directory, name), "utf8")).toBe("stage sentinel");
      expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("final sentinel");
    }
  });

  it.each(["regular", "hardlink", "absent"])("preserves an observed %s stage substitution or reports absence", async (kind) => {
    const directory = await tempRoot("fs-safe-node-stage-substitution-");
    const victim = path.join(directory, "victim");
    await fs.writeFile(victim, "victim");
    const staged = await stageFileInDirectory({ directory, content: "owned" });
    const temporary = path.join(directory, staged.receipt.temporaryBasename);
    await fs.rename(temporary, path.join(directory, "retired"));
    if (kind === "regular") await fs.writeFile(temporary, "substitute");
    if (kind === "hardlink") await fs.link(victim, temporary);
    await expect(staged.publish("final", { overwrite: true })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(await staged.cleanup()).toMatchObject({ status: kind === "absent" ? "name-absent" : "preserved" });
    expect(await fs.readFile(victim, "utf8")).toBe("victim");
    expect(await fs.readFile(path.join(directory, "retired"), "utf8")).toBe("owned");
    if (kind !== "absent") expect(await fs.readFile(temporary, "utf8")).toBe(kind === "regular" ? "substitute" : "victim");
  });

  it("records publication before a failed stage unlink and later cleans only its temporary name", async () => {
    const directory = await tempRoot("fs-safe-node-stage-linked-");
    const staged = await stageFileInDirectory({ directory, content: "published", mode: 0o644 });
    const temporary = path.join(directory, staged.receipt.temporaryBasename);
    const final = path.join(directory, "final");
    const denied = Object.assign(new Error("stage unlink denied"), { code: "EACCES" });
    vi.spyOn(fsSync, "unlinkSync").mockImplementationOnce(() => { throw denied; });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      cause: denied, details: { publication: { status: "published", basename: "final", method: "link-unlink" } },
    });
    expect(await fs.readFile(final, "utf8")).toBe("published");
    expect((await fs.lstat(temporary, { bigint: true })).nlink).toBe(2n);
    if (process.platform !== "win32") expect((await fs.lstat(final)).mode & 0o777).toBe(0o600);
    expect(await staged.cleanup()).toMatchObject({ status: "removed", publication: { status: "published" }, resources: "closed" });
    expect(await fs.readdir(directory)).toEqual(["final"]);
    expect((await fs.lstat(final, { bigint: true })).nlink).toBe(1n);
    await staged[Symbol.asyncDispose]();
  });

  it("preserves a substituted temporary name after successful link publication", async () => {
    const directory = await tempRoot("fs-safe-node-stage-linked-substitute-");
    const staged = await stageFileInDirectory({ directory, content: "published" });
    const temporary = path.join(directory, staged.receipt.temporaryBasename);
    const link = fsSync.linkSync;
    vi.spyOn(fsSync, "linkSync").mockImplementation((from, to) => {
      link(from, to);
      fsSync.renameSync(temporary, path.join(directory, "retired"));
      fsSync.writeFileSync(temporary, "sentinel");
    });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      code: "path-mismatch", details: { publication: { status: "published" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "preserved", publication: { status: "published" } });
    expect(await fs.readFile(temporary, "utf8")).toBe("sentinel");
    expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("published");
    expect(await fs.readFile(path.join(directory, "retired"), "utf8")).toBe("published");
  });

  it("records link publication while preserving both parents after subsequent directory drift", async () => {
    const base = await tempRoot("fs-safe-node-stage-linked-parent-");
    const directory = path.join(base, "parent");
    const moved = path.join(base, "moved");
    await fs.mkdir(directory);
    const staged = await stageFileInDirectory({ directory, content: "published" });
    const temporary = staged.receipt.temporaryBasename;
    const link = fsSync.linkSync;
    vi.spyOn(fsSync, "linkSync").mockImplementation((from, to) => {
      link(from, to);
      fsSync.renameSync(directory, moved);
      fsSync.mkdirSync(directory);
      fsSync.writeFileSync(path.join(directory, temporary), "temporary sentinel");
      fsSync.writeFileSync(path.join(directory, "final"), "final sentinel");
    });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      code: "path-mismatch", details: { publication: { status: "published" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "preserved", publication: { status: "published" }, resources: "closed" });
    expect(await fs.readFile(path.join(moved, temporary), "utf8")).toBe("published");
    expect(await fs.readFile(path.join(moved, "final"), "utf8")).toBe("published");
    expect(await fs.readFile(path.join(directory, temporary), "utf8")).toBe("temporary sentinel");
    expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("final sentinel");
  });

  it("preserves names when a link reports an indeterminate result", async () => {
    const directory = await tempRoot("fs-safe-node-stage-indeterminate-");
    const staged = await stageFileInDirectory({ directory, content: "published" });
    const link = fsSync.linkSync;
    vi.spyOn(fsSync, "linkSync").mockImplementation((from, to) => {
      link(from, to);
      throw Object.assign(new Error("link reply lost"), { code: "EIO" });
    });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      details: { publication: { status: "indeterminate", basename: "final" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "preserved", resources: "closed" });
    expect((await fs.readdir(directory)).sort()).toEqual([staged.receipt.temporaryBasename, "final"].sort());
    expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("published");
  });

  it("uses an atomic system rename when the filesystem cannot link", async () => {
    const directory = await tempRoot("fs-safe-node-stage-no-hardlinks-");
    await using staged = await stageFileInDirectory({ directory, content: "owned" });
    const rename = vi.spyOn(fsSync, "renameSync");
    vi.spyOn(fsSync, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("hardlinks unsupported"), { code: "ENOTSUP" });
    });
    expect(await staged.publish("final", { overwrite: false })).toMatchObject({
      status: "published", method: "rename", staged: { targeting: "guarded-pathname" },
    });
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.lstat(path.join(directory, "final"), { bigint: true })).toMatchObject({
      dev: staged.receipt.identity.dev, ino: staged.receipt.identity.ino, nlink: 1n,
    });
    expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("owned");
    expect(await staged.cleanup()).toMatchObject({ status: "not-needed" });
    expect(await fs.readdir(directory)).toEqual(["final"]);
  }, 30_000);

  it.skipIf(process.platform === "win32").each([0o000, 0o400, 0o640])("applies mode %o through the retained descriptor without reopening the leaf", async (mode) => {
    const directory = await tempRoot("fs-safe-node-stage-mode-");
    await using staged = await stageFileInDirectory({ directory, content: "private", mode });
    const open = vi.spyOn(fsSync, "openSync");
    await staged.publish("final", { overwrite: false });
    expect(open).not.toHaveBeenCalled();
    const final = path.join(directory, "final");
    expect((await fs.lstat(final)).mode & 0o777).toBe(mode);
    await fs.chmod(final, 0o600);
    expect(await fs.readFile(final, "utf8")).toBe("private");
  });

  it("snapshots supplied receipt facts and rejects a stale receipt before creation", async () => {
    const directory = await tempRoot("fs-safe-node-stage-receipt-");
    const other = await tempRoot("fs-safe-node-stage-other-");
    const pinned = await pinDirectory(directory);
    try {
      const supplied = pinned.receipt;
      await using staged = await stageFileInDirectory({ directory: supplied, content: "owned" });
      supplied.path = other;
      supplied.realPath = other;
      supplied.identity.ino = 1;
      expect(Reflect.set(staged.receipt, "targeting", "descriptor-relative")).toBe(false);
      await staged.assertCurrent();
      await staged.publish("final", { overwrite: true });
      expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("owned");
      await expect(stageFileInDirectory({ directory: supplied, content: "bad" })).rejects.toMatchObject({ code: "path-mismatch" });
      expect(await fs.readdir(other)).toEqual([]);
    } finally {
      await pinned.close();
    }
  });

  it("serializes publication and cleanup, retaining Node ownership after mode changes", async () => {
    const directory = await tempRoot("fs-safe-node-stage-close-");
    const staged = await stageFileInDirectory({ directory, content: "owned" });
    const nativeClose = vi.fn();
    __setNativeLoaderForTest(() => ({ closeOwnedFd: nativeClose } as never));
    configureFsSafeNative({ mode: "auto" });
    const outcomes = await Promise.allSettled([
      staged.publish("final", { overwrite: false }), staged.assertCurrent(), staged.cleanup(), staged.cleanup(),
    ]);
    expect(outcomes.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect(nativeClose).not.toHaveBeenCalled();
    const unrelated = await fs.open(path.join(directory, "unrelated"), "w+");
    try {
      await expect(staged.publish("unrelated", { overwrite: true })).rejects.toMatchObject({
        details: { publication: { status: "published" } },
      });
      await staged[Symbol.asyncDispose]();
      await unrelated.writeFile("untouched");
      expect(await fs.readFile(path.join(directory, "unrelated"), "utf8")).toBe("untouched");
    } finally {
      await unrelated.close();
    }
  });

  it.each([false, true])("transfers the verified Windows sibling before closing the temporary descriptor (close failure=%s)", async (failClose) => {
    const directory = await tempRoot("fs-safe-node-stage-windows-transfer-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const open = fsSync.openSync;
    const close = fsSync.closeSync;
    const unlink = fsSync.unlinkSync;
    let temporaryFd: number | undefined;
    let publishedFd: number | undefined;
    let temporaryCloses = 0;
    let publishedCloses = 0;
    const events: string[] = [];
    vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
      const fd = open(pathname, flags, mode);
      const name = String(pathname);
      if (path.basename(name).startsWith(".fs-safe-")) temporaryFd = fd;
      if (name === path.join(directory, "final")) {
        publishedFd = fd;
        events.push("open published");
        expect(flags).toBe(fsSync.constants.O_WRONLY);
      }
      return fd;
    });
    vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
      const file = fsSync.fstatSync(fd).isFile();
      close(fd);
      if (file && fd === temporaryFd) {
        temporaryCloses++;
        events.push("close temporary");
        expect(publishedFd).toBeTypeOf("number");
        if (failClose) throw Object.assign(new Error("temporary descriptor closed before error"), { code: "EIO" });
      }
      if (file && fd === publishedFd) {
        publishedCloses++;
        events.push("close published");
      }
    });
    vi.spyOn(fsSync, "unlinkSync").mockImplementation((pathname) => {
      events.push("unlink temporary");
      unlink(pathname);
    });
    const staged = await stageFileInDirectory({ directory, content: "owned" });
    if (failClose) {
      await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
        cause: { code: "EIO" }, details: { publication: { status: "published" } },
      });
    } else await staged.publish("final", { overwrite: false });
    expect(await staged.cleanup()).toMatchObject({ status: failClose ? "removed" : "not-needed", resources: "closed" });
    expect(events).toEqual(["open published", "close temporary", "unlink temporary", "close published"]);
    expect(temporaryCloses).toBe(1);
    expect(publishedCloses).toBe(1);
    await staged[Symbol.asyncDispose]();
    expect(await fs.readdir(directory)).toEqual(["final"]);
    expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("owned");
  });

  it("rejects Windows device and filename aliases before publication", async () => {
    const directory = await tempRoot("fs-safe-node-stage-windows-names-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await using staged = await stageFileInDirectory({ directory, content: "owned" });
    const link = vi.spyOn(fsSync, "linkSync");
    const rename = vi.spyOn(fsSync, "renameSync");
    for (const name of ["CON", "NUL.txt", "file.", "file ", "file:stream", "bad?name"]) {
      await expect(staged.publish(name, { overwrite: false })).rejects.toMatchObject({ code: "invalid-path" });
    }
    expect(link).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    await staged.assertCurrent();
    expect(await staged.cleanup()).toMatchObject({ status: "removed" });
  });
});
