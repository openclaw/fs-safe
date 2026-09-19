import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { stageFileInDirectory } from "../src/advanced.js";
import { assertNativeStaging, createNativeStage } from "../src/native-staged-file.js";
import { openStagedDirectory } from "../src/staged-directory.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
if (process.platform === "darwin" || process.platform === "linux") {
  try { native = __loadBundledNativeForTest(); }
  catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function observeStage() {
  let fd: number | undefined;
  let basename: string | undefined;
  const stat = fs.fstatSync;
  const removed: { size: number; mode: number }[] = [];
  const close = vi.fn(native!.closeOwnedFd);
  __setNativeLoaderForTest(() => ({
    ...native!, closeOwnedFd: close,
    createStagedFile(parent, name) {
      basename = name;
      fd = native!.createStagedFile!(parent, name);
      return fd;
    },
    removeStagedFile(parent, name, file) {
      const facts = stat(file);
      removed.push({ size: facts.size, mode: facts.mode & 0o7777 });
      return native!.removeStagedFile!(parent, name, file);
    },
  }));
  return {
    get fd() { return fd; }, get basename() { return basename; }, removed,
    expectClosed() {
      expect(fd).toBeTypeOf("number");
      expect(close.mock.calls.filter(([closed]) => closed === fd)).toHaveLength(1);
      expect(() => stat(fd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    },
  };
}

describe.runIf(native)("native private creation permission verification", () => {
  beforeEach(() => configureFsSafeNative({ mode: "require" }));

  it.each(["buffer", "atomic", "json", "stream"] as const)(
    "rejects %s privacy changes before stage chmod can repair them", async kind => {
      const directory = await tempRoot("fs-safe-native-private-prepare-");
      const scoped = await root(directory);
      const stage = observeStage();
      let changed = false, producerEntered = false;
      async function* bytes() { producerEntered = true; yield Buffer.from("private payload"); }
      const options = {
        private: true, mkdir: false, atomic: kind === "atomic",
        assertBeforeMutation() {
          if (stage.fd === undefined || changed) return;
          fs.fchmodSync(stage.fd, 0o644);
          changed = true;
        },
      };
      const result = kind === "json" ? scoped.createJson("target", { payload: "private" }, options)
        : scoped.create("target", kind === "stream" ? bytes() : "private payload", options);
      await expect(result).rejects.toMatchObject({ code: "insecure-permissions" });
      expect(changed).toBe(true);
      expect(producerEntered).toBe(false);
      expect(stage.removed).toEqual([{ size: 0, mode: 0o644 }]);
      stage.expectClosed();
      expect(fs.readdirSync(directory)).toEqual([]);
    },
  );

  it("accepts a restrictive umask before preparing private payload permissions", async () => {
    const directory = await tempRoot("fs-safe-native-private-umask-");
    const scoped = await root(directory);
    const previous = process.umask(0o777);
    try { await scoped.create("target", "private", { private: true, mkdir: false }); }
    finally { process.umask(previous); }
    expect(fs.statSync(path.join(directory, "target")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(directory, "target"), "utf8")).toBe("private");
  });

  it.each(["buffer", "atomic", "json", "stream"] as const)(
    "refuses %s bytes when successful chmod leaves broad permissions", async kind => {
      const directory = await tempRoot("fs-safe-native-private-unenforced-");
      const scoped = await root(directory);
      const stage = observeStage();
      const chmod = fs.fchmodSync;
      const chmodCalls = vi.spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
        chmod(fd, fd === stage.fd ? 0o777 : mode);
      });
      const write = vi.spyOn(fs, "write");
      let producerEntered = false;
      async function* bytes() { producerEntered = true; yield Buffer.from("private payload"); }
      const options = { private: true, mkdir: false, atomic: kind === "atomic" };
      const result = kind === "json" ? scoped.createJson("target", { payload: "private" }, options)
        : scoped.create("target", kind === "stream" ? bytes() : "private payload", options);
      await expect(result).rejects.toMatchObject({ code: "insecure-permissions" });
      expect(chmodCalls).toHaveBeenCalledWith(stage.fd, 0o600);
      expect(write).not.toHaveBeenCalled();
      expect(producerEntered).toBe(false);
      expect(stage.removed).toEqual([{ size: 0, mode: 0o777 }]);
      stage.expectClosed();
      expect(fs.readdirSync(directory)).toEqual([]);
    },
  );

  it("rejects a retained file owned by another user before writing", async () => {
    const directory = await tempRoot("fs-safe-native-private-owner-");
    const scoped = await root(directory);
    const stage = observeStage();
    const stat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options: unknown) => {
      const facts = Reflect.apply(stat, fs, [fd, options]);
      if (fd === stage.fd) facts.uid = typeof facts.uid === "bigint" ? facts.uid + 1n : facts.uid + 1;
      return facts;
    }) as typeof fs.fstatSync);
    await expect(scoped.create("target", "private payload", { private: true, mkdir: false }))
      .rejects.toMatchObject({ code: "not-owned" });
    expect(stage.removed).toEqual([{ size: 0, mode: 0o600 }]);
    stage.expectClosed();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("preserves a substituted stage and reports settled descriptor closure", async () => {
    const directory = await tempRoot("fs-safe-native-private-replacement-");
    const scoped = await root(directory);
    const stage = observeStage();
    const chmod = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
      chmod(fd, mode);
      if (fd !== stage.fd) return;
      chmod(fd, 0o777);
      const temporary = path.join(directory, stage.basename!);
      fs.renameSync(temporary, path.join(directory, "original"));
      fs.writeFileSync(temporary, "replacement sentinel");
    });
    await expect(scoped.create("target", "private payload", { private: true, mkdir: false }))
      .rejects.toMatchObject({
        code: "insecure-permissions",
        details: { phase: "prepare", publication: { status: "not-published" }, cleanup: { status: "preserved", resources: "closed" } },
      });
    stage.expectClosed();
    expect(fs.readFileSync(path.join(directory, stage.basename!), "utf8")).toBe("replacement sentinel");
    expect(fs.readFileSync(path.join(directory, "original"), "utf8")).toBe("");
    expect(fs.existsSync(path.join(directory, "target"))).toBe(false);
  });

  it("rechecks privacy after a paused producer before writing its next bytes", async () => {
    const directory = await tempRoot("fs-safe-native-private-stream-");
    const scoped = await root(directory);
    const stage = observeStage();
    let producerClosed = false;
    async function* payload() {
      try {
        yield Buffer.from("prefix");
        fs.fchmodSync(stage.fd!, 0o644);
        yield Buffer.from("must remain unwritten");
      } finally { producerClosed = true; }
    }
    await expect(scoped.create("target", payload(), { private: true, mkdir: false }))
      .rejects.toMatchObject({ code: "insecure-permissions" });
    expect(producerClosed).toBe(true);
    expect(stage.removed).toEqual([{ size: 6, mode: 0o644 }]);
    stage.expectClosed();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("rechecks privacy after the final publication callback", async () => {
    const directory = await tempRoot("fs-safe-native-private-publish-");
    const scoped = await root(directory);
    const stage = observeStage();
    const payload = "complete private payload";
    let changed = false;
    await expect(scoped.create("target", payload, {
      private: true, mkdir: false,
      assertBeforeMutation() {
        if (stage.fd !== undefined && fs.fstatSync(stage.fd).size === payload.length) {
          changed = true;
          fs.fchmodSync(stage.fd, 0o644);
        }
      },
    })).rejects.toMatchObject({ code: "insecure-permissions" });
    expect(changed).toBe(true);
    expect(stage.removed).toEqual([{ size: payload.length, mode: 0o644 }]);
    stage.expectClosed();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each([0, 0o400, 0o600, 0o700])("retains native private success with final mode %i", async mode => {
    const directory = await tempRoot("fs-safe-native-private-success-");
    const scoped = await root(directory);
    await scoped.create("target", "complete private payload", { private: true, mkdir: false, mode });
    const target = path.join(directory, "target");
    const facts = fs.statSync(target);
    expect(facts.mode & 0o7777).toBe(mode);
    expect(facts.uid).toBe(process.getuid!());
    fs.chmodSync(target, 0o600);
    expect(fs.readFileSync(target, "utf8")).toBe("complete private payload");
  });

  it("reports the published file when its restrictive final mode is not enforced", async () => {
    const directory = await tempRoot("fs-safe-native-private-final-mode-");
    const scoped = await root(directory);
    const stage = observeStage();
    const chmod = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
      if (fd !== stage.fd || mode !== 0o400) chmod(fd, mode);
    });
    await expect(scoped.create("target", "complete private payload", { private: true, mkdir: false, mode: 0o400 }))
      .rejects.toMatchObject({
        code: "insecure-permissions", details: { phase: "publish", publication: { status: "published", basename: "target" } },
      });
    expect(stage.removed).toEqual([]);
    stage.expectClosed();
    expect(fs.readdirSync(directory)).toEqual(["target"]);
    expect(fs.statSync(path.join(directory, "target")).mode & 0o7777).toBe(0o600);
    expect(fs.readFileSync(path.join(directory, "target"), "utf8")).toBe("complete private payload");
  });

  it("rejects an unenforced public stage mode before payload bytes", async () => {
    const directory = await tempRoot("fs-safe-stage-unenforced-mode-");
    const stage = observeStage();
    const chmod = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => chmod(fd, fd === stage.fd ? 0o644 : mode));
    await expect(stageFileInDirectory({ directory, content: "must remain unwritten" }))
      .rejects.toMatchObject({ code: "insecure-permissions" });
    expect(stage.removed).toEqual([{ size: 0, mode: 0o644 }]);
    stage.expectClosed();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("rejects public stage mode changes across application awaits", async () => {
    const directory = await tempRoot("fs-safe-stage-private-await-");
    const stage = observeStage();
    await using staged = await stageFileInDirectory({ directory, content: "staged payload", mode: 0o644 });
    fs.chmodSync(path.join(directory, staged.receipt.temporaryBasename), 0o644);
    await expect(staged.assertCurrent()).rejects.toMatchObject({ code: "insecure-permissions" });
    await expect(staged.publish("target", { overwrite: false })).rejects.toMatchObject({
      code: "insecure-permissions", details: { publication: { status: "not-published" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "removed", resources: "closed" });
    stage.expectClosed();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("reports public staging publication when the final mode is not enforced", async () => {
    const directory = await tempRoot("fs-safe-stage-final-mode-");
    const stage = observeStage();
    await using staged = await stageFileInDirectory({ directory, content: "complete payload", mode: 0o400 });
    const chmod = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
      if (fd !== stage.fd || mode !== 0o400) chmod(fd, mode);
    });
    await expect(staged.publish("target", { overwrite: false })).rejects.toMatchObject({
      code: "insecure-permissions", details: { publication: { status: "published", basename: "target" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "not-needed", resources: "closed" });
    stage.expectClosed();
    expect(fs.readFileSync(path.join(directory, "target"), "utf8")).toBe("complete payload");
    expect(fs.statSync(path.join(directory, "target")).mode & 0o7777).toBe(0o600);
  });

  it("preserves ordinary native creation on filesystems with advisory modes", async () => {
    const directory = await tempRoot("fs-safe-native-advisory-mode-");
    const scoped = await root(directory);
    const stage = observeStage();
    const chmod = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => chmod(fd, fd === stage.fd ? 0o644 : mode));
    await scoped.create("target", "ordinary payload", { mkdir: false });
    stage.expectClosed();
    expect(fs.statSync(path.join(directory, "target")).mode & 0o7777).toBe(0o644);
    expect(fs.readFileSync(path.join(directory, "target"), "utf8")).toBe("ordinary payload");
  });

  it.runIf(process.platform === "darwin")("keeps public staging mode-only without private-creation ACL admission", async () => {
    const directory = await tempRoot("fs-safe-stage-mode-only-");
    const inspect = vi.fn(() => { throw new Error("private creation ACL policy must not run"); });
    __setNativeLoaderForTest(() => ({ ...native!, inspectDarwinAcl: inspect }));
    await using staged = await stageFileInDirectory({ directory, content: "ordinary staged payload", mode: 0o644 });
    await staged.publish("target", { overwrite: false });
    expect(inspect).not.toHaveBeenCalled();
    expect(fs.statSync(path.join(directory, "target")).mode & 0o7777).toBe(0o644);
    expect(fs.readFileSync(path.join(directory, "target"), "utf8")).toBe("ordinary staged payload");
  });

  describe.each(["private-creation", "mode-only"] as const)("file inputs with %s policy", permissionPolicy => {
    it.each(["auto", "never"] as const)("verifies the empty stage before clone:%s can copy any bytes", async clone => {
      const directory = await tempRoot("fs-safe-stage-copy-permission-");
      const sourcePath = path.join(directory, "source");
      fs.writeFileSync(sourcePath, "private source payload");
      await using source = await fsAsync.open(sourcePath, "r");
      const parent = openStagedDirectory(directory);
      const removedBytes: number[] = [];
      const copy = vi.fn(native!.copyFileExclusive!);
      const close = vi.fn(native!.closeOwnedFd);
      const closeParent = vi.fn(fs.closeSync);
      const binding = {
        ...native!, copyFileExclusive: copy, closeOwnedFd: close,
        removeStagedFile(parentFd: number, name: string, fd: number) {
          removedBytes.push(fs.fstatSync(fd).size);
          return native!.removeStagedFile!(parentFd, name, fd);
        },
      };
      assertNativeStaging(binding);
      const chmod = fs.fchmodSync;
      vi.spyOn(fs, "fchmodSync").mockImplementation(fd => chmod(fd, 0o777));
      const read = vi.spyOn(source, "read");
      const write = vi.spyOn(fs, "write");
      await expect(createNativeStage(
        binding, parent.fd, closeParent, parent.receipt,
        { kind: "file", handle: source, size: 22, clone, verifySource: async () => undefined }, 0o600,
        undefined, true, true, undefined, undefined, false, permissionPolicy,
      )).rejects.toMatchObject({ code: "insecure-permissions" });
      expect(copy).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(removedBytes).toEqual([0]);
      expect(close).toHaveBeenCalledOnce();
      expect(closeParent).toHaveBeenCalledExactlyOnceWith(parent.fd);
      expect(() => fs.fstatSync(close.mock.calls[0]![0])).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(() => fs.fstatSync(parent.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(fs.readdirSync(directory)).toEqual(["source"]);
    });

    it("refuses required cloning before creating a stage or reading source bytes", async () => {
      const directory = await tempRoot("fs-safe-stage-required-clone-");
      const sourcePath = path.join(directory, "source");
      fs.writeFileSync(sourcePath, "source payload");
      await using source = await fsAsync.open(sourcePath, "r");
      const parent = openStagedDirectory(directory);
      const create = vi.fn(native!.createStagedFile!);
      const copy = vi.fn(native!.copyFileExclusive!);
      const binding = { ...native!, createStagedFile: create, copyFileExclusive: copy };
      assertNativeStaging(binding);
      const read = vi.spyOn(source, "read");
      await expect(createNativeStage(
        binding, parent.fd, fs.closeSync, parent.receipt,
        { kind: "file", handle: source, size: 14, clone: "always", verifySource: async () => undefined }, 0o600,
        undefined, true, true, undefined, undefined, false, permissionPolicy,
      ).then(async staged => { await staged.cleanup(); })).rejects.toMatchObject({ code: "helper-unavailable" });
      expect(create).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(() => fs.fstatSync(parent.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(fs.readdirSync(directory)).toEqual(["source"]);
    });

    it.each(["auto", "never"] as const)("copies admitted clone:%s input through the retained descriptor", async clone => {
      const directory = await tempRoot("fs-safe-stage-guarded-copy-");
      const sourcePath = path.join(directory, "source");
      const payload = Buffer.alloc(512 * 1024 + 17, 0x57);
      fs.writeFileSync(sourcePath, payload);
      await using source = await fsAsync.open(sourcePath, "r");
      const parent = openStagedDirectory(directory);
      const copy = vi.fn(native!.copyFileExclusive!);
      const binding = { ...native!, copyFileExclusive: copy };
      assertNativeStaging(binding);
      await using staged = await createNativeStage(
        binding, parent.fd, fs.closeSync, parent.receipt,
        { kind: "file", handle: source, size: payload.length, clone, verifySource: async () => undefined }, 0o400,
        payload.length, true, true, undefined, undefined, false, permissionPolicy,
      );
      expect(copy).not.toHaveBeenCalled();
      expect(fs.statSync(path.join(directory, staged.receipt.temporaryBasename)).mode & 0o7777).toBe(0o600);
      await staged.publish("target", { overwrite: false });
      expect(fs.readFileSync(path.join(directory, "target")).equals(payload)).toBe(true);
      expect(fs.statSync(path.join(directory, "target")).mode & 0o7777).toBe(0o400);
      expect((await source.readFile()).equals(payload)).toBe(true);
    });

    it.each(["budget", "abort", "permissions", "callback-abort", "callback-abort-and-permissions"] as const)("keeps the %s fence before transferred bytes", async fault => {
      const directory = await tempRoot("fs-safe-stage-copy-fence-");
      const sourcePath = path.join(directory, "source");
      fs.writeFileSync(sourcePath, "source payload");
      await using source = await fsAsync.open(sourcePath, "r");
      const parent = openStagedDirectory(directory);
      const controller = new AbortController();
      const aborted = new Error("copy cancelled after read");
      let targetFd: number | undefined;
      const removedBytes: number[] = [];
      const binding = {
        ...native!,
        createStagedFile(fd: number, name: string) {
          targetFd = native!.createStagedFile!(fd, name);
          return targetFd;
        },
        removeStagedFile(fd: number, name: string, target: number) {
          removedBytes.push(fs.fstatSync(target).size);
          return native!.removeStagedFile!(fd, name, target);
        },
      };
      assertNativeStaging(binding);
      const read = source.read;
      let readCompleted = false;
      const readSpy = vi.spyOn(source, "read").mockImplementation(async (...args: Parameters<typeof read>) => {
        const result = await Reflect.apply(read, source, args);
        readCompleted = true;
        if (fault === "abort") controller.abort(aborted);
        if (fault === "permissions") fs.fchmodSync(targetFd!, 0o644);
        return result;
      });
      const assertBeforeMutation = () => {
        if (!readCompleted || !fault.startsWith("callback-abort")) return;
        controller.abort(aborted);
        if (fault === "callback-abort-and-permissions") fs.fchmodSync(targetFd!, 0o644);
      };
      const write = vi.spyOn(fs, "write");
      const result = createNativeStage(
        binding, parent.fd, fs.closeSync, parent.receipt,
        { kind: "file", handle: source, size: 14, clone: "auto", signal: controller.signal, verifySource: async () => undefined }, 0o600,
        fault === "budget" ? 13 : undefined, true, true, assertBeforeMutation, undefined, false, permissionPolicy,
      );
      if (fault.includes("abort")) await expect(result).rejects.toBe(aborted);
      else await expect(result).rejects.toMatchObject({ code: fault === "budget" ? "too-large" : "insecure-permissions" });
      expect(write).not.toHaveBeenCalled();
      expect(removedBytes).toEqual([0]);
      expect(() => fs.fstatSync(targetFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(() => fs.fstatSync(parent.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(fs.readdirSync(directory)).toEqual(["source"]);
      readSpy.mockRestore();
      expect(await source.readFile()).toEqual(Buffer.from("source payload"));
    });
  });

  it("retains source verification before publishing a permission-checked file input", async () => {
    const directory = await tempRoot("fs-safe-private-copy-source-");
    const sourcePath = path.join(directory, "source");
    fs.writeFileSync(sourcePath, "source payload");
    await using source = await fsAsync.open(sourcePath, "r");
    const changed = new Error("admitted source changed");
    const verify = vi.fn(async () => { throw changed; });
    await expect(runPinnedWriteHelper({
      rootPath: directory, relativeParentPath: "", basename: "target", mkdir: false,
      mode: 0o600, private: true, overwrite: false,
      input: { kind: "file", handle: source, size: 14, clone: "auto", verifySource: verify },
    })).rejects.toBe(changed);
    expect(verify).toHaveBeenCalledOnce();
    expect(fs.readdirSync(directory)).toEqual(["source"]);
    expect(await source.readFile()).toEqual(Buffer.from("source payload"));
  });
});
