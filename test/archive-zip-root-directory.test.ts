import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { extractArchive, loadZipArchiveWithPreflight, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { zipRecords } from "./helpers/zip-records.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(__resetFsSafeNativeConfigForTest);

it.each([["./", "./"], [".\\", ".\\/"], [".", "./"], ["././", "./"]])("keeps an admitted root-directory marker relative: %s", async (name, listedName) => {
  configureFsSafeNative({ mode: "off" });
  const root = await tempRoot("zip-root-directory-");
  const archivePath = path.join(root, "input.zip"), destDir = path.join(root, "out");
  const bytes = zipRecords([{ name, body: "", attributes: 0x41ed0010 }, { name: "payload", body: "contents" }]);
  await fs.writeFile(archivePath, bytes); await fs.mkdir(destDir);
  const loaded = await loadZipArchiveWithPreflight(bytes);
  expect(loaded.files).toHaveProperty(listedName);
  expect(loaded.files).not.toHaveProperty("/");
  const calls: unknown[] = [];
  await extractArchive({ archivePath, destDir, timeoutMs: 10000,
    entryFilter: entry => { calls.push(entry); return "extract"; } });
  expect(calls).toEqual([{ path: "payload", kind: "file", size: 8 }]);
  expect(await fs.readdir(destDir)).toEqual(["payload"]);
  expect(await fs.readFile(path.join(destDir, "payload"), "utf8")).toBe("contents");
  expect(await readArchiveEntry(archivePath, "payload", { maxBytes: 8 })).toEqual(Buffer.from("contents"));
});

it.each(["/", "\\", "../", "C:/"])("still rejects unsafe directory markers before portable preflight: %s", async name => {
  configureFsSafeNative({ mode: "off" });
  const bytes = zipRecords([{ name, body: "", attributes: 0x41ed0010 }]);
  await expect(loadZipArchiveWithPreflight(bytes)).rejects.toMatchObject({ code: "entry-path" });
});

it("still rejects duplicate root-directory identities", async () => {
  configureFsSafeNative({ mode: "off" });
  const bytes = zipRecords(["./", "."].map(name => ({ name, body: "", attributes: 0x41ed0010 })));
  await expect(loadZipArchiveWithPreflight(bytes)).rejects.toMatchObject({ code: "entry-path" });
});
