import { afterEach, expect, it, vi } from "vitest";
import { createZipEndScanFixture } from "../benchmarks/zip-end-scan-fixtures.mjs";
import { loadZipArchiveWithPreflight } from "../src/archive-zip-preflight.js";

afterEach(() => vi.useRealTimers());

it.each(["payload", "comment", "dense-payload"])(
  "admits the %s ZIP benchmark fixture at the ambiguous DOS timestamp",
  async (shape) => {
    vi.setSystemTime(new Date("2026-10-01T00:02:02Z"));
    const bytes = await createZipEndScanFixture(shape);
    const zip = await loadZipArchiveWithPreflight(bytes);
    expect(Object.keys(zip.files)).toEqual(["payload.bin"]);
    const payload = await zip.files["payload.bin"]!.async("nodebuffer");
    expect(payload).toEqual(shape === "comment" ? Buffer.from("payload") : Buffer.alloc(64 * 1024,
      shape === "dense-payload" ? Buffer.from([0x50, 0x4b, 0x05, 0x06]) : 0x61));
  },
);
