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
import { runPinnedWriteHelper, type PinnedWriteParams } from "../src/pinned-write.js";
import { realpathSync } from "../src/realpath.js";
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

    await expect(runPinnedWriteHelper(baseParams({
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

    await expect(runPinnedWriteHelper(baseParams({
      rootPath: "C:\\root:hidden",
      relativeParentPath: "../outside:stream",
      basename: "bad/name:stream",
      maxBytes: -1,
    }))).rejects.toBeInstanceOf(RangeError);
    await expect(runPinnedWriteHelper(baseParams({
      rootPath: "C:\\root:hidden",
      relativeParentPath: "../outside:stream",
      basename: "bad/name:stream",
    }))).rejects.toMatchObject({ code: "invalid-path", message: "invalid target path" });
    await expect(runPinnedWriteHelper(baseParams({
      rootPath: "C:\\root:hidden",
      relativeParentPath: "../outside:stream",
      basename: "value:stream",
    }))).rejects.toMatchObject({
      code: "invalid-path",
      message: "relative path must not escape root",
    });
    await expect(runPinnedWriteHelper(baseParams({
      rootPath: "C:\\root:hidden",
      relativeParentPath: "parent:stream",
      basename: "value:stream",
    }))).rejects.toMatchObject({
      ...aliasError,
      message: "pinned write root uses a Windows filesystem namespace alias",
    });
    await expect(runPinnedWriteHelper(baseParams({
      rootPath: "C:\\root",
      relativeParentPath: "parent:stream",
      basename: "value:stream",
    }))).rejects.toMatchObject({
      ...aliasError,
      message: "pinned write parent uses a Windows filesystem namespace alias",
    });

    expect(loader).not.toHaveBeenCalled();
  });

  it.runIf(bundledNative !== undefined)(
    "rejects a native canonical parent alias before pathname inspection or staging",
    async () => {
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
      __setNativeLoaderForTest(() => ({
        ...binding,
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
      const realClose = fsSync.closeSync.bind(fsSync);
      const closeFailure = new Error("parent close failed after closing");
      const close = vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
        realClose(fd);
        if (parentFds.includes(fd)) throw closeFailure;
      });

      await expect(runPinnedWriteHelper(baseParams({ rootPath: root })))
        .rejects.toMatchObject(aliasError);

      expect(openBeneath).toHaveBeenCalledTimes(1);
      expect(lstat).not.toHaveBeenCalled();
      expect(renameNoReplace).not.toHaveBeenCalled();
      expect(renameReplace).not.toHaveBeenCalled();
      expect(parentFds).toHaveLength(1);
      expect(rootFds).toHaveLength(1);
      expect(close).toHaveBeenCalledWith(parentFds[0]);
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

      await runPinnedWriteHelper(baseParams({
        rootPath: namespaceRoot,
        relativeParentPath,
        basename,
      }));

      await expect(fs.readFile(path.join(directory, basename), "utf8")).resolves.toBe("payload");
    },
  );
});

describe("pinned write parameter snapshots", () => {
  it("reads attacker-controlled path and identity accessors once", async () => {
    const rootPath = await tempRoot("fs-safe-pinned-snapshot-");
    const identity = await fs.lstat(rootPath, { bigint: true });
    const reads = new Map<string, number>();
    const once = <T>(name: string, value: T): (() => T) => () => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      if (count > 1) throw new Error(`${name} read more than once`);
      return value;
    };
    const rootIdentity = Object.defineProperties({}, {
      dev: { enumerable: true, get: once("dev", identity.dev) },
      ino: { enumerable: true, get: once("ino", identity.ino) },
    });
    const params = Object.defineProperties({
      mkdir: false,
      mode: 0o600,
      overwrite: false,
      input: { kind: "buffer", data: "payload" },
    }, {
      rootPath: { enumerable: true, get: once("rootPath", rootPath) },
      relativeParentPath: { enumerable: true, get: once("relativeParentPath", "") },
      basename: { enumerable: true, get: once("basename", "value") },
      maxBytes: { enumerable: true, get: once("maxBytes", 1024) },
      rootIdentity: { enumerable: true, get: once("rootIdentity", rootIdentity) },
    }) as PinnedWriteParams;
    configureFsSafeNative({ mode: "off" });

    await runPinnedWriteHelper(params);

    expect(Object.fromEntries(reads)).toEqual({
      rootPath: 1,
      relativeParentPath: 1,
      basename: 1,
      maxBytes: 1,
      rootIdentity: 1,
      dev: 1,
      ino: 1,
    });
    await expect(fs.readFile(path.join(rootPath, "value"), "utf8")).resolves.toBe("payload");
  });
});
