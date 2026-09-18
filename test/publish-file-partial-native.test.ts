import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture() {
  const dir = await tempRoot("fs-safe-publish-partial-binding-");
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");
  const bytes = Buffer.alloc(256 * 1024 + 31, 0x5a);
  await fs.writeFile(source, bytes, { mode: 0o600 });
  configureFsSafeNative({ mode: "auto" });
  return { dir, source, target, bytes };
}

function partialBinding(binding: Partial<NativeBinding> = {}) {
  const closeOwnedFd = vi.fn(fsSync.closeSync);
  __setNativeLoaderForTest(() => ({ closeOwnedFd, ...binding } as NativeBinding));
  return closeOwnedFd;
}

describe("publication with individual native primitives omitted", () => {
  it.each(["link-required", "link-or-copy"] as const)("uses Node hardlinks for %s without native parent reads", async (strategy) => {
    const { source, target, bytes } = await fixture();
    const close = partialBinding();
    const open = vi.spyOn(fs, "open");
    const result = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy });
    expect(result.method).toBe("hardlink");
    expect(result.sourceConsumed).toBeUndefined();
    expect(await fs.readFile(source)).toEqual(bytes);
    expect(await fs.readFile(target)).toEqual(bytes);
    // One source file and the ordinary pinned publication parent; no native parents.
    expect(open).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  });

  it("copies and hashes through Node when all native link/copy/hash primitives are absent", async () => {
    const { source, target, bytes } = await fixture();
    const close = partialBinding();
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("force byte copy"), { code: "EXDEV" }));
    const result = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" });
    expect(result.method).toBe("exclusive-copy");
    expect(await fs.readFile(target)).toEqual(bytes);
    await fs.writeFile(target, "independent edit");
    expect(await fs.readFile(source)).toEqual(bytes);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["clone", "range"] as const)("uses an available %s primitive without requiring its sibling or native hashing", async (method) => {
    const { source, target, bytes } = await fixture();
    const copy = vi.fn(() => {
      fsSync.copyFileSync(source, target, fsSync.constants.COPYFILE_EXCL);
      return fsSync.openSync(target, "r+");
    });
    const close = partialBinding(method === "clone"
      ? { cloneFileExclusive: copy }
      : { copyFileRangeExclusive: async () => ({ fd: copy(), bytes: bytes.length }) });
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("force native copy"), { code: "EXDEV" }));
    const result = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" });
    expect(result.method).toBe("exclusive-copy");
    expect(copy).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(await fs.readFile(target)).toEqual(bytes);
    expect(await fs.readFile(source)).toEqual(bytes);
    expect((await fs.stat(target, { bigint: true })).ino).not.toBe((await fs.stat(source, { bigint: true })).ino);
  });

  it("falls back after an unsupported clone when range copying and native hashing are absent", async () => {
    const { source, target, bytes } = await fixture();
    const clone = vi.fn(() => { throw Object.assign(new Error("clone unavailable"), { code: "ENOTSUP" }); });
    const close = partialBinding({ cloneFileExclusive: clone });
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("force clone"), { code: "EXDEV" }));
    const result = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" });
    expect(result.method).toBe("exclusive-copy");
    expect(clone).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(await fs.readFile(target)).toEqual(bytes);
  });

  it("does not turn an available native copy's I/O failure into a byte-copy retry", async () => {
    const { source, target, bytes } = await fixture();
    const failure = Object.assign(new Error("native copy I/O failure"), { code: "EIO" });
    const clone = vi.fn(() => { throw failure; });
    partialBinding({ cloneFileExclusive: clone });
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("force clone"), { code: "EXDEV" }));
    await expect(publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" })).rejects.toBe(failure);
    expect(clone).toHaveBeenCalledOnce();
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(source)).toEqual(bytes);
  });

  it("retains content fencing when native hashing is absent", async () => {
    const { source, target, bytes } = await fixture();
    const clone = vi.fn(() => {
      fsSync.writeFileSync(target, "corrupted native copy", { flag: "wx", mode: 0o600 });
      return fsSync.openSync(target, "r+");
    });
    const close = partialBinding({ cloneFileExclusive: clone });
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("force clone"), { code: "EXDEV" }));
    await expect(publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }))
      .rejects.toMatchObject({ code: "path-mismatch", details: { targetCreated: true, cleanup: "removed" } });
    expect(close).toHaveBeenCalledOnce();
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(source)).toEqual(bytes);
  });
});
