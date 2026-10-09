import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syntheticCorpus } from "../scripts/zip-differential/corpus.mjs";
import { extractArchive, loadZipArchiveWithPreflight, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const corpus = new Map<string, Buffer>(syntheticCorpus().map((entry: { id: string; bytes: Buffer }) => [entry.id, entry.bytes]));
const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try { __loadBundledNativeForTest(); nativeAvailable = true; }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
afterEach(__resetFsSafeNativeConfigForTest);

async function input(id: string) {
  const root = await tempRoot("zip-corpus-");
  const archivePath = path.join(root, "input.zip"), destDir = path.join(root, "out");
  const bytes = corpus.get(id);
  if (!bytes) throw new Error(`missing corpus case: ${id}`);
  await fs.writeFile(archivePath, bytes); await fs.mkdir(destDir);
  return { archivePath, destDir, bytes, timeoutMs: 10000 };
}

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !nativeAvailable)(`generated ZIP corpus (${mode})`, () => {
    it.each(["stored", "deflate", "descriptor", "zip64-descriptor", "zip64"])(
      "extracts and reads the complete payload: %s", async id => {
        configureFsSafeNative({ mode });
        const fixture = await input(id);
        await extractArchive(fixture);
        expect(await fs.readdir(fixture.destDir)).toEqual(["payload"]);
        expect(await fs.readFile(path.join(fixture.destDir, "payload"), "utf8")).toBe("payload");
        expect(await readArchiveEntry(fixture.archivePath, "payload", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
      });
    it.each([
      ["utf8-invalid", "archive-header-invalid"], ["utf8-overlong", "archive-header-invalid"],
      ["unicode-bad-crc", "archive-header-invalid"], ["unicode-invalid-utf8", "archive-header-invalid"],
      ["parent", "entry-path"], ["absolute", "entry-path"], ["drive", "entry-path"], ["nul", "entry-path"],
      ["duplicate", "entry-path"], ["case-collision", "entry-path"], ["directory-file-collision", "entry-path"],
      ["local-central-name-mismatch", "archive-header-invalid"], ["overlapping-payloads", "archive-header-invalid"],
      ["huge-offset", "archive-header-invalid"], ["truncated-directory", "archive-header-invalid"],
    ])("rejects %s before callbacks or publication", async (id, code) => {
      configureFsSafeNative({ mode });
      const fixture = await input(id);
      const calls: unknown[] = [];
      await expect(loadZipArchiveWithPreflight(fixture.bytes)).rejects.toMatchObject({ code });
      await expect(extractArchive({ ...fixture, entryFilter: entry => { calls.push(entry); return "skip"; }, onFiltered: "skip-entry" }))
        .rejects.toMatchObject({ code });
      await expect(readArchiveEntry(fixture.archivePath, "payload", { maxBytes: 7 })).rejects.toMatchObject({ code });
      expect(calls).toEqual([]);
      expect(await fs.readdir(fixture.destDir)).toEqual([]);
    });
  });
}
