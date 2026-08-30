import { tarFixture, type TarFixtureEntry } from "./archive-fuzz.js";
import { paxHeader } from "./archive-pax.js";

export function gnu(type: "L" | "K", body: string | Buffer): TarFixtureEntry {
  return { path: "././@LongLink", type, body };
}

const file = { path: "raw", body: "value" };
const link = { path: "raw-link", type: "2", linkPath: "target" };
export const invalidGnu = [
  ...(["L", "K"] as const).flatMap((type) => [
    ...[
      ["empty", Buffer.alloc(0)],
      ["NUL-only", Buffer.from([0])],
      ["embedded NUL suffix", Buffer.from("safe\0../hidden\0")],
      ["two terminal NULs", Buffer.from("safe\0\0")],
      ["bytes after NUL", Buffer.from("safe\0hidden")],
      ["invalid UTF-8", Buffer.from([0x73, 0xc3, 0x28])],
      ["truncated UTF-8", Buffer.from([0x73, 0xe2, 0x82])],
    ].map(([name, body]) => ({
      name: `${type} ${name}`, entries: [gnu(type, body as Buffer), type === "L" ? file : link],
      code: "archive-header-invalid",
    })),
    { name: `${type} repeated`, entries: [gnu(type, "one"), gnu(type, "two"), link], code: "archive-header-invalid" },
    { name: `${type} dangling`, entries: [gnu(type, "safe")], code: "archive-header-invalid" },
    { name: `${type} before PAX`, entries: [gnu(type, "safe"), paxHeader([["path", "safe"]]), file], code: "archive-header-invalid" },
    { name: `${type} after PAX`, entries: [paxHeader([["path", "safe"]]), gnu(type, "safe"), file], code: "archive-header-invalid" },
    { name: `${type} repeated across pair`, entries: [gnu(type, "one"), gnu(type === "L" ? "K" : "L", "two"), gnu(type, "three"), link], code: "archive-header-invalid" },
  ]),
  ...["pkg/../hidden", "pkg\\..\\hidden", "/hidden", "\\hidden", "C:hidden", "pkg/C:hidden"].map((raw) => ({
    name: `unsafe L ${raw}`, entries: [gnu("L", raw), file], code: "entry-path",
  })),
];

export const validGnu = [
  ...[false, true].flatMap((nul) => [
    { name: `L terminal NUL=${nul}`, entries: [gnu("L", `./pkg//caf\u00e9${nul ? "\0" : ""}`), file], paths: ["pkg/caf\u00e9"], kind: "file", size: 5 },
    { name: `K terminal NUL=${nul}`, entries: [gnu("K", `../caf\u00e9${nul ? "\0" : ""}`), link], paths: ["raw-link"], kind: "symlink", size: 0 },
  ]),
  ...[false, true].map((reverse) => ({
    name: `L+K reverse=${reverse}`,
    entries: [...(reverse ? [gnu("K", "../target\0"), gnu("L", ".\\pkg//link")] : [gnu("L", ".\\pkg//link\0"), gnu("K", "../target")]), link],
    paths: ["pkg/link"], kind: "symlink", size: 0,
  })),
  { name: "L state clears at member", entries: [gnu("L", "pkg/one"), file, gnu("L", "pkg/two\0"), file], paths: ["pkg/one", "pkg/two"], kind: "file", size: 5 },
  { name: "K state clears at member", entries: [gnu("K", "one"), link, gnu("K", "two\0"), { ...link, path: "second-link" }], paths: ["raw-link", "second-link"], kind: "symlink", size: 0 },
];

export const tarKindFixtures = [
  ...["3", "4", "6"].map((type) => ({ name: `blocked ${type}`, entries: [{ path: ".\\pkg//special", type }] })),
  { name: "GNUDumpDir", entries: [{ path: "./pkg//directory/", type: "D", mode: 0o755 }] },
  { name: "GNUDumpDir payload", entries: [{ path: "./pkg//directory/", body: "opaque", mode: 0o755, mutateHeader: (header: Buffer) => { header[156] = 0x44; } }] },
];

export function gnuFixture(entries: TarFixtureEntry[]): Buffer {
  return tarFixture([{ path: "keep", body: "keep" }, ...entries]);
}
