import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { readArchiveEntry } from "../src/archive-read.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

it.each(["STORE", "DEFLATE"] as const)("joins the %s decoder source when a selected read exceeds its byte budget", async (compression) => {
  configureFsSafeNative({ mode: "off" });
  const dir = await tempRoot("fs-safe-zip-read-lifetime-");
  const archivePath = path.join(dir, "input.zip");
  const zip = new JSZip();
  zip.file("value", Buffer.alloc(1024 * 1024, 7));
  await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer", compression }));
  const load = JSZip.prototype.loadAsync;
  let source: Readable | undefined;
  let cleanupFinished = false;
  let cleanupError: Error | null | undefined;
  vi.spyOn(JSZip.prototype, "loadAsync").mockImplementation(async function(this: JSZip, ...args) {
    const archive = await load.apply(this, args);
    const entry = archive.files.value!;
    const nodeStream = entry.nodeStream.bind(entry);
    vi.spyOn(entry, "nodeStream").mockImplementation((...params) => {
      source = nodeStream(...params) as Readable;
      const destroy = source._destroy.bind(source);
      vi.spyOn(source, "_destroy").mockImplementation((error, callback) => {
        cleanupError = error;
        setImmediate(() => { cleanupFinished = true; destroy(error, callback); });
      });
      return source;
    });
    return archive;
  });
  try {
    const operation = readArchiveEntry(archivePath, "value", { maxBytes: 1 });
    await expect(operation).rejects.toMatchObject({
      name: "ArchiveLimitError",
      code: "archive-entry-extracted-size-exceeds-limit",
    });
    expect(source).toBeDefined();
    expect(source!.destroyed).toBe(true);
    expect(cleanupFinished).toBe(true);
    await expect(operation).rejects.toBe(cleanupError);
  } finally {
    source?.destroy();
  }
});
