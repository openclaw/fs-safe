import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root, type RootCopyPublicationReceipt } from "../src/index.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.skipIf(!native)("Root.copyIn Windows native publication", () => {
  it("retains a raced winner and an atomic-create admission close failure", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => native!);
    const directory = await tempRoot("fs-safe-create-windows-admission-");
    const target = path.join(directory, "target");
    const scoped = await root(directory);
    const closeFailure = new Error("admission close reported failure");
    let parentFd: number | undefined;
    __setNativeLoaderForTest(() => ({
      ...native!,
      openBeneath(...args) {
        const result = native!.openBeneath(...args);
        parentFd = result.fd;
        fsSync.writeFileSync(target, "winner", { flag: "wx" });
        return result;
      },
      closeOwnedFd(fd) { native!.closeOwnedFd(fd); throw closeFailure; },
    }));
    const handles: FileHandle[] = [];
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      handles.push(handle);
      return handle;
    });

    const error = await scoped.create("target", "replacement", { atomic: true }).catch((error: unknown) => error);
    expect(error).toMatchObject({ cause: expect.any(AggregateError) });
    expect(((error as Error).cause as AggregateError).errors).toEqual([
      expect.objectContaining({ code: "EEXIST" }), closeFailure,
    ]);
    expect(parentFd).toBeDefined();
    expect(() => fsSync.fstatSync(parentFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    for (const handle of handles) expect(handle.fd).toBe(-1);
    expect(await fs.readFile(target, "utf8")).toBe("winner");
    expect(await fs.readdir(directory)).toEqual(["target"]);
  });

  it.each([false, true].flatMap(overwrite =>
    (["chmod", "sync"] as const).map(fault => ({ overwrite, fault }))))(
    "preserves the published copy after $fault fails (overwrite=$overwrite)",
    async ({ overwrite, fault }) => {
      // Exercise this writer with real descriptor operations on every native host;
      // Windows CI supplies the platform-specific binding and permission semantics.
      Object.defineProperty(process, "platform", { value: "win32" });
      configureFsSafeNative({ mode: "require" });
      const opened: number[] = [];
      const close = vi.fn((fd: number) => native!.closeOwnedFd(fd));
      __setNativeLoaderForTest(() => ({
        ...native!,
        closeOwnedFd: close,
        openBeneath(...args) {
          const result = native!.openBeneath(...args);
          opened.push(result.fd);
          return result;
        },
      }));
      const directory = await tempRoot("fs-safe-copy-windows-publication-");
      const source = path.join(directory, "source");
      const target = path.join(directory, "target");
      await fs.writeFile(source, "complete source");
      if (overwrite) await fs.writeFile(target, "previous destination");
      const scoped = await root(directory);
      let admitted: FileHandle | undefined;
      __setFsSafeTestHooksForTest({
        afterOpen(candidate, handle) { if (candidate === source) admitted = handle; },
      });
      const failure = Object.assign(new Error(`published ${fault} failed`), { code: "EIO" });
      let receipt: RootCopyPublicationReceipt | undefined;
      const chmod = fsSync.fchmodSync.bind(fsSync);
      vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
        if (receipt && fault === "chmod") throw failure;
        chmod(fd, mode);
      });
      const sync = fsSync.fsyncSync.bind(fsSync);
      vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
        if (receipt && fault === "sync" && fsSync.fstatSync(fd).isFile()) throw failure;
        sync(fd);
      });

      await expect(scoped.copyIn("target", source, {
        overwrite,
        mode: 0o400,
        onDestinationPublished: value => { receipt = value; },
      })).rejects.toMatchObject({ cause: failure });

      expect(receipt).toBeDefined();
      expect(admitted?.fd).toBe(-1);
      for (const fd of opened) expect(close).toHaveBeenCalledWith(fd);
      const current = await fs.stat(target, { bigint: true });
      expect(receipt).toEqual({ path: target, dev: current.dev, ino: current.ino });
      expect(await fs.readFile(target, "utf8")).toBe("complete source");
      expect(await fs.readFile(source, "utf8")).toBe("complete source");
      expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
    },
  );
});

