import { createHash } from "node:crypto";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  resolveSafeInstallDir,
  safePathSegmentHashed,
  safePathSegmentHashedV2,
} from "../src/advanced.js";

const codeUnitString = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 120 })
  .map((units) => String.fromCharCode(...units));

describe("versioned install-ID encoding", () => {
  it("preserves the legacy encoder and default install paths", () => {
    expect(safePathSegmentHashed("plugin-v1")).toBe("plugin-v1");
    expect(safePathSegmentHashed("plugin/v1")).toBe("plugin-v1-d9ef8af2eb");
    expect(resolveSafeInstallDir({
      baseDir: path.resolve("plugins"), id: "plugin/v1", invalidNameMessage: "invalid ID",
    })).toEqual({ ok: true, path: path.resolve("plugins", "plugin__v1") });
  });

  it("fixes the versioned digest domain and exact string encoding", () => {
    const id = "Package / \ud800";
    const units = Buffer.alloc(id.length * 2);
    for (let index = 0; index < id.length; index += 1) {
      units.writeUInt16LE(id.charCodeAt(index), index * 2);
    }
    const digest = createHash("sha256").update(Buffer.concat([
      Buffer.from("@openclaw/fs-safe:install-path:v2\0", "utf8"), units,
    ])).digest("hex");
    expect(safePathSegmentHashedV2(id)).toBe(`id-v2-${digest}`);
  });

  it.each(["plugin/v1", "", ".", "..", "two names", "a".repeat(200)])(
    "separates an ID from literal generated names for %j", (id) => {
      const encoded = safePathSegmentHashedV2(id);
      expect(safePathSegmentHashedV2(encoded)).not.toBe(encoded);
      expect(safePathSegmentHashedV2(safePathSegmentHashed(id))).not.toBe(encoded);
    },
  );

  it.each([
    ["Plugin", "plugin"],
    ["plugin/v1", "plugin\\v1"],
    [`${"a".repeat(300)}-one`, `${"a".repeat(300)}-two`],
    ["caf\u00e9", "cafe\u0301"],
    ["\ud800", "\ud801"],
    ["\ud800", "\ufffd"],
  ])("keeps distinct IDs distinct after filesystem case folding: %j / %j", (left, right) => {
    expect(safePathSegmentHashedV2(left).toLowerCase())
      .not.toBe(safePathSegmentHashedV2(right).toLowerCase());
  });

  it("intentionally equates only surrounding whitespace", () => {
    expect(safePathSegmentHashedV2(" \t\nPlugin\u00a0"))
      .toBe(safePathSegmentHashedV2("Plugin"));
    expect(safePathSegmentHashedV2("\u2003\t")).toBe(safePathSegmentHashedV2(""));
    expect(safePathSegmentHashedV2("two names")).not.toBe(safePathSegmentHashedV2("twonames"));
  });

  it("resolves the selected V2 name inside the install base", () => {
    const baseDir = path.resolve("plugins-v2");
    const id = "../CON / untrusted-id";
    expect(resolveSafeInstallDir({
      baseDir, id, invalidNameMessage: "invalid ID", nameEncoder: safePathSegmentHashedV2,
    })).toEqual({ ok: true, path: path.join(baseDir, safePathSegmentHashedV2(id)) });
  });

  it("always produces a portable fixed-width lowercase segment", () => {
    fc.assert(fc.property(codeUnitString, (id) => {
      const encoded = safePathSegmentHashedV2(id);
      expect(encoded).toMatch(/^id-v2-[a-f0-9]{64}$/);
      expect(Buffer.byteLength(encoded)).toBe(70);
      expect(safePathSegmentHashedV2(`\t${id}\n`)).toBe(encoded);
    }), { numRuns: 300, seed: 1702 });
  });

  it("separates distinct trimmed code-unit strings without prefix or case aliases", () => {
    fc.assert(fc.property(codeUnitString, codeUnitString, (left, right) => {
      fc.pre(left.trim() !== right.trim());
      expect(safePathSegmentHashedV2(left)).not.toBe(safePathSegmentHashedV2(right));
    }), { numRuns: 300, seed: 1703 });
  });
});
