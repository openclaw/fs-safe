import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { readArchiveEntry } from "../src/archive-read.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import * as temp from "../src/temp-target.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

it("reads a fallback ZIP directly from the admitted buffer without a disk snapshot", async () => {
  const dir = await tempRoot("fs-safe-zip-memory-");
  const archive = path.join(dir, "input.zip");
  const zip = new JSZip();
  zip.file("entry", "archive bytes");
  await fs.writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
  configureFsSafeNative({ mode: "off" });
  const staging = vi.spyOn(temp, "tempFile").mockRejectedValue(new Error("temporary storage unavailable"));
  await expect(readArchiveEntry(archive, "entry", { maxBytes: 13 })).resolves.toEqual(Buffer.from("archive bytes"));
  expect(staging).not.toHaveBeenCalled();
  await expect(readArchiveEntry(archive, "entry", { maxBytes: 1 })).rejects.toThrow();
  expect(staging).not.toHaveBeenCalled();
});
