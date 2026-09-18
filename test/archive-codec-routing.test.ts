import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry, resolveArchiveKind } from "../src/archive.js";
import * as nativeArchive from "../src/archive-native.js";
import { TarWasmSession } from "../src/archive-tar-wasm.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { compressedTarFraming } from "./helpers/archive-tar-framing-compressed.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

for (const kind of ["tar-zstd", "tar-bzip2"] as const) {
  const suffixes = kind === "tar-zstd" ? [".tar.zst", ".tar.zstd", ".tzst"] : [".tar.bz2", ".tbz2", ".tbz"];
  async function fixture() {
    const root = await tempRoot("fs-safe-codec-route-");
    const archivePath = path.join(root, `fixture${suffixes[0]}`), destDir = path.join(root, "out");
    await fs.mkdir(destDir);
    await fs.writeFile(archivePath, Buffer.from(compressedTarFraming[0][kind], "base64"));
    return { archivePath, destDir, timeoutMs: 10_000 };
  }
  describe(`${kind} codec dispatch`, () => {
    it.each(["off", "auto"] as const)("extracts and reads without native support in %s", async mode => {
      configureFsSafeNative({ mode });
      const loader = vi.fn(() => { throw new Error("native fixture absent"); });
      __setNativeLoaderForTest(loader);
      for (const suffix of suffixes) expect(resolveArchiveKind(`ARCHIVE${suffix.toUpperCase()}`)).toBe(kind);
      const input = await fixture();
      await extractArchive(input);
      expect(await fs.readFile(path.join(input.destDir, "value"), "utf8")).toBe("payload");
      expect(await readArchiveEntry(input.archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
      expect(await readArchiveEntry(input.archivePath, "value", { maxBytes: 7, kind })).toEqual(Buffer.from("payload"));
      expect(loader).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    });

    it("keeps require strict for suffix detection, explicit extraction and reads", async () => {
      configureFsSafeNative({ mode: "require" });
      __setNativeLoaderForTest(() => { throw new Error("native fixture absent"); });
      for (const suffix of suffixes) expect(() => resolveArchiveKind(`input${suffix}`)).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
      const input = await fixture();
      await expect(extractArchive({ ...input, kind })).rejects.toMatchObject({ code: "helper-unavailable" });
      await expect(readArchiveEntry(input.archivePath, "value", { maxBytes: 7, kind })).rejects.toMatchObject({ code: "helper-unavailable" });
      expect(await fs.readdir(input.destDir)).toEqual([]);
    });

    it("prefers a present native binding and never retries its errors through WASM", async () => {
      configureFsSafeNative({ mode: "auto" });
      const failure = new Error("native operation failed after dispatch");
      const openTarBufferNative = vi.fn(async () => { throw failure; });
      __setNativeLoaderForTest(() => ({ closeOwnedFd() {}, openTarBufferNative }) as unknown as NativeBinding);
      const extract = vi.spyOn(nativeArchive, "extractNativeArchive").mockRejectedValue(failure);
      const decode = vi.spyOn(TarWasmSession.prototype, "decode");
      const input = await fixture();
      await expect(extractArchive(input)).rejects.toBe(failure);
      await expect(readArchiveEntry(input.archivePath, "value", { maxBytes: 7 })).rejects.toBe(failure);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(openTarBufferNative).toHaveBeenCalledTimes(1);
      expect(decode).not.toHaveBeenCalled();
    });
  });
}
