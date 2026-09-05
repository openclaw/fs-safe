import { Pax } from "tar";
import { paxHeader, paxRecord } from "./archive-pax.js";
import { tarFixture } from "./archive-fuzz.js";

export const unicodeNames = ["雪.txt", "café", "\ufeffBOM", "0", "123", "1e3", "01", "0x10", "-1", "1.0", "line\n.txt"];
export function unifiedFixture(name: string, rawSize = 1, size = 700, alignment?: number, sizeFirst = false) {
  const payload = Buffer.alloc(size, 0xa7);
  // Exercise the real npm producer's record encoder, not only our fixture encoder.
  const pathRecord = Buffer.from(new Pax({ path: name }).encodeBody());
  let prefix = Buffer.alloc(0);
  if (alignment !== undefined) {
    const valueOffset = pathRecord.indexOf(Buffer.from(name));
    for (let count = 0; count < 1024; count++) {
      const candidate = paxRecord("SCHILY.xattr.pad", "a".repeat(count));
      if (candidate.length + valueOffset === alignment) { prefix = candidate; break; }
    }
    if (!prefix.length) throw new Error("could not align fixture");
  }
  const binary = paxRecord("SCHILY.xattr.binary", Buffer.from([0xff, 0, 10, 0xfe]));
  const effectiveSize = paxRecord("size", String(size));
  const body = Buffer.concat([prefix, pathRecord, ...(sizeFirst ? [effectiveSize, binary] : [binary, effectiveSize])]);
  const bytes = tarFixture([
    { path: "PaxHeader", type: "x", body },
    { path: "raw", body: payload, mutateHeader(header) { header.write(`${rawSize.toString(8).padStart(11, "0")}\0`, 124); } },
    { path: "sentinel", body: "end" },
  ]);
  return { name, payload, bytes };
}
export function rawUnicodeFixture(name: string) {
  return tarFixture([paxHeader([["mtime", "1.25"]]), { path: name, body: "raw payload" }, { path: "sentinel", body: "end" }]);
}
