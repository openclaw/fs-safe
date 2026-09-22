import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root, type Root, type RootCreateOptions } from "../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import * as compatibility from "../src/root-write-compatibility.js";
import * as rootContext from "../src/root-context.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try { nativeAvailable = Boolean(__loadBundledNativeForTest()); }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
const modes = nativeAvailable ? ["off", "require"] as const : ["off"] as const;
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

const bufferedMethods = ["write", "writeJson", "create", "createJson"] as const;
type BufferedMethod = typeof bufferedMethods[number];
function buffered(scoped: Root, operation: BufferedMethod, options: { durable?: boolean; mode?: number }) {
  return operation.endsWith("Json")
    ? scoped[operation as "writeJson" | "createJson"]("target", { value: "payload" }, options)
    : scoped[operation as "write" | "create"]("target", "payload", options);
}
async function complete(directory: string, operation: BufferedMethod) {
  expect(await fs.readFile(path.join(directory, "target"), "utf8"))
    .toBe(operation.endsWith("Json") ? '{"value":"payload"}\n' : "payload");
  expect(await fs.readdir(directory)).toEqual(["target"]);
}
function denyFileSync(failure: Error) {
  const sync = fsSync.fsyncSync;
  vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
    if (fsSync.fstatSync(fd).isFile()) throw failure;
    sync(fd);
  });
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      if (fsSync.fstatSync(handle.fd).isFile()) throw failure;
      await sync();
    });
    return handle;
  });
}

for (const mode of modes) {
  describe(`Root write option ownership (native ${mode})`, () => {
    async function fixture() {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-private-write-options-");
      return { directory, scoped: await root(directory, { durable: false, maxBytes: 0 }) };
    }

    it.each(bufferedMethods)("%s ignores a stream byte cap in wider buffered options", async operation => {
      const { directory, scoped } = await fixture();
      const options = { durable: false, maxBytes: 0 };
      await buffered(scoped, operation, options);
      await complete(directory, operation);
    });

    it.each(["write", "writeJson"] as const)("%s does not select private creation from a wider options bag", async operation => {
      const { directory, scoped } = await fixture();
      const options = { durable: false, mode: 0o644, private: true };
      await buffered(scoped, operation, options);
      await complete(directory, operation);
      if (process.platform !== "win32") expect((await fs.stat(path.join(directory, "target"))).mode & 0o777).toBe(0o644);
    });

    it.each(["write", "writeJson"] as const)("%s ignores create-only atomic metadata", async operation => {
      const { directory, scoped } = await fixture();
      const options = { durable: false, atomic: "snapshot" };
      await buffered(scoped, operation, options);
      await complete(directory, operation);
    });

    it.skipIf(process.platform === "win32" && mode === "off").each(["write", "writeJson"] as const)("%s ignores strictFileSync on a pinned-writer route", async operation => {
      const { directory, scoped } = await fixture();
      const failure = Object.assign(new Error("file sync denied"), { code: "EPERM" });
      denyFileSync(failure);
      const options = { durable: true, strictFileSync: true };
      await buffered(scoped, operation, options);
      await complete(directory, operation);
    });

    it.each(["explicit", "default"] as const)("streamed create retains its %s byte cap", async budget => {
      const { directory, scoped } = await fixture();
      let returned = false;
      async function* content() { try { yield Buffer.from("payload"); } finally { returned = true; } }
      await expect(scoped.create("target", content(), budget === "explicit" ? { maxBytes: 0 } : {}))
        .rejects.toMatchObject({ code: "too-large" });
      expect(returned).toBe(true);
      expect(await fs.readdir(directory)).toEqual([]);
    });

    it("copyIn retains its public byte cap", async () => {
      const { directory, scoped } = await fixture();
      const sourceDirectory = await tempRoot("fs-safe-private-write-source-");
      const source = path.join(sourceDirectory, "input");
      await fs.writeFile(source, "payload");
      await expect(scoped.copyIn("target", source, { maxBytes: 0 })).rejects.toMatchObject({ code: "too-large" });
      expect(await fs.readFile(source, "utf8")).toBe("payload");
      expect(await fs.readdir(directory)).toEqual([]);
    });

    it.each(["create", "createJson"] as const)("%s retains its public private-creation policy", async operation => {
      const { directory, scoped } = await fixture();
      const options = { durable: false, private: true, mode: 0o644 };
      await expect(buffered(scoped, operation, options)).rejects.toMatchObject({ code: "insecure-permissions" });
      expect(await fs.readdir(directory)).toEqual([]);
    });

    it.each(["create", "createJson"] as const)("%s derives strict file sync from durable=file", async operation => {
      const { directory, scoped } = await fixture();
      const failure = Object.assign(new Error("required file sync denied"), { code: "EPERM" });
      denyFileSync(failure);
      const options = { durable: "file" as const, atomic: true, strictFileSync: false };
      const pending = operation === "create" ? scoped.create("target", "payload", options)
        : scoped.createJson("target", { value: "payload" }, options);
      await expect(pending).rejects.toSatisfy((error: Error) => error === failure || error.cause === failure);
      expect(await fs.readdir(directory)).toEqual([]);
    });

    it("keeps observation and thrown values from enumerable option getters", async () => {
      const { directory, scoped } = await fixture();
      const failure = new Error("metadata getter failed");
      const read = vi.fn(() => { throw failure; });
      const options = { durable: false, get maxBytes() { return read(); } };
      await expect(scoped.write("target", "payload", options)).rejects.toBe(failure);
      expect(read).toHaveBeenCalledOnce();
      expect(await fs.readdir(directory)).toEqual([]);
    });

    it("captures public creation options before pinned admission awaits", async () => {
      const { directory, scoped } = await fixture();
      const receivers: unknown[] = [];
      const options: RootCreateOptions = {
        atomic: true,
        durable: false,
        denyMutations: { paths: [path.join(directory, "blocked")] },
        get mode() { receivers.push(this); return 0o600; },
      };
      const admitted = vi.fn(() => {
        Object.defineProperty(options, "mode", {
          get() { throw new Error("public options must not be reread during pinned admission"); },
        });
      });
      __setFsSafeTestHooksForTest({ beforePinnedWriteParentAdmission: admitted });

      await scoped.create("target", "payload", options);

      expect(admitted).toHaveBeenCalled();
      expect(receivers).toHaveLength(1);
      expect(receivers[0]).toBe(options);
      await expect(fs.readFile(path.join(directory, "target"), "utf8")).resolves.toBe("payload");
      expect(await fs.readdir(directory)).toEqual(["target"]);
    });
  });
}

