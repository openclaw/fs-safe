import { tarFixture } from "./archive-fuzz.js";
import { paxHeader } from "./archive-pax.js";

const member = { path: "value", body: "payload" };
const prefix = tarFixture([member], false);
const hidden = tarFixture([{ path: "hidden" }], false);

export const malformedTarFraming: Array<[string, Buffer]> = [
  ["header after one zero block", Buffer.concat([prefix, Buffer.alloc(512), hidden, Buffer.alloc(1024)])],
  ["header after EOF", Buffer.concat([tarFixture([member]), hidden, Buffer.alloc(1024)])],
  ["byte after EOF", Buffer.concat([tarFixture([member]), Buffer.from([1])])],
  ["byte after partial zero padding", Buffer.concat([tarFixture([member]), Buffer.alloc(513), Buffer.from([1])])],
  ["missing EOF", prefix],
  ["one EOF block", Buffer.concat([prefix, Buffer.alloc(512)])],
  ["partial second EOF block", Buffer.concat([prefix, Buffer.alloc(1023)])],
  ["truncated header", hidden.subarray(0, 511)],
  ["truncated body", prefix.subarray(0, 515)],
  ["truncated body padding", prefix.subarray(0, 1023)],
];
for (const type of ["1", "2", "5"]) {
  for (const base256 of [false, true]) {
    const header = tarFixture([{
      path: "non-file", type, linkPath: type === "5" ? "" : "value",
      mutateHeader: (block) => {
        if (base256) {
          block.fill(0, 124, 136);
          block[124] = 0x80;
          block[135] = 0x01;
        } else block.write("00000000001\0", 124, "ascii");
      },
    }], false);
    // The claimed body is itself a valid header: parsers that discard the
    // non-file size see a member that the old raw meter skips as payload.
    malformedTarFraming.push([`type ${type} body/header smuggling (base256=${base256})`,
      Buffer.concat([header, hidden, prefix, Buffer.alloc(1024)])]);
  }
}
for (const field of ["0000000\0junk", "\t0000000001\0", "00000000008\0"]) {
  malformedTarFraming.push([`malformed size ${JSON.stringify(field)}`, tarFixture([{
    ...member, mutateHeader: (header) => { header.fill(0, 124, 136); header.write(field, 124, "ascii"); },
  }])]);
}

const declaredHeader = (size: number) => tarFixture([{
  path: "second", mutateHeader: (header) => { header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii"); },
}], false);
const memberLimits = { maxEntries: 2, maxEntryBytes: 7, maxExtractedBytes: 7 };
// All fixtures stop at the rejected header: admission must fail before asking
// for a missing body or EOF, independently of parser and compressor buffering.
export const tarBudgetCases = [
  { name: "oversized header", bytes: declaredHeader(8), limits: memberLimits, code: "archive-entry-extracted-size-exceeds-limit" },
  { name: "zero entries", bytes: declaredHeader(0), limits: { ...memberLimits, maxEntries: 0 }, code: "archive-entry-count-exceeds-limit" },
  { name: "second logical member", bytes: Buffer.concat([prefix, declaredHeader(1)]), limits: { ...memberLimits, maxEntries: 1 }, code: "archive-entry-count-exceeds-limit" },
  { name: "cumulative sizes", bytes: Buffer.concat([prefix, declaredHeader(1)]), limits: memberLimits, code: "archive-extracted-size-exceeds-limit" },
  { name: "larger effective PAX size", bytes: Buffer.concat([tarFixture([paxHeader([["size", "8"]])], false), declaredHeader(0)]), limits: memberLimits, code: "archive-entry-extracted-size-exceeds-limit" },
  { name: "cumulative PAX size", bytes: Buffer.concat([prefix, tarFixture([paxHeader([["size", "1"]])], false), declaredHeader(0)]), limits: memberLimits, code: "archive-extracted-size-exceeds-limit" },
];

export const numericTarFraming = [
  { name: "base-256 2^53", size: 9_007_199_254_740_992n, code: "archive-header-invalid" },
  { name: "base-256 safe integer with unsafe padding", size: 9_007_199_254_740_991n, code: "archive-header-invalid" },
  { name: "first unsafe padded size", size: 9_007_199_254_740_481n, code: "archive-header-invalid" },
  { name: "largest safe padded size", size: 9_007_199_254_740_480n, code: "archive-entry-extracted-size-exceeds-limit" },
].flatMap(({ name, size, code }) => {
  const raw = tarFixture([{
    path: "value", mutateHeader: (header) => {
      header.fill(0, 124, 136); header[124] = 0x80; header.writeBigUInt64BE(size, 128);
    },
  }], false);
  const result = [{ name, bytes: raw, code }];
  if (code === "archive-header-invalid") result.push({
    name: name + " despite PAX size=0", bytes: Buffer.concat([tarFixture([paxHeader([["size", "0"]])], false), raw]), code,
  });
  return result;
});
numericTarFraming.push({ name: "full-width valid octal exceeds budget", bytes: tarFixture([{
  path: "value", mutateHeader: (header) => { header.write("777777777777", 124, "ascii"); },
}], false), code: "archive-entry-extracted-size-exceeds-limit" });
