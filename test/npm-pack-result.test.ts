import { describe, expect, it } from "vitest";
import { normalizePackResult } from "../scripts/npm-pack-result.mjs";

const packageName = "@openclaw/fs-safe";
const packEntry = {
  id: "@openclaw/fs-safe@0.5.6",
  name: packageName,
  version: "0.5.6",
  filename: "openclaw-fs-safe-0.5.6.tgz",
  files: [
    { path: "README.md", size: 100, mode: 420 },
    { path: "dist/index.js", size: 200, mode: 420 },
    { path: "package.json", size: 300, mode: 420 },
  ],
};

describe("npm pack result normalization", () => {
  it.each([
    { label: "npm 11 array", value: [packEntry] },
    { label: "npm 12 package-name-keyed object", value: { [packageName]: packEntry } },
  ])("retains the filename and complete files list from the $label", ({ value }) => {
    const result = normalizePackResult(value, packageName);

    expect(result).toEqual({ filename: packEntry.filename, files: packEntry.files });
    expect(result.files).toBe(packEntry.files);
  });

  it.each([
    { label: "null", value: null, error: "must be an array or a package-name-keyed object" },
    { label: "empty array", value: [], error: "must contain exactly one package" },
    { label: "empty object", value: {}, error: "must contain only the package key" },
    { label: "bare entry", value: packEntry, error: "must contain only the package key" },
    { label: "multiple array entries", value: [packEntry, packEntry], error: "must contain exactly one package" },
    {
      label: "multiple package keys",
      value: { other: { ...packEntry, name: "other" }, [packageName]: packEntry },
      error: "must contain only the package key",
    },
    { label: "wrong package key", value: { other: packEntry }, error: "must contain only the package key" },
    { label: "wrong array package", value: [{ ...packEntry, name: "other" }], error: "must describe package" },
    {
      label: "key and entry name mismatch",
      value: { [packageName]: { ...packEntry, name: "other" } },
      error: "must describe package",
    },
  ])("rejects $label", ({ value, error }) => {
    expect(() => normalizePackResult(value, packageName)).toThrow(error);
  });

  it.each([
    { label: "null entry", entry: null, error: "must describe package" },
    { label: "missing name", entry: { ...packEntry, name: undefined }, error: "must describe package" },
    { label: "empty filename", entry: { ...packEntry, filename: "" }, error: "non-empty filename" },
    { label: "non-string filename", entry: { ...packEntry, filename: 42 }, error: "non-empty filename" },
    { label: "missing files", entry: { ...packEntry, files: undefined }, error: "files array" },
    { label: "non-array files", entry: { ...packEntry, files: {} }, error: "files array" },
    { label: "null file", entry: { ...packEntry, files: [null] }, error: "non-empty paths" },
    { label: "empty path", entry: { ...packEntry, files: [{ path: "" }] }, error: "non-empty paths" },
    { label: "non-string path", entry: { ...packEntry, files: [{ path: 42 }] }, error: "non-empty paths" },
  ])("rejects metadata with $label in both npm formats", ({ entry, error }) => {
    for (const value of [[entry], { [packageName]: entry }]) {
      expect(() => normalizePackResult(value, packageName)).toThrow(error);
    }
  });
});
