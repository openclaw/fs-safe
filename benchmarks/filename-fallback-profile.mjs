import assert from "node:assert/strict";

const SOURCE_PROFILES = new Map([
  // main through 0ebb3798: the fallback is returned without sanitization.
  ["0f7e5c08c5f3d9aa956f9c6a5b3468c8d946f2de", "legacy"],
  // d02ec446: bounded fallback sanitization before the fixed-point repair.
  ["e14a89f1b991e0045b2d9377aacea55020174e1c", "sanitized"],
  // f6351c94: bounded fallback sanitization with the fixed-point repair.
  ["0c3e526896fd8709e9def96751e8f0ae72e7de56", "sanitized"],
]);

const MATRIX = [
  ["sanitizeUntrustedFileName", "ordinary-safe-name.json", "fallback", "ordinary-safe-name.json", "ordinary-safe-name.json"],
  ["sanitizeUntrustedFileName/fallback", "<>", "fallback.json", "fallback.json", "fallback.json"],
  ["sanitizeUntrustedFileName/matrix/primary-empty", "", "fallback.json", "fallback.json", "fallback.json"],
  ["sanitizeUntrustedFileName/matrix/primary-whitespace", " \t\r\n", "fallback.json", "fallback.json", "fallback.json"],
  ["sanitizeUntrustedFileName/matrix/primary-punctuation", '<>:"|?*', "fallback.json", "fallback.json", "fallback.json"],
  ["sanitizeUntrustedFileName/matrix/primary-controls", "\u0000\u001f\u007f\u0085\u009f", "fallback.json", "fallback.json", "fallback.json"],
  ["sanitizeUntrustedFileName/matrix/primary-mixed", "<>report?.json", "fallback.json", "report.json", "report.json"],
  ["sanitizeUntrustedFileName/matrix/fallback-path", "<>", "../nested/fallback?.json", "../nested/fallback?.json", "fallback.json"],
  ["sanitizeUntrustedFileName/matrix/fallback-windows-path", "<>", "..\\nested\\fallback?.json", "..\\nested\\fallback?.json", "fallback.json"],
  ["sanitizeUntrustedFileName/matrix/fallback-device", "<>", "CON.txt", "CON.txt", "CON_.txt"],
  ["sanitizeUntrustedFileName/matrix/fallback-padded-device", "<>", "NUL   .txt", "NUL   .txt", "NUL   _.txt"],
  ["sanitizeUntrustedFileName/matrix/fallback-ascii-199", "<>", "a".repeat(199), "a".repeat(199), "a".repeat(199)],
  ["sanitizeUntrustedFileName/matrix/fallback-ascii-200", "<>", "a".repeat(200), "a".repeat(200), "a".repeat(200)],
  ["sanitizeUntrustedFileName/matrix/fallback-ascii-201", "<>", "a".repeat(201), "a".repeat(201), "a".repeat(200)],
  ["sanitizeUntrustedFileName/matrix/fallback-unicode-200", "<>", "é".repeat(200), "é".repeat(200), "é".repeat(200)],
  ["sanitizeUntrustedFileName/matrix/fallback-surrogate-boundary", "<>", `${"a".repeat(199)}😀`, `${"a".repeat(199)}😀`, "a".repeat(199)],
  ["sanitizeUntrustedFileName/matrix/both-unusable", "<>", "../..", "../..", "file"],
].map(([name, primary, fallback, legacy, sanitized]) => Object.freeze({
  name,
  primary,
  fallback,
  expected: Object.freeze({ legacy, sanitized }),
  workloadSemantics: legacy === sanitized ? "equivalent-output" : "changed-output",
}));

export const FILENAME_FALLBACK_CASES = Object.freeze(MATRIX);
export const FILENAME_FALLBACK_PROFILES = Object.freeze(["legacy", "sanitized"]);

export function validateFilenameFallbackProfile(value, label = "filename fallback profile") {
  assert(FILENAME_FALLBACK_PROFILES.includes(value), `Unknown ${label}: ${JSON.stringify(value)}`);
  return value;
}

export function profileForFilenameSource(blobOid, bytes) {
  assert.match(blobOid, /^[0-9a-f]{40}$/u, "filename source blob must be a 40-hex Git object ID");
  assert(Buffer.isBuffer(bytes) && bytes.length > 0, "src/filename.ts bytes are required");
  const source = bytes.toString("utf8");
  assert(!source.includes("\u0000"), "src/filename.ts contains a NUL byte");
  const sanitized = /sanitizeFileNameCandidate\(fileName\)\s*\?\?\s*sanitizeFileNameCandidate\(fallbackName\)\s*\?\?/u.test(source) &&
    /function\s+sanitizeFileNameCandidate\s*\(/u.test(source);
  const legacy = /export\s+function\s+sanitizeUntrustedFileName\s*\(/u.test(source) &&
    /if\s*\(!trimmed\)\s*\{\s*return\s+fallbackName;\s*\}/u.test(source);
  assert.notEqual(sanitized, legacy, `Unrecognized or ambiguous src/filename.ts blob: ${blobOid}`);
  const profile = sanitized ? "sanitized" : "legacy";
  const known = SOURCE_PROFILES.get(blobOid);
  if (known) assert.equal(profile, known, `Known src/filename.ts blob changed profile: ${blobOid}`);
  return profile;
}

export function observeFilenameFallbackProfile(sanitize) {
  assert.equal(typeof sanitize, "function", "sanitizeUntrustedFileName must be callable");
  const matching = FILENAME_FALLBACK_PROFILES.filter((profile) =>
    FILENAME_FALLBACK_CASES.every(({ primary, fallback, expected }) =>
      sanitize(primary, fallback) === expected[profile]));
  assert.equal(matching.length, 1, "Measured filename fallback behavior has an unknown or ambiguous profile");
  return matching[0];
}

export function expectedWorkloadSemantics(name) {
  const filenameCase = FILENAME_FALLBACK_CASES.find((entry) => entry.name === name);
  if (filenameCase) return filenameCase.workloadSemantics;
  if (/^(writeViaSiblingTempPath|writeExternalFileWithinRoot)\/long-name-(ascii|unicode)$/u.test(name)) {
    return "equivalent-output";
  }
  return undefined;
}

export function registerFilenameFallbackBenchmarks({ sanitize, register, expectedProfile, observedProfile }) {
  const expected = validateFilenameFallbackProfile(expectedProfile, "planned filename fallback profile");
  const observed = validateFilenameFallbackProfile(observedProfile, "observed filename fallback profile");
  assert.equal(observed, expected, "Observed filename fallback profile does not match the planned source profile");
  const outputs = FILENAME_FALLBACK_CASES.map((entry) => ({
    entry,
    output: sanitize(entry.primary, entry.fallback),
  }));
  for (const { entry, output } of outputs) {
    assert.equal(output, entry.expected[expected], `Unexpected ${expected} output for ${entry.name}`);
  }
  // Registration occurs only after every governed row has passed its eager
  // profile check. A later --filter therefore cannot hide a bad matrix row.
  for (const { entry } of outputs) {
    register(entry.name, () => sanitize(entry.primary, entry.fallback), {
      sync: true,
      batch: 100,
      workloadSemantics: entry.workloadSemantics,
      verify: (result) => assert.equal(result, entry.expected[expected]),
    });
  }
}
