import { tarFixture, type TarFixtureEntry } from "./archive-fuzz.js";
import { paxHeader } from "./archive-pax.js";

export const ignoredTypes = ["V", "A", "I", "M", "?"] as const;
export const unsafeIgnoredPaths = ["../bad", "pkg/../bad", "pkg\\..\\bad", "/bad", "\\bad", "C:bad", "pkg/C:bad", "safe\0hidden"];
export const ignoredAliases = ["./pkg//opaque", "pkg\\opaque", ".\\pkg/./opaque"];
export const unsafeIgnoredCases = [
  ...unsafeIgnoredPaths.map((raw) => `raw ${raw}`),
  ...unsafeIgnoredPaths.filter((raw) => !raw.includes("\0")).map((raw) => `GNU ${raw}`),
  "prefix", "prefix NUL", "GNU hides raw", "GNU overlong",
];
export function ignoredIntegrationCases(type: string, full: boolean) {
  return {
    aliases: full ? ignoredAliases : [ignoredAliases[0]!],
    unsafe: full ? unsafeIgnoredCases : ["raw pkg/../bad", "GNU overlong"],
    pax: full ? ["./pkg//effective", "pkg/../bad", "safe\0hidden"] : ["pkg/../bad"],
    collisions: full ? Object.keys(ignoredArchives).filter((key) => key.startsWith(`${type} collision `))
      : [`${type} collision pkg/alias ${type === "V" ? "ignored-visible" : "ignored-ignored"} 0`],
  };
}
export const keep = { path: "pkg/keep", body: "keep" };

export function ignored(type: string, path = "pkg/opaque", body = "ignored"): TarFixtureEntry {
  return { path, body, mutateHeader: (header) => { header[156] = type.charCodeAt(0); } };
}

export const ignoredArchives: Record<string, Buffer> = {};
function add(name: string, entries: TarFixtureEntry[]) {
  ignoredArchives[name] = tarFixture(entries);
}

for (const type of ignoredTypes) {
  add(`${type} order`, [ignored(type, "pkg/first"), keep, ignored(type, "pkg/last"), { path: "pkg/end", body: "end" }]);
  add(`${type} stripped`, [ignored(type, "opaque"), keep]);
  add(`${type} depth`, [ignored(type, "pkg/a/b/c"), keep]);
  add(`${type} all ignored`, [ignored(type, "one"), ignored(type, "two")]);
  for (const alias of ignoredAliases) add(`${type} alias ${alias}`, [ignored(type, alias), keep]);
  for (const unsafe of unsafeIgnoredPaths) {
    add(`${type} raw ${unsafe}`, [keep, ignored(type, unsafe)]);
    if (!unsafe.includes("\0")) {
      add(`${type} GNU ${unsafe}`, [keep, { path: "LongName", type: "L", body: `${unsafe}\0` }, ignored(type)]);
    }
  }
  add(`${type} prefix`, [keep, { ...ignored(type), mutateHeader: (header) => {
    header[156] = type.charCodeAt(0); header.write("../prefix", 345);
  } }]);
  add(`${type} prefix NUL`, [keep, { ...ignored(type), mutateHeader: (header) => {
    header[156] = type.charCodeAt(0); header.write("safe\0hidden", 345);
  } }]);
  add(`${type} GNU safe`, [keep, { path: "LongName", type: "L", body: ".\\pkg//effective\0" }, ignored(type), { path: "pkg/after", body: "after" }]);
  add(`${type} GNU hides raw`, [keep, { path: "LongName", type: "L", body: "safe\0" }, ignored(type, "pkg/../bad")]);
  add(`${type} GNU overlong`, [keep, { path: "LongName", type: "L", body: "x".repeat(256) }, ignored(type)]);
  for (const effective of ["./pkg//effective", "pkg/../bad", "safe\0hidden"]) {
    add(`${type} PAX ${effective}`, [keep, paxHeader([["path", effective], ["size", "7"]]), ignored(type)]);
  }
  for (const [first, second, strip] of [
    ["pkg/alias", "./pkg//alias", 0], ["pkg/same", "PKG/SAME", 0],
    ["pkg/caf\u00e9", "pkg/cafe\u0301", 0], ["first/same", "second/same", 1],
  ] as const) {
    for (const order of ["ignored-visible", "visible-ignored", "ignored-ignored"] as const) {
      const a = order === "visible-ignored" ? { path: first } : ignored(type, first);
      const b = order === "ignored-visible" ? { path: second } : ignored(type, second);
      add(`${type} collision ${first} ${order} ${strip}`, [a, b]);
    }
  }
}
