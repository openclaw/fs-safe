import fc, { type Parameters } from "fast-check";

export const PROPERTY_SEED = 0x5eed_c0de;

const WINDOWS_RESERVED_ARCHIVE_NAMES = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
] as const;

export const WINDOWS_ARCHIVE_PORTABILITY_NAMES = [
  ...WINDOWS_RESERVED_ARCHIVE_NAMES.flatMap((name) => [name, `${name}.txt`]),
  "NUL.",
  "NUL ",
  "CON.txt.",
  "CON.txt ",
  "COM1.",
  "COM1 ",
  "LPT9.txt.",
  "LPT9.txt ",
  "file:stream",
  "file.txt:stream",
  "nested/file:stream",
  "éc:relative",
] as const;

export const windowsArchivePortabilityName = fc.constantFrom(
  ...WINDOWS_ARCHIVE_PORTABILITY_NAMES,
);

export function propertyParameters(numRuns: number): Parameters<unknown> {
  return {
    numRuns,
    seed: PROPERTY_SEED,
    verbose: 2,
  };
}

const PATH_TOKENS = [
  "",
  ".",
  "..",
  "...",
  "/",
  "\\",
  "//",
  "\\\\",
  "C:",
  "C:relative",
  "c:relative",
  "//server/share",
  "\\\\server\\share",
  "%2e%2e",
  "%252e%252e%252f",
  " ",
  "\t",
  "\0",
  "é",
  "e\u0301",
  "a.",
  "a ",
  "CON",
  "nul.txt",
  "safe",
] as const;

const tokenPath = fc
  .array(fc.constantFrom(...PATH_TOKENS), { minLength: 0, maxLength: 10 })
  .map((tokens) => tokens.join(""));

export const adversarialPath = fc.oneof(
  { depthIdentifier: "path-kind" },
  tokenPath,
  windowsArchivePortabilityName,
  fc.constantFrom(
    "",
    ".",
    "./",
    "../escape",
    "nested/../../escape",
    "nested\\..\\..\\escape",
    "/absolute",
    "//server/share/file",
    "\\\\server\\share\\file",
    "C:\\absolute",
    "C:relative",
    "nested/C:relative",
    "safe//child",
    "safe/./child",
    "safe/../child",
    "safe/child/",
    " safe/child",
    "safe/child ",
    "safe./child",
    "safe/child.",
    "café/value",
    "cafe\u0301/value",
    `long/${"x".repeat(256)}`,
    "nul\0byte",
  ),
);

const safePart = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-"), {
    minLength: 1,
    maxLength: 12,
  })
  .map((characters) => characters.join(""));

export const aliasingPathPair = fc.oneof(
  fc.tuple(safePart, safePart).map(([parent, child]) => [
    `${parent}/${child}`,
    `${parent}//${child}`,
  ] as const),
  fc.tuple(safePart, safePart).map(([parent, child]) => [
    `${parent}/${child}`,
    `${parent}/./${child}`,
  ] as const),
  fc.tuple(safePart, safePart).map(([parent, child]) => [
    `${parent}/${child}`,
    `./${parent}/${child}`,
  ] as const),
  safePart.map((part) => [`${part}/café`, `${part}/cafe\u0301`] as const),
  safePart.map((part) => [`${part}/value`, `${part}/value.`] as const),
  safePart.map((part) => [`${part}/value`, `${part}/value `] as const),
);

export const archiveAliasingPathPair = fc.oneof(
  fc.tuple(safePart, safePart).map(([parent, child]) => [
    `${parent}/${child}`,
    `${parent}//${child}`,
  ] as const),
  fc.tuple(safePart, safePart).map(([parent, child]) => [
    `${parent}/${child}`,
    `${parent}/./${child}`,
  ] as const),
  safePart.map((part) => [`${part}/café`, `${part}/cafe\u0301`] as const),
);
