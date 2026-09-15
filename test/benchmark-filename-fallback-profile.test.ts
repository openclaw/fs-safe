import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  FILENAME_FALLBACK_CASES,
  expectedWorkloadSemantics,
  observeFilenameFallbackProfile,
  profileForFilenameSource,
  registerFilenameFallbackBenchmarks,
} from "../benchmarks/filename-fallback-profile.mjs";
import { LONG_NAME_BENCHMARK_NAMES } from "../benchmarks/collections.mjs";

const LEGACY_SOURCE = Buffer.from(`
export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) { return fallbackName; }
  return trimmed;
}
`);
const SANITIZED_SOURCE = Buffer.from(`
function sanitizeFileNameCandidate(value: string) { return value; }
export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  return sanitizeFileNameCandidate(fileName) ?? sanitizeFileNameCandidate(fallbackName) ?? "file";
}
`);

function sanitizer(profile: "legacy" | "sanitized") {
  return (primary: string, fallback: string) => {
    const row = FILENAME_FALLBACK_CASES.find((entry) =>
      entry.primary === primary && entry.fallback === fallback);
    if (!row) throw new Error("unknown fixture input");
    return row.expected[profile];
  };
}

describe("filename fallback benchmark profiles", () => {
  it("keeps the exact ordered 17-row sanitizer contract", () => {
    expect(FILENAME_FALLBACK_CASES.map(({ name }) => name)).toEqual([
      "sanitizeUntrustedFileName",
      "sanitizeUntrustedFileName/fallback",
      "sanitizeUntrustedFileName/matrix/primary-empty",
      "sanitizeUntrustedFileName/matrix/primary-whitespace",
      "sanitizeUntrustedFileName/matrix/primary-punctuation",
      "sanitizeUntrustedFileName/matrix/primary-controls",
      "sanitizeUntrustedFileName/matrix/primary-mixed",
      "sanitizeUntrustedFileName/matrix/fallback-path",
      "sanitizeUntrustedFileName/matrix/fallback-windows-path",
      "sanitizeUntrustedFileName/matrix/fallback-device",
      "sanitizeUntrustedFileName/matrix/fallback-padded-device",
      "sanitizeUntrustedFileName/matrix/fallback-ascii-199",
      "sanitizeUntrustedFileName/matrix/fallback-ascii-200",
      "sanitizeUntrustedFileName/matrix/fallback-ascii-201",
      "sanitizeUntrustedFileName/matrix/fallback-unicode-200",
      "sanitizeUntrustedFileName/matrix/fallback-surrogate-boundary",
      "sanitizeUntrustedFileName/matrix/both-unusable",
    ]);
    expect(new Set(FILENAME_FALLBACK_CASES.map(({ name }) => name)).size).toBe(17);
    expect(FILENAME_FALLBACK_CASES.filter(({ name }) =>
      name.includes("sanitizeUntrustedFileName"))).toHaveLength(17);
    expect(FILENAME_FALLBACK_CASES.filter(({ workloadSemantics }) =>
      workloadSemantics === "equivalent-output")).toHaveLength(10);
  });

  it("derives expectations from tracked source forms, independently of behavior", () => {
    expect(profileForFilenameSource("1".repeat(40), LEGACY_SOURCE)).toBe("legacy");
    expect(profileForFilenameSource("2".repeat(40), SANITIZED_SOURCE)).toBe("sanitized");
    expect(() => profileForFilenameSource("3".repeat(40), Buffer.from("export const value = 1;")))
      .toThrow("Unrecognized or ambiguous");
    expect(() => profileForFilenameSource("4".repeat(40), Buffer.from(
      `${LEGACY_SOURCE.toString()}\n${SANITIZED_SOURCE.toString()}`,
    ))).toThrow("Unrecognized or ambiguous");
    expect(() => profileForFilenameSource(
      "0f7e5c08c5f3d9aa956f9c6a5b3468c8d946f2de",
      SANITIZED_SOURCE,
    )).toThrow("Known src/filename.ts blob changed profile");
  });

  it("recognizes only complete legacy or sanitized behavioral matrices", () => {
    expect(observeFilenameFallbackProfile(sanitizer("legacy"))).toBe("legacy");
    expect(observeFilenameFallbackProfile(sanitizer("sanitized"))).toBe("sanitized");
    expect(() => observeFilenameFallbackProfile(() => "unexpected"))
      .toThrow("unknown or ambiguous profile");
  });

  it("rejects an unselected bad row before registering any timed output", () => {
    const correct = sanitizer("sanitized");
    const registered: string[] = [];
    const bad = (primary: string, fallback: string) =>
      fallback === "../.." ? "unexpected" : correct(primary, fallback);
    expect(() => registerFilenameFallbackBenchmarks({
      sanitize: bad,
      register: (name: string) => registered.push(name),
      expectedProfile: "sanitized",
      observedProfile: "sanitized",
    })).toThrow("both-unusable");
    expect(registered).toEqual([]);
  });

  it("binds every registered row to its planned expectation and semantics", () => {
    const registrations: Array<{ name: string; options: Record<string, unknown> }> = [];
    expect(() => registerFilenameFallbackBenchmarks({
      sanitize: sanitizer("legacy"),
      register: () => undefined,
      expectedProfile: "sanitized",
      observedProfile: "legacy",
    })).toThrow("does not match");
    registerFilenameFallbackBenchmarks({
      sanitize: sanitizer("sanitized"),
      register: (name: string, _run: unknown, options: Record<string, unknown>) =>
        registrations.push({ name, options }),
      expectedProfile: "sanitized",
      observedProfile: "sanitized",
    });
    expect(registrations.map(({ name }) => name))
      .toEqual(FILENAME_FALLBACK_CASES.map(({ name }) => name));
    expect(registrations.map(({ options }) => options.workloadSemantics))
      .toEqual(FILENAME_FALLBACK_CASES.map(({ workloadSemantics }) => workloadSemantics));
  });

  it("keeps four equivalent-output long-name endpoint sentinels", async () => {
    expect(LONG_NAME_BENCHMARK_NAMES).toEqual([
      "writeViaSiblingTempPath/long-name-ascii",
      "writeExternalFileWithinRoot/long-name-ascii",
      "writeViaSiblingTempPath/long-name-unicode",
      "writeExternalFileWithinRoot/long-name-unicode",
    ]);
    expect(LONG_NAME_BENCHMARK_NAMES.map(expectedWorkloadSemantics))
      .toEqual(Array(4).fill("equivalent-output"));
    expect(LONG_NAME_BENCHMARK_NAMES.filter((name) => name.includes("long-name-")))
      .toHaveLength(4);
    const source = await readFile("benchmarks/collections.mjs", "utf8");
    expect(source).toContain('["NFC", "NFD"]');
    expect(source).toContain('component.endsWith(".txt.part")');
    expect(source).toContain("Math.max(...normalizedBytes) <= 255");
    expect(source).toContain("fs.existsSync(stagedPath), false");
    expect(source).toContain('workloadSemantics: "equivalent-output"');
  });
});
