import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
} from "../src/native.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const payload = Buffer.alloc(8 * 1024 * 1024);
const decoded = tarFixture([{ path: "payload.bin", body: payload }]);
const compressed = gzipSync(decoded);
const limits = {
  maxArchiveBytes: compressed.byteLength,
  maxEntryBytes: payload.byteLength,
  maxExtractedBytes: payload.byteLength,
};

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const backend of ["off", "auto-missing", "auto", "require"] as const) {
  describe.skipIf((backend === "auto" || backend === "require") && !paxNative)(
    `TAR gzip ratio policy ${backend}`,
    () => {
      let inspect: ReturnType<typeof vi.fn> | undefined;
      let extract: ReturnType<typeof vi.fn> | undefined;
      let read: ReturnType<typeof vi.fn> | undefined;

      beforeEach(() => {
        configureFsSafeNative({ mode: backend === "auto-missing" ? "auto" : backend });
        if (backend === "auto-missing") {
          __setNativeLoaderForTest(() => {
            throw new Error("fixture: no native binding");
          });
        }
        if (backend === "auto" || backend === "require") {
          const native = paxNative!;
          inspect = vi.fn(native.inspectArchiveNative.bind(native));
          extract = vi.fn(native.extractArchiveNative.bind(native));
          read = vi.fn(native.readArchiveEntryNative.bind(native));
          __setNativeLoaderForTest(() => ({
            ...native,
            inspectArchiveNative: inspect!,
            extractArchiveNative: extract!,
            readArchiveEntryNative: read!,
          }));
        }
      });

      it("accepts expansion above 1000x when absolute budgets admit the complete stream", async () => {
        expect(decoded.byteLength / compressed.byteLength).toBeGreaterThan(1000);
        expect(compressed.byteLength).toBeLessThanOrEqual(limits.maxArchiveBytes);
        expect(payload.byteLength).toBeLessThanOrEqual(limits.maxEntryBytes);
        expect(payload.byteLength).toBeLessThanOrEqual(limits.maxExtractedBytes);
        expect(decoded.byteLength).toBeLessThanOrEqual(
          resolveTarMeterLimits(limits).maxDecodedBytes,
        );

        const root = await tempRoot("fs-safe-tar-gzip-ratio-");
        const archivePath = path.join(root, "fixture.tar.gz");
        const destDir = path.join(root, "out");
        await fs.writeFile(archivePath, compressed);
        await fs.mkdir(destDir);
        await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");

        await extractArchive({
          archivePath,
          destDir,
          kind: "tar",
          tarGzip: true,
          timeoutMs: 30_000,
          limits,
        });
        expect(await fs.stat(path.join(destDir, "payload.bin"))).toMatchObject({
          size: payload.byteLength,
        });
        expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");

        const selected = await readArchiveEntry(archivePath, "payload.bin", {
          kind: "tar",
          maxBytes: payload.byteLength,
        });
        expect(selected.equals(payload)).toBe(true);

        if (backend === "auto" || backend === "require") {
          expect(inspect).toHaveBeenCalledTimes(2);
          expect(extract).toHaveBeenCalledTimes(1);
          expect(read).toHaveBeenCalledTimes(1);
        }
      }, 30_000);
    },
  );
}
