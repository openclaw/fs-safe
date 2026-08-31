import { tarFixture, type TarFixtureEntry } from "./archive-fuzz.js";
import { paxHeader } from "./archive-pax.js";
import { unicodePath, zipRecords, type ZipRecord } from "./zip-records.js";

const aliases = [
  { raw: "./pkg//repeated", canonical: "pkg/repeated", body: "repeated" },
  { raw: "././pkg/./dot", canonical: "pkg/dot", body: "dot" },
  { raw: ".\\pkg\\backslash", canonical: "pkg/backslash", body: "backslash" },
];
export const tarReadMembers = [
  ...aliases,
  { raw: "././pkg//pax-effective", canonical: "pkg/pax-effective", body: "pax" },
  { raw: ".\\pkg//./gnu-café", canonical: "pkg/gnu-café", body: "gnu" },
  { raw: "./pkg//./legacy", canonical: "pkg/legacy", body: "legacy" },
];
export const zipReadMembers = [
  ...aliases,
  { raw: ".\\pkg//./café", canonical: "pkg/café", body: "unicode" },
];
const oldFile = (path: string, body: string): TarFixtureEntry => ({
  path, body, mutateHeader(header) { header[156] = 0; },
});
const effectiveZip = (raw: string, effective: string, body: string): ZipRecord => ({
  name: raw, body, extra: unicodePath(Buffer.from(raw), effective),
});
const [pax, gnu, legacy] = tarReadMembers.slice(3);
const unicode = zipReadMembers[3]!;

export const tarReadArchives = {
  members: tarFixture([
    ...aliases.map(({ raw, body }) => ({ path: raw, body })),
    paxHeader([["path", pax!.raw]]), { path: "pax-raw", body: pax!.body },
    { path: "LongName", type: "L", body: `${gnu!.raw}\0` }, { path: "gnu-raw", body: gnu!.body },
    oldFile(legacy!.raw, legacy!.body),
  ]),
  collision: tarFixture([
    { path: "keep", body: "keep" },
    { path: "LongName", type: "L", body: "./pkg//value\0" }, oldFile("raw", "first"),
    { path: "pkg/./value", body: "second" },
  ]),
  nonfiles: tarFixture([
    { path: "keep", body: "keep" },
    { path: "./pkg//directory/", type: "5" },
    { path: ".\\pkg/./hardlink", type: "1", linkPath: "keep" },
    { path: "./pkg//symlink", type: "2", linkPath: "keep" },
    { path: "LongName", type: "L", body: ".\\pkg//./volume\0" }, { path: "volume-raw", type: "V" },
    { path: "./pkg//unknown", type: "?" },
  ]),
  unsafe: tarFixture([
    { path: "keep", body: "keep" },
    { path: "LongName", type: "L", body: "safe\0" }, { path: "pkg/../escape", body: "bad" },
  ]),
};
export const zipReadArchives = {
  members: zipRecords([
    ...aliases.map(({ raw, body }) => ({ name: raw, body })),
    effectiveZip("legacy", unicode.raw, unicode.body),
  ]),
  collision: zipRecords([
    { name: "keep", body: "keep" }, effectiveZip("legacy", "./pkg//value", "first"),
    { name: "pkg/./value", body: "second" },
  ]),
  nonfiles: zipRecords([
    { name: "keep", body: "keep" },
    { name: "./pkg//directory/", attributes: 0x41ed0010, body: "" },
    { name: ".\\pkg//symlink", attributes: 0xa1ff0000, body: "keep" },
  ]),
  unsafe: zipRecords([{ name: "keep", body: "keep" }, effectiveZip("pkg/../escape", "safe", "bad")]),
};
