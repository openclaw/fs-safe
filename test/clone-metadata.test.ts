import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCloneFileMetadata } from "../src/copy.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const input = path.resolve("clone-metadata-fixture", "nested", "..", "payload");

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  vi.restoreAllMocks();
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function missingBinding() {
  const cause = Object.assign(new Error("native package omitted"), { code: "MODULE_NOT_FOUND" });
  const loader = vi.fn(() => { throw cause; });
  __setNativeLoaderForTest(loader);
  return { cause, loader };
}

function setReader(readCloneFileMetadata: NativeBinding["readCloneFileMetadata"]) {
  const loader = vi.fn(() => ({
    readCloneFileMetadata,
    closeOwnedFd: vi.fn(),
  }) as unknown as NativeBinding);
  __setNativeLoaderForTest(loader);
  return loader;
}

describe.each(["linux", "win32", "freebsd"] as const)("clone metadata on %s", (platform) => {
  it.each(["auto", "off"] as const)("reports unsupported entries in %s without the addon", async (mode) => {
    setPlatform(platform);
    configureFsSafeNative({ mode });
    const { loader } = missingBinding();
    const files = Object.freeze([input, path.resolve("another-missing-clone-metadata-file"), input]);

    await expect(readCloneFileMetadata(files)).resolves.toEqual([undefined, undefined, undefined]);
    await expect(readCloneFileMetadata([])).resolves.toEqual([]);
    expect(loader).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
  });

  it("keeps require strict for populated and empty batches", async () => {
    setPlatform(platform);
    configureFsSafeNative({ mode: "require" });
    const { cause, loader } = missingBinding();

    for (const files of [[input], []]) {
      await expect(readCloneFileMetadata(files)).rejects.toMatchObject({
        code: "helper-unavailable", cause,
      });
    }
    expect(loader).toHaveBeenCalledOnce();
  });

  it("does not load or call a present helper in off mode", async () => {
    setPlatform(platform);
    configureFsSafeNative({ mode: "off" });
    const read = vi.fn<NativeBinding["readCloneFileMetadata"]>();
    const loader = setReader(read);

    await expect(readCloneFileMetadata([input])).resolves.toEqual([undefined]);
    expect(loader).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("APFS metadata availability", () => {
  it.each(["auto", "off", "require"] as const)("requires native on macOS in %s mode", async (mode) => {
    setPlatform("darwin");
    configureFsSafeNative({ mode });
    const { loader } = missingBinding();

    for (const files of [[input], []]) {
      await expect(readCloneFileMetadata(files)).rejects.toMatchObject({ code: "helper-unavailable" });
    }
    expect(loader).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
  });
});

describe.each(["darwin", "linux", "win32", "freebsd"] as const)("clone metadata admission on %s", (platform) => {
  it.each(["auto", "off", "require"] as const)("validates all paths before native selection in %s", async (mode) => {
    setPlatform(platform);
    configureFsSafeNative({ mode });
    const { loader } = missingBinding();

    for (const invalid of ["", "relative", `${input}\0hidden`]) {
      await expect(readCloneFileMetadata([input, invalid])).rejects.toMatchObject({ code: "invalid-path" });
    }
    if (platform === "win32") {
      await expect(readCloneFileMetadata([`${input}:stream`])).rejects.toMatchObject({ code: "invalid-path" });
    }
    expect(loader).not.toHaveBeenCalled();
  });

  it.each(["auto", "require"] as const)("retains terminal native failures in %s", async (mode) => {
    setPlatform(platform);
    configureFsSafeNative({ mode });
    const failure = Object.assign(new Error("metadata I/O failed"), { code: "EIO" });
    const read = vi.fn<NativeBinding["readCloneFileMetadata"]>().mockRejectedValue(failure);
    setReader(read);

    await expect(readCloneFileMetadata([input])).rejects.toBe(failure);
    expect(read).toHaveBeenCalledExactlyOnceWith([input]);
  });

  it("keeps native result decoding and batch order", async () => {
    setPlatform(platform);
    configureFsSafeNative({ mode: "auto" });
    const result = Buffer.alloc(100);
    for (const [offset, value] of [
      [0, 100], [4, 0x82038c0a], [16, 0x200], [20, 0x100],
      [24, 12], [28, 1], [64, 501], [68, 20], [72, 0o100600],
    ] as const) result.writeUInt32LE(value, offset);
    for (const [offset, value] of [
      [32, 10n], [40, 11n], [48, 12n], [56, 13n],
      [76, 9007199254740993n], [84, 31n], [92, 9007199254740995n],
    ] as const) result.writeBigInt64LE(value, offset);
    const read = vi.fn<NativeBinding["readCloneFileMetadata"]>().mockResolvedValue([null, result]);
    setReader(read);
    const unnormalized = `${path.dirname(input)}${path.sep}.${path.sep}payload`;

    await expect(readCloneFileMetadata([input, unnormalized])).resolves.toEqual([
      undefined,
      {
        dev: 12, type: 1, mtimeSec: 10, mtimeNs: 11, ctimeSec: 12, ctimeNs: 13,
        uid: 501, gid: 20, mode: 0o100600, ino: 9007199254740993n, size: 31n,
        cloneId: 9007199254740995n,
      },
    ]);
    expect(read).toHaveBeenCalledExactlyOnceWith([input, input]);
  });

  it("keeps empty native batches on the existing native route", async () => {
    setPlatform(platform);
    configureFsSafeNative({ mode: "auto" });
    const read = vi.fn<NativeBinding["readCloneFileMetadata"]>().mockResolvedValue([]);
    setReader(read);

    await expect(readCloneFileMetadata([])).resolves.toEqual([]);
    expect(read).toHaveBeenCalledExactlyOnceWith([]);
  });
});