// On POSIX this models only Windows dispatch/admission. Stop at lock entry;
// real Windows lock/publication remains covered by the Windows platform suite.
describe("Root Windows compatibility admission option ownership", () => {
  it("does not select final-symlink admission through an extra option", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-resolver-symlink-option-");
    const scoped = await root(directory, { renameIdentity: "verify-content-with-lock" });
    const reachedLock = new Error("reached owned compatibility lock");
    vi.spyOn(compatibility, "withRootFallbackCompatibilityLock").mockRejectedValue(reachedLock);
    const resolution = vi.spyOn(rootContext, "resolvePathInRoot");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const options = { durable: false, allowFinalSymlink: true };
      await expect(scoped.write("target", "payload", options)).rejects.toBe(reachedLock);
      expect(resolution).toHaveBeenCalled();
      expect(resolution.mock.calls.some(([, , options]) => options?.allowFinalSymlink === true)).toBe(false);
    } finally { Object.defineProperty(process, "platform", platform); }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["write", "writeJson"] as const)("%s does not call a boolean private resolver field", async operation => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-resolver-option-");
    const scoped = await root(directory, { renameIdentity: "verify-content-with-lock" });
    const reachedLock = new Error("reached owned compatibility lock");
    const lock = vi.spyOn(compatibility, "withRootFallbackCompatibilityLock").mockRejectedValue(reachedLock);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const options = { mode: 0o600, shouldAssertNoPathAlias: false };
      await expect(buffered(scoped, operation, options)).rejects.toBe(reachedLock);
      expect(lock).toHaveBeenCalledWith(expect.objectContaining({ targetPath: path.join(directory, "target") }), expect.any(Function));
    } finally { Object.defineProperty(process, "platform", platform); }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("does not adopt a private ancestor-denial switch", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-resolver-ancestor-option-");
    const target = path.join(directory, "target");
    await fs.writeFile(target, "previous");
    const scoped = await root(directory, {
      renameIdentity: "verify-content-with-lock", denyMutations: { paths: [path.join(target, "reserved")] },
    });
    const reachedLock = new Error("reached owned compatibility lock");
    const lock = vi.spyOn(compatibility, "withRootFallbackCompatibilityLock").mockRejectedValue(reachedLock);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const options = { durable: false, protectDeniedAncestors: true };
      await expect(scoped.write("target", "payload", options)).rejects.toBe(reachedLock);
      expect(lock).toHaveBeenCalled();
    } finally { Object.defineProperty(process, "platform", platform); }
    expect(await fs.readFile(target, "utf8")).toBe("previous");
    expect(await fs.readdir(directory)).toEqual(["target"]);
  });
});
