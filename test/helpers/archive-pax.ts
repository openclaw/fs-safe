import { tarFixture, type TarFixtureEntry } from "./archive-fuzz.js";

export function paxRecord(key: string, value: string | Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(` ${key}=`), Buffer.from(value), Buffer.from("\n")]);
  let length = payload.length + 1;
  while (String(length).length + payload.length !== length) {
    length = String(length).length + payload.length;
  }
  return Buffer.concat([Buffer.from(String(length)), payload]);
}

export function paxHeader(records: ReadonlyArray<readonly [string, string | Buffer]>): TarFixtureEntry {
  return { path: "PaxHeader/member", type: "x", body: Buffer.concat(records.map(([key, value]) => paxRecord(key, value))) };
}

export function publicMetadata(): TarFixtureEntry {
  return paxHeader([
    ["mtime", "1787334189.823045922"],
    ["LIBARCHIVE.xattr.com.apple.provenance", "AQIAcwhBclAufnY"],
    ["SCHILY.xattr.com.apple.provenance", Buffer.from([1, 2, 0, 115, 8, 65, 114, 80, 46, 126, 118])],
  ]);
}

export function paxArchive(records: ReadonlyArray<readonly [string, string | Buffer]>, body = Buffer.from("payload"), rawSize = body.length): Buffer {
  return tarFixture([
    paxHeader(records),
    { path: "raw", body, mutateHeader: (header) => header.write(`${rawSize.toString(8).padStart(11, "0")}\0`, 124, "ascii") },
    { path: "sentinel", body: "end" },
  ]);
}