describe.skipIf(!native)("atomic Root.create Windows native publication", () => {
  it.each([
    { boundary: "stage", failProbeClose: false },
    { boundary: "parent", failProbeClose: false },
    { boundary: "stage", failProbeClose: true },
  ] as const)("rejects a replaced $boundary before publishing (probe close failure=$failProbeClose)", async ({ boundary, failProbeClose }) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    configureFsSafeNative({ mode: "require" });
    const opened: number[] = [];
    const closeFailure = new Error("stage probe close reported failure");
    let substituted: string | undefined;
    let stageName: string | undefined;
    let probeFd: number | undefined;
    const close = vi.fn((fd: number) => {
      native!.closeOwnedFd(fd);
      if (failProbeClose && fd === probeFd) throw closeFailure;
    });
    __setNativeLoaderForTest(() => ({
      ...native!,
      closeOwnedFd: close,
      openBeneath(...args) {
        const result = native!.openBeneath(...args);
        opened.push(result.fd);
        if (substituted && args[1] === stageName &&
          (args[2] & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0) probeFd = result.fd;
        return result;
      },
    }));
    const directory = await tempRoot("fs-safe-create-windows-stage-swap-");
    const parent = path.join(directory, "parent");
    await fs.mkdir(parent);
    const target = path.join(parent, "target");
    const retained = path.join(directory, "retained");
    const scoped = await root(directory);
    const handles: FileHandle[] = [];
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      handles.push(handle);
      return handle;
    });
    const content = "complete content";

    const error = await scoped.create("parent/target", content, {
      atomic: true, durable: false,
      assertBeforeMutation() {
        if (substituted) return;
        const name = fsSync.readdirSync(parent).find(entry => entry.startsWith(".fs-safe-"));
        if (!name) return;
        const stage = path.join(parent, name);
        if (fsSync.statSync(stage).size !== Buffer.byteLength(content)) return;
        stageName = name;
        if (boundary === "parent") {
          fsSync.renameSync(parent, retained);
          fsSync.mkdirSync(parent);
          substituted = path.join(parent, "sentinel");
        } else {
          fsSync.renameSync(stage, retained);
          substituted = stage;
        }
        fsSync.writeFileSync(substituted, "substituted bytes", { flag: "wx" });
      },
    }).catch((failure: unknown) => failure);

    expect(substituted).toBeDefined();
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(error).toMatchObject({
      details: {
        publication: { status: "not-published" },
        cleanup: { status: "preserved" },
      },
    });
    if (failProbeClose) {
      expect(probeFd).toBeDefined();
      expect(error).toMatchObject({
        cause: expect.any(AggregateError),
        details: { cleanup: { resources: "close-failed" } },
      });
      expect(((error as Error).cause as AggregateError).errors).toEqual([
        expect.objectContaining({ code: "path-mismatch" }), closeFailure,
      ]);
    } else {
      expect(error).toMatchObject({ code: "path-mismatch", details: { cleanup: { resources: "closed" } } });
    }
    expect(opened.length).toBeGreaterThan(0);
    for (const fd of opened) {
      expect(close).toHaveBeenCalledWith(fd);
      expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    }
    for (const handle of handles) expect(handle.fd).toBe(-1);
    const retainedStage = boundary === "parent" ? path.join(retained, stageName!) : retained;
    expect(await fs.readFile(retainedStage, "utf8")).toBe(content);
    expect(await fs.readFile(substituted!, "utf8")).toBe("substituted bytes");
    expect(await fs.readdir(parent)).toEqual([path.basename(substituted!)]);
    expect((await fs.readdir(directory)).sort()).toEqual(["parent", "retained"]);
    if (boundary === "parent") expect(await fs.readdir(retained)).toEqual([stageName]);
  });

  it("uses native descriptor identity when the staged pathname reports zero identity", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => native!);
    const directory = await tempRoot("fs-safe-create-windows-opaque-stage-");
    const scoped = await root(directory);
    const opened: number[] = [];
    const close = vi.fn((fd: number) => native!.closeOwnedFd(fd));
    __setNativeLoaderForTest(() => ({
      ...native!,
      closeOwnedFd: close,
      openBeneath(...args) {
        const result = native!.openBeneath(...args);
        opened.push(result.fd);
        return result;
      },
    }));
    let opaqueStage: string | undefined;
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const stat = lstat(...args);
      if (String(args[0]) !== opaqueStage) return stat;
      return Object.assign(Object.create(stat), {
        dev: typeof stat.dev === "bigint" ? 0n : 0,
        ino: typeof stat.ino === "bigint" ? 0n : 0,
      });
    }) as typeof fsSync.lstatSync);
    const content = "complete content";

    await scoped.create("target", content, {
      atomic: true, durable: false,
      assertBeforeMutation() {
        if (opaqueStage) return;
        const name = fsSync.readdirSync(directory).find(entry => entry.startsWith(".fs-safe-"));
        if (!name) return;
        const stage = path.join(directory, name);
        if (fsSync.statSync(stage).size === Buffer.byteLength(content)) opaqueStage = stage;
      },
    });

    expect(opaqueStage).toBeDefined();
    for (const fd of opened) {
      expect(close).toHaveBeenCalledWith(fd);
      expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    }
    const target = path.join(directory, "target");
    expect(await fs.readFile(target, "utf8")).toBe(content);
    expect((await fs.stat(target)).nlink).toBe(1);
    expect(await fs.readdir(directory)).toEqual(["target"]);
  });

  it.each([
    { fault: "chmod", durable: true, code: "EIO" },
    { fault: "sync", durable: true, code: "EIO" },
    { fault: "rename-reply", durable: true, code: "EIO" },
    { fault: "sync", durable: "file", code: "EPERM" },
  ] as const)(
    "preserves complete content and settles owned descriptors after $fault fails (durable=$durable)",
    async ({ fault, durable, code }) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      configureFsSafeNative({ mode: "require" });
      const failure = Object.assign(new Error(`published ${fault} failed`), { code });
      const opened: number[] = [];
      let published = false;
      __setNativeLoaderForTest(() => ({
        ...native!,
        openBeneath(...args) {
          const result = native!.openBeneath(...args);
          opened.push(result.fd);
          return result;
        },
        renameNoReplace(...args) {
          native!.renameNoReplace(...args);
          published = true;
          if (fault === "rename-reply") throw failure;
        },
      }));
      const directory = await tempRoot("fs-safe-create-windows-publication-");
      const scoped = await root(directory);
      const handles: FileHandle[] = [];
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        handles.push(handle);
        return handle;
      });
      const chmod = fsSync.fchmodSync.bind(fsSync);
      vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
        if (published && fault === "chmod") throw failure;
        chmod(fd, mode);
      });
      const sync = fsSync.fsyncSync.bind(fsSync);
      vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
        if (published && fault === "sync" && fsSync.fstatSync(fd).isFile()) throw failure;
        sync(fd);
      });

      await expect(scoped.create("target", "complete content", {
        atomic: true, mode: 0o400, durable,
      })).rejects.toMatchObject({
        cause: failure,
        details: {
          phase: "publish",
          publication: {
            status: fault === "rename-reply" ? "indeterminate" : "published",
            basename: "target", overwrite: false,
          },
          cleanup: {
            status: fault === "rename-reply" ? "preserved" : "not-needed",
            resources: "closed",
          },
        },
      });

      expect(published).toBe(true);
      expect(opened.length).toBeGreaterThan(0);
      for (const fd of opened) {
        expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      }
      expect(handles.length).toBeGreaterThan(0);
      for (const handle of handles) expect(handle.fd).toBe(-1);
      const target = path.join(directory, "target");
      expect(await fs.readFile(target, "utf8")).toBe("complete content");
      expect((await fs.stat(target)).nlink).toBe(1);
      expect(await fs.readdir(directory)).toEqual(["target"]);
    },
  );
});
