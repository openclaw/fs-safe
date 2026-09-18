import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCloneMetadata } from "../benchmarks/lifecycle.mjs";
import { readCloneFileMetadata } from "../src/copy.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const workspace = path.resolve("clone-metadata-benchmark");
type Row = {
  name: string;
  run: () => Promise<unknown>;
  options: { skip?: string; verify: (entries: unknown) => void };
};

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function register(read: (paths: readonly string[]) => Promise<unknown>, cloneBackend?: string) {
  const rows: Row[] = [];
  await registerCloneMetadata({
    api: { readCloneFileMetadata: read }, workspace, cloneBackend,
    register: (name: string, run: Row["run"], options: Row["options"]) => rows.push({ name, run, options }),
  });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("clone metadata benchmark capability admission", () => {
  it.each(["off", "auto"] as const)("measures the public non-Darwin unsupported result in %s", async (mode) => {
    Object.defineProperty(process, "platform", { value: "linux" });
    configureFsSafeNative({ mode });
    __setNativeLoaderForTest(() => { throw new Error("native package omitted"); });
    const read = vi.fn(readCloneFileMetadata);

    const row = await register(read);
    expect(row.name).toBe("readCloneFileMetadata");
    expect(row.options.skip).toBeUndefined();
    expect(read).toHaveBeenCalledExactlyOnceWith([path.join(workspace, "input.json")]);
    const result = await row.run();
    expect(result).toEqual([undefined]);
    row.options.verify(result);
    expect(read).toHaveBeenCalledTimes(2);
    for (const invalid of [[], [null], [{}], [undefined, undefined]]) {
      expect(() => row.options.verify(invalid)).toThrow();
    }
  });

  it("keeps historical missing-native builds as an explicit untimed skip", async () => {
    const read = vi.fn(async () => { throw { code: "helper-unavailable" }; });
    const row = await register(read);
    expect(row.options.skip).toBe("Native metadata reader unavailable.");
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([Object.assign(new Error("metadata failed"), { code: "EIO" }), undefined, null, false, 0])(
    "retains a non-capability preflight failure unchanged: %s", async (failure) => {
      const add = vi.fn();
      await expect(registerCloneMetadata({
        api: { readCloneFileMetadata: async () => { throw failure; } },
        workspace, register: add,
      })).rejects.toBe(failure);
      expect(add).not.toHaveBeenCalled();
    },
  );

  it("retains APFS metadata verification without counting the probe as a timed invocation", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const read = vi.fn(async () => [{ type: 1 }]);
    const row = await register(read, "apfs");
    expect(read).toHaveBeenCalledOnce();
    expect(row.options.skip).toBeUndefined();
    row.options.verify(await row.run());
    expect(read).toHaveBeenCalledTimes(2);
    expect(() => row.options.verify([undefined])).toThrow();
  });

  it("rejects invalid preflight results instead of skipping them", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const add = vi.fn();
    await expect(registerCloneMetadata({
      api: { readCloneFileMetadata: async () => [{ type: 1 }] },
      workspace, register: add,
    })).rejects.toMatchObject({ code: "ERR_ASSERTION" });
    expect(add).not.toHaveBeenCalled();
  });

  it("does not suppress a timed-call failure after successful admission", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const failure = Object.assign(new Error("helper disappeared"), { code: "helper-unavailable" });
    const read = vi.fn().mockResolvedValueOnce([undefined]).mockRejectedValueOnce(failure);
    const row = await register(read);
    expect(row.options.skip).toBeUndefined();
    await expect(row.run()).rejects.toBe(failure);
  });
});
