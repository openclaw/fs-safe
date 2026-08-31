import { tarFixture, type TarFixtureEntry } from "./archive-fuzz.js";
import { paxHeader } from "./archive-pax.js";

export const admissionCases: Record<string, { bytes: Buffer; code?: string; directory?: boolean }> = {};
export const routeAdmissionCases = [
  "V checksum", "? checksum", "metadata checksum before body",
  "V name UTF8 c328 replacement=none", "? prefix UTF8 e282 replacement=GNU",
  "? name UTF8 c328 replacement=PAX", "V prefix UTF8 c328 replacement=none",
  "0 linkname NUL suffix", "0 Hangul replaced",
  "0 GNU trailing /", "V GNU trailing /", "? GNU trailing \\", "5 GNU trailing /", "D GNU trailing \\",
];
export const routeLinknameCases = [
  ...["L", "K", "x", "V", "?", "0", "5"].map((type) => `${type} forbidden raw linkname`),
  "1 missing raw linkname", "2 missing raw linkname",
  ...["1", "2", "L", "K", "x"].map((type) => `${type} valid raw linkname`),
  "L strict raw linkname c328", "2 strict raw linkname 6b6565700068696464656e",
  "1 missing raw linkname after K", "2 missing raw linkname after x",
];
const keep = { path: "keep", body: "keep" };
const gnu = (name: string): TarFixtureEntry => ({ path: "LongName", type: "L", body: `${name}\0` });

for (const type of ["0", "V", "?"]) {
  const raw = (mutateHeader?: (header: Buffer) => void): TarFixtureEntry => ({ path: "raw", mutateHeader(header) {
    header[156] = type.charCodeAt(0); mutateHeader?.(header);
  } });
  const corrupt = tarFixture([keep, raw()]);
  corrupt[1024] ^= 1;
  admissionCases[`${type} checksum`] = { bytes: corrupt, code: "archive-header-invalid" };
  admissionCases[`${type} forbidden linkname`] = {
    bytes: tarFixture([keep, raw((header) => { header.write("target", 157); })]), code: "archive-header-invalid",
  };
  admissionCases[`${type} linkname NUL suffix`] = {
    bytes: tarFixture([keep, raw((header) => { header.write("safe\0hidden", 157); })]), code: "entry-path",
  };
  for (const field of ["name", "prefix", "linkname"]) {
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xe2, 0x82])]) {
      for (const replacement of ["none", "GNU", "PAX"]) {
        admissionCases[`${type} ${field} UTF8 ${bytes.toString("hex")} replacement=${replacement}`] = {
          bytes: tarFixture([keep, ...(replacement === "none" ? [] : [replacement === "GNU" ? gnu("safe") : paxHeader([["path", "safe"]])]), raw((header) => {
            const offset = field === "name" ? 0 : field === "prefix" ? 345 : 157;
            header.fill(0, offset, offset + (field === "prefix" ? 130 : 100));
            bytes.copy(header, offset);
          })]), code: "entry-path",
        };
      }
    }
  }
  admissionCases[`${type} Hangul replaced`] = {
    bytes: tarFixture([keep, gnu("safe"), { ...raw(), path: "각".repeat(30) }]), code: "entry-path",
  };
}

for (const type of ["0", "V", "?", "5", "D"]) {
  for (const separator of ["/", "\\"]) {
    const directory = type === "5" || type === "D";
    admissionCases[`${type} GNU trailing ${separator}`] = {
      bytes: tarFixture([keep, gnu(`./pkg//directory${separator}`), { path: "raw", type }]),
      ...(directory ? { directory } : { code: "archive-header-invalid" }),
    };
  }
}

const corruptMetadata = tarFixture([paxHeader([["path", "safe"]]), { path: "raw" }]);
corruptMetadata[0] ^= 1;
admissionCases["metadata checksum before body"] = { bytes: corruptMetadata, code: "archive-header-invalid" };

export const linknameCases: Record<string, { bytes: Buffer; code?: string; kind?: "file" | "symlink" }> = {};
for (const type of ["0", "1", "2", "3", "4", "5", "6", "7", "D", "A", "I", "M", "S", "V", "?", "L", "K", "x", "g", "X", "N"]) {
  const isLink = type === "1" || type === "2";
  const metadata: TarFixtureEntry | undefined = type === "L" ? gnu("member")
    : type === "K" ? { path: "LongLink", type, body: "keep\0" }
    : type === "x" ? paxHeader([["path", "member"]]) : undefined;
  const member: TarFixtureEntry = { path: "member", type: type === "K" ? "2" : "0", ...(type === "K" ? { linkPath: "keep" } : {}) };
  const raw = metadata ?? { path: "member", type };
  linknameCases[`${type} ${isLink ? "missing" : "forbidden"} raw linkname`] = {
    bytes: tarFixture([keep, { ...raw, linkPath: isLink ? "" : "keep" }, ...(metadata ? [member] : [])]),
    code: "archive-header-invalid",
  };
  if (isLink || metadata) {
    linknameCases[`${type} valid raw linkname`] = {
      bytes: tarFixture([keep, { ...raw, linkPath: isLink ? "keep" : "" }, ...(metadata ? [member] : [])]),
      kind: isLink || type === "K" ? "symlink" : "file",
    };
    for (const value of [Buffer.from([0xc3, 0x28]), Buffer.from("keep\0hidden")]) {
      linknameCases[`${type} strict raw linkname ${value.toString("hex")}`] = {
        bytes: tarFixture([keep, { ...raw, mutateHeader(header) { value.copy(header, 157); } }, ...(metadata ? [member] : [])]),
        code: "entry-path",
      };
    }
  }
}

// Effective link targets cannot repair a missing raw target on the member.
for (const type of ["1", "2"]) {
  for (const metadata of [
    { path: "LongLink", type: "K", body: "keep\0" },
    paxHeader([["linkpath", "keep"]]),
  ]) {
    linknameCases[`${type} missing raw linkname after ${metadata.type}`] = {
      bytes: tarFixture([keep, metadata, { path: "member", type }]), code: "archive-header-invalid",
    };
  }
}

// Each component is legal; the nearly 1 MiB effective path must hit the
// retained-manifest budget before output depth/collision/filter policy.
export const nearMaxPath = Array.from({ length: 4095 }, () => "a".repeat(255)).join("/");
export function manifestMember(extension: "GNU" | "PAX", effective = nearMaxPath): Buffer {
  return tarFixture([
    extension === "GNU" ? gnu(effective) : paxHeader([["path", effective]]),
    { path: "raw" },
  ], false);
}

export const manifestMemberCount = 33;
export function manifestArchive(extension: "GNU" | "PAX"): Buffer {
  return Buffer.concat([...Array.from({ length: manifestMemberCount }, (_, index) =>
    manifestMember(extension, nearMaxPath.slice(0, -3) + String(index).padStart(3, "0"))), Buffer.alloc(1024)]);
}
