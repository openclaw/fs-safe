import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import {
  runOwnedPinnedWrite,
  runOwnedPinnedWriteWithRenamePolicy,
} from "../src/pinned-write.js";
import type { PinnedWriteParams } from "../src/pinned-write-types.js";
import { realpathSync } from "../src/realpath.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const aliasError = {
  code: "invalid-path",
  details: { reason: "windows-path-alias" },
};

let bundledNative: NativeBinding | undefined;
try {
  bundledNative = __loadBundledNativeForTest();
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

function baseParams(overrides: Partial<PinnedWriteParams> = {}): PinnedWriteParams {
  return {
    rootPath: "C:\\safe",
    relativeParentPath: "",
    basename: "value",
    mkdir: false,
    mode: 0o600,
    overwrite: false,
    input: { kind: "buffer", data: "payload" },
    ...overrides,
  };
}

describe.skipIf(process.platform !== "win32")("pinned write Windows pathname admission", () => {
  it.each([
    {
      label: "root alias erased by normalization",
      params: (root: string) => ({ rootPath: `${root}\\scope:stream\\..` }),
      expected: aliasError,
    },
    {
      label: "relative parent stream",
      params: () => ({ relativeParentPath: "child:stream" }),
      expected: aliasError,
    },
    {
      label: "basename stream",
      params: () => ({ basename: "value:stream" }),
      expected: aliasError,
    },
    {
      label: "backslash-bearing basename",
      params: () => ({ basename: "nested\\value" }),
      expected: { code: "invalid-path", message: "invalid target path" },
    },
  ])("rejects $label before backend selection or mutation", async ({ params, expected }) => {
    const root = await tempRoot("fs-safe-pinned-admission-");
    const loader = vi.fn(() => {
      throw new Error("native loader must not run for rejected input");
    });
    const assertBeforeMutation = vi.fn();
    const onPublished = vi.fn();
    let consumed = 0;
    const stream = (async function* () {
      consumed += 1;
      yield Buffer.from("unexpected");
    })();
    const open = vi.spyOn(fs, "open");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    __setNativeLoaderForTest(loader);
    configureFsSafeNative({ mode: "require" });

    await expect(runOwnedPinnedWrite(baseParams({
      rootPath: root,
      input: { kind: "stream", stream },
      assertBeforeMutation,
      onPublished,
      ...params(root),
    }))).rejects.toMatchObject(expected);

    expect(loader).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(assertBeforeMutation).not.toHaveBeenCalled();
    expect(onPublished).not.toHaveBeenCalled();
    expect(consumed).toBe(0);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("preserves validation precedence before backend selection", async () => {
    const loader = vi.fn(() => {
      throw new Error("native loader must not run for rejected input");
    });
    __setNativeLoaderForTest(loader);
    configureFsSafeNative({ mode: "require" });

    await expect(runOwnedPinnedWrite(baseParams({
      rootPath: "C:\\root:hidden",
      relativeParentPath: "../outside:stream",
      basename: "bad/name:stream",
      maxBytes: -1,
    }))).rejects.toBeInstanceOf(RangeError);
    await expect(runOwnedPinnedWrite(baseParams({
      rootPath: "C:\\root:hidden",
      relativeParentPath: "../outside:stream",
      basename: "bad/name:stream",
    }))).rejects.toMatchObject({ code: "invalid-path", message: "invalid target path" });
    await expect(runOwnedPinnedWrite(baseParams({
      rootPath: "C:\\root:hidden",
      relativeParentPath: "../outside:stream",
      basename: "value:stream",
    }))).rejects.toMatchObject({
      code: "invalid-path",
      message: "relative path must not escape root",
    });
    await expect(runOwnedPinnedWrite(baseParams({
      rootPath: "C:\\root:hidden",
      relativeParentPath: "parent:stream",
      basename: "value:stream",
    }))).rejects.toMatchObject({
      ...aliasError,
      message: "pinned write root uses a Windows filesystem namespace alias",
    });
    await expect(runOwnedPinnedWrite(baseParams({
      rootPath: "C:\\root",
      relativeParentPath: "parent:stream",
      basename: "value:stream",
    }))).rejects.toMatchObject({
      ...aliasError,
      message: "pinned write parent uses a Windows filesystem namespace alias",
    });

    expect(loader).not.toHaveBeenCalled();
  });

  it.runIf(bundledNative !== undefined).each(["succeeds", "fails"] as const)(
    "rejects a native canonical parent alias before pathname inspection or staging when close %s",
    async (closeOutcome) => {
      const root = await tempRoot("fs-safe-pinned-canonical-");
      const binding = bundledNative!;
      const parentFds: number[] = [];
      const rootFds: number[] = [];
      const openBeneath = vi.fn((...args: Parameters<NativeBinding["openBeneath"]>) => {
        const opened = binding.openBeneath(...args);
        parentFds.push(opened.fd);
        return opened;
      });
      const renameNoReplace = vi.fn(binding.renameNoReplace.bind(binding));
      const renameReplace = vi.fn(binding.renameReplace.bind(binding));
      const closeFailure = new Error("parent close failed after closing");
      const close = vi.fn((fd: number) => {
        binding.closeOwnedFd(fd);
        if (closeOutcome === "fails" && parentFds.includes(fd)) throw closeFailure;
      });
      __setNativeLoaderForTest(() => ({
        ...binding,
        closeOwnedFd: close,
        fstatIdentity(fd) {
          rootFds.push(fd);
          return binding.fstatIdentity(fd);
        },
        openBeneath,
        renameNoReplace,
        renameReplace,
      }));
      configureFsSafeNative({ mode: "require" });
      const nativeRealpath = realpathSync.native.bind(realpathSync);
      vi.spyOn(realpathSync, "native").mockImplementation((candidate) =>
        `${nativeRealpath(candidate)}:stream`);
      const lstat = vi.spyOn(fsSync, "lstatSync");

      await expect(runOwnedPinnedWrite(baseParams({ rootPath: root })))
        .rejects.toMatchObject(aliasError);

      expect(openBeneath).toHaveBeenCalledTimes(1);
      expect(lstat).not.toHaveBeenCalled();
      expect(renameNoReplace).not.toHaveBeenCalled();
      expect(renameReplace).not.toHaveBeenCalled();
      expect(parentFds).toHaveLength(1);
      expect(rootFds).toHaveLength(1);
      expect(close.mock.calls.filter(([fd]) => fd === parentFds[0])).toHaveLength(1);
      expect(() => fsSync.fstatSync(parentFds[0]!)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(() => fsSync.fstatSync(rootFds[0]!)).toThrow(expect.objectContaining({ code: "EBADF" }));
      await expect(fs.readdir(root)).resolves.toEqual([]);
    },
  );

  it.runIf(bundledNative !== undefined).each(["?", "."] as const)(
    "writes beneath an exact \\\\%s\\ drive root without losing the separator",
    async (namespace) => {
      const directory = await tempRoot("fs-safe-pinned-namespace-");
      const driveRoot = path.parse(directory).root;
      const namespaceRoot = `\\\\${namespace}\\${driveRoot}`;
      const relativeParentPath = path.relative(driveRoot, directory).split(path.sep).join("/");
      const basename = `value-${namespace === "?" ? "question" : "dot"}`;
      __setNativeLoaderForTest(() => bundledNative!);
      configureFsSafeNative({ mode: "require" });

      await runOwnedPinnedWrite(baseParams({
        rootPath: namespaceRoot,
        relativeParentPath,
        basename,
      }));

      await expect(fs.readFile(path.join(directory, basename), "utf8")).resolves.toBe("payload");
    },
  );
});

describe("owned pinned write parameter snapshots", () => {
  it("captures nested identity after validation and retains it across the admission wait", async () => {
    const rootPath = await tempRoot("fs-safe-pinned-snapshot-");
    const identity = await fs.lstat(rootPath, { bigint: true });
    const reads = new Map<string, number>();
    const once = <T>(name: string, value: T): (() => T) => () => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      if (count > 1) throw new Error(`${name} read more than once`);
      return value;
    };
    const onceDev = once("dev", identity.dev);
    const onceIno = once("ino", identity.ino);
    const rootIdentity = { get dev() { return onceDev(); }, get ino() { return onceIno(); } };
    const params = baseParams({
      rootPath,
      maxBytes: 1024,
      rootIdentity,
      sync: false,
      mutationAdmission: { rejectParentSymlinks: false, authorize: async () => undefined },
    });
    configureFsSafeNative({ mode: "off" });
    const admission = vi.fn(async () => {
      expect(Object.fromEntries(reads)).toEqual({ dev: 1, ino: 1 });
      await Promise.resolve();
      Object.defineProperties(rootIdentity, {
        dev: { value: identity.dev + 1n }, ino: { value: identity.ino + 1n },
      });
      params.basename = "decoy";
      params.maxBytes = 0;
    });
    __setFsSafeTestHooksForTest({ beforePinnedWriteParentAdmission: admission });

    await expect(runOwnedPinnedWrite({ ...params, basename: "..", maxBytes: -1 }))
      .rejects.toBeInstanceOf(RangeError);
    await expect(runOwnedPinnedWrite({ ...params, basename: ".." }))
      .rejects.toMatchObject({ code: "invalid-path" });
    expect(reads.size).toBe(0);
    expect(admission).not.toHaveBeenCalled();

    await runOwnedPinnedWrite(params);

    expect(Object.fromEntries(reads)).toEqual({ dev: 1, ino: 1 });
    expect(admission).toHaveBeenCalledOnce();
    await expect(fs.readFile(path.join(rootPath, "value"), "utf8")).resolves.toBe("payload");
    expect(await fs.readdir(rootPath)).toEqual(["value"]);
  });

  it("retains inherited and non-enumerable named snapshots", async () => {
    const rootPath = await tempRoot("fs-safe-pinned-named-");
    const rootIdentity = await fs.lstat(rootPath, { bigint: true });
    const prototype = Object.defineProperties({}, {
      rootPath: { get: () => rootPath },
      relativeParentPath: { get: () => "" },
      maxBytes: { get: () => 1024 },
    });
    const params = Object.assign(Object.create(prototype), {
      mkdir: false,
      mode: 0o600,
      sync: false,
      overwrite: false,
      input: { kind: "buffer" as const, data: "payload" },
    });
    Object.defineProperties(params, {
      basename: { get: () => "value" },
      rootIdentity: { get: () => rootIdentity },
    });
    configureFsSafeNative({ mode: "off" });

    await runOwnedPinnedWrite(params as PinnedWriteParams);

    await expect(fs.readFile(path.join(rootPath, "value"), "utf8")).resolves.toBe("payload");
  });

  it("preserves own enumerable callback state without copying hidden extras", async () => {
    const rootPath = await tempRoot("fs-safe-pinned-receiver-");
    const stateSymbol = Symbol("state");
    let getterReceiver: unknown;
    let callbackReceiver: Record<PropertyKey, unknown> | undefined;
    let hiddenReads = 0;
    const params = baseParams({
      rootPath,
      sync: false,
      overwrite: true,
      onPublished: function (this: Record<PropertyKey, unknown>) {
        callbackReceiver = this;
      },
    });
    Object.defineProperties(params, {
      callbackState: {
        enumerable: true,
        get() {
          getterReceiver = this;
          return "state";
        },
      },
      [stateSymbol]: { enumerable: true, value: "symbol-state" },
      ["__proto__"]: { enumerable: true, value: "proto-state" },
      hiddenState: {
        enumerable: false,
        get() {
          hiddenReads += 1;
          return "hidden";
        },
      },
    });
    configureFsSafeNative({ mode: "off" });

    await runOwnedPinnedWrite(params);

    expect(getterReceiver).toBe(params);
    expect(hiddenReads).toBe(0);
    expect(callbackReceiver).not.toBe(params);
    expect(callbackReceiver?.callbackState).toBe("state");
    expect(callbackReceiver?.[stateSymbol]).toBe("symbol-state");
    expect(Object.getPrototypeOf(callbackReceiver)).toBe(Object.prototype);
    expect(Object.hasOwn(callbackReceiver ?? {}, "__proto__")).toBe(true);
    expect(callbackReceiver?.__proto__).toBe("proto-state");
    expect(Reflect.ownKeys(callbackReceiver!)).toEqual([
      "mkdir", "mode", "overwrite", "input", "sync", "onPublished", "callbackState", "__proto__",
      "rootPath", "relativeParentPath", "basename", "maxBytes", "rootIdentity", stateSymbol,
    ]);
  });

  it.each([
    { label: "default", renameIdentity: undefined },
    { label: "strict", renameIdentity: "strict" as const },
    { label: "verify-content", renameIdentity: "verify-content-with-lock" as const },
  ])("keeps the separate $label rename policy out of the writer receiver", async ({ label, renameIdentity }) => {
    const rootPath = await tempRoot(`fs-safe-pinned-wrapper-${label}-`);
    const basename = "value";
    const targetPath = path.join(rootPath, basename);
    let callbackReceiver: Record<PropertyKey, unknown> | undefined;
    const params: PinnedWriteParams = {
      rootPath,
      relativeParentPath: "",
      basename,
      mkdir: false,
      mode: 0o600,
      sync: false,
      overwrite: true,
      input: { kind: "buffer" as const, data: "payload" },
      onPublished: function (this: Record<PropertyKey, unknown>) {
        callbackReceiver = this;
      },
    };
    configureFsSafeNative({ mode: "off" });

    await runOwnedPinnedWriteWithRenamePolicy(params, targetPath, renameIdentity);

    expect(callbackReceiver).not.toBe(params);
    expect(Object.hasOwn(callbackReceiver ?? {}, "targetPath")).toBe(false);
    expect(Object.hasOwn(callbackReceiver ?? {}, "renameIdentity")).toBe(false);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("payload");
  });
});
