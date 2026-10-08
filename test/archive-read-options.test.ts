import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readArchiveEntry } from "../src/archive-read.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

describe.each(["zip", "tar"] as const)("%s read option admission", kind => {
  async function fixture() {
    configureFsSafeNative({ mode: "off" });
    const dir = await tempRoot("fs-safe-read-options-");
    const archivePath = path.join(dir, `input.${kind}`);
    if (kind === "zip") {
      const zip = new JSZip();
      zip.file("value", "payload");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    } else {
      await fs.writeFile(path.join(dir, "value"), "payload");
      await tar.c({ cwd: dir, file: archivePath }, ["value"]);
    }
    return archivePath;
  }

  it("retains the admitted byte limit across asynchronous input reads", async () => {
    const archivePath = await fixture();
    const options = { maxBytes: 1 };
    const operation = readArchiveEntry(archivePath, "value", options);
    options.maxBytes = 100;
    await expect(operation).rejects.toMatchObject({
      code: "archive-entry-extracted-size-exceeds-limit",
    });
  });

  it("selects a getter-backed byte limit once", async () => {
    const archivePath = await fixture();
    const limit = vi.fn(() => 7);
    await expect(readArchiveEntry(archivePath, "value", { get maxBytes() { return limit(); } }))
      .resolves.toEqual(Buffer.from("payload"));
    expect(limit).toHaveBeenCalledTimes(1);
  });
});
