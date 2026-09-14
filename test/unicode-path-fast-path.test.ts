import path from "node:path";
import { describe, expect, it } from "vitest";
import { createArchiveOutputPathTracker, isWindowsDrivePath, validateArchiveEntryPath } from "../src/archive-entry.js";
import { fileStore } from "../src/file-store.js";
import { fitFileNameToPortableComponent } from "../src/filename.js";
import { resolveSafeRelativePath } from "../src/path.js";
import { lowerCaseNfc, maxNormalizedUtf8Bytes } from "../src/unicode-path.js";

function corpus(): string[] {
  const values = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code).repeat(3));
  const parts = ["", "plain", "/", "\\", ":", "C:", ".", "..", "\0", "\x7f", "\x80", "é", "e\u0301",
    "가", "\u1100\u1161", "日本語", "😀", "\ud800", "\udc00", "a\u0315\u0300", "\u0301", "\n", "K", "Å", "\u0344"];
  let seed = 0x61c38f;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let index = 0; index < 5000; index++) {
    let value = "";
    const length = random() % 24;
    for (let part = 0; part < length; part++) value += parts[random() % parts.length];
    values.push(value);
  }
  return values;
}

describe("path normalization fast paths", () => {
  it("matches normalization and UTF-8 byte budgets for ASCII and mixed UTF-16 input", () => {
    for (const value of corpus()) {
      const nfc = value.normalize("NFC"), nfd = value.normalize("NFD");
      expect(lowerCaseNfc(value), JSON.stringify(value)).toBe(nfc.toLowerCase().normalize("NFC"));
      expect(maxNormalizedUtf8Bytes(value), JSON.stringify(value))
        .toBe(Math.max(Buffer.byteLength(nfc), Buffer.byteLength(nfd)));
      expect(maxNormalizedUtf8Bytes(value, true), JSON.stringify(value))
        .toBe(Math.max(Buffer.byteLength(value), Buffer.byteLength(nfc), Buffer.byteLength(nfd)));
    }
  });

  it("retains drive-prefix semantics across separators and unusual components", () => {
    for (const value of corpus()) {
      const expected = value.replaceAll("\\", "/").split("/").some(part => /^[a-zA-Z]:/.test(part));
      expect(isWindowsDrivePath(value), JSON.stringify(value)).toBe(expected);
    }
  });

  it.each([undefined, null, 12])("does not coerce invalid drive-path input %s", value => {
    expect(() => isWindowsDrivePath(value as never)).toThrow(TypeError);
  });

  it.each([["Folder/FILE", "folder/file"], ["café", "cafe\u0301"], ["İ", "i\u0307"], ["K", "k"], ["ΟΣ", "ος"]])(
    "keeps archive collision identities for %j and %j", (first, second) => {
      const track = createArchiveOutputPathTracker();
      track(first, first);
      expect(() => track(second, second)).toThrow(expect.objectContaining({ code: "entry-path" }));
    },
  );

  it.each([
    { name: "ASCII", unit: "a", count: 255 },
    { name: "composed Latin", unit: "é", count: 85 },
    { name: "decomposed Latin", unit: "e\u0301", count: 85 },
    { name: "Hangul", unit: "가", count: 42 },
    { name: "supplementary", unit: "😀", count: 63 },
  ])("enforces both normalization-form component limits for $name", ({ unit, count }) => {
    expect(() => validateArchiveEntryPath(`folder/${unit.repeat(count)}`)).not.toThrow();
    expect(() => validateArchiveEntryPath(`folder/${unit.repeat(count + 1)}`))
      .toThrow(expect.objectContaining({ code: "entry-path" }));
  });

  it.each(["../a", "/a", "a/../b", "a\\..\\b", "a/C:relative", "a/D:/rooted", "a\0b"])(
    "retains archive rejection for %j", value => {
      expect(() => validateArchiveEntryPath(value)).toThrow(expect.objectContaining({ code: "entry-path" }));
    },
  );

  it("keeps store keys exact while distinguishing NFC from decomposed spelling", () => {
    const store = fileStore({ rootDir: path.resolve("unicode-key-fixture") });
    for (const value of ["plain/key", "café/日本語", "가/😀", ".hidden/a..b"]) {
      expect(store.path(value)).toBe(path.join(store.rootDir, value));
    }
    for (const value of ["cafe\u0301/key", "\u1100\u1161/key", "a/../b", "a\\b", "a\0b", "a/C:relative"]) {
      expect(() => store.path(value)).toThrow(expect.objectContaining({ code: "invalid-path" }));
    }
  });

  it("resolves already-checked store keys like the general guarded path helper", () => {
    const store = fileStore({ rootDir: path.resolve("checked-key-fixture") });
    const components = ["plain", "café", "日本語", "Γειά", "😀", ".hidden", "a..b", "inner space", "2026-09-14T10:30:00Z"];
    for (let index = 0; index < 2000; index++) {
      const key = Array.from({ length: index % 32 + 1 }, (_, depth) => components[(index + depth) % components.length]).join("/");
      expect(store.path(key)).toBe(resolveSafeRelativePath(store.rootDir, key));
    }
  });

  it.each(["plain", "café", "e\u0301", "가", "😀"])("fits long %s filenames under both byte limits", unit => {
    const params = { prefix: ".stage-", fileName: `${unit.repeat(200)}.json`, suffix: ".tmp" };
    const fitted = fitFileNameToPortableComponent(params);
    const complete = `${params.prefix}${fitted}${params.suffix}`;
    expect(fitted.endsWith(".json")).toBe(true);
    expect(fitted.isWellFormed()).toBe(true);
    expect(Buffer.byteLength(complete.normalize("NFC"))).toBeLessThanOrEqual(255);
    expect(Buffer.byteLength(complete.normalize("NFD"))).toBeLessThanOrEqual(255);
  });
});
