import { types } from "node:util";
import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
import { stripArchivePath, validateArchiveEntryPath } from "./archive-entry.js";
import { updateCrc32 } from "./archive-crc32.js";

export function zipFormat(message: string): never {
  throw new ArchiveFormatError(`invalid ZIP metadata: ${message}`);
}

export function zipUInt64(bytes: Buffer, offset: number): number {
  if (offset + 8 > bytes.length) zipFormat("truncated ZIP64 field");
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) zipFormat("ZIP64 integer exceeds safe range");
  return Number(value);
}

export function zipExtraFields(bytes: Buffer): Map<number, Buffer> {
  const critical = new Map<number, Buffer>();
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) zipFormat("truncated extra field header");
    const id = bytes.readUInt16LE(offset); const length = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (length > bytes.length - offset) zipFormat("truncated extra field value");
    if (id === 1 || id === 0x7075) {
      if (critical.has(id)) zipFormat("duplicate critical extra field");
      critical.set(id, bytes.subarray(offset, offset + length));
    }
    offset += length;
  }
  return critical;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function utf8(bytes: Buffer): string {
  try { return utf8Decoder.decode(bytes); }
  catch { return zipFormat("invalid UTF-8 name"); }
}

// Canonical identity only; this does not replace raw path validation.
export function zipPathKey(name: string): string {
  if (name && name !== "." && !name.includes("/") && !name.includes("\\")) return name;
  return stripArchivePath(name, 0) ?? "";
}

function originalName(name: Buffer, rawName: string, flags: number): string | undefined {
  // ASCII path syntax is encoding-independent. Do not reinterpret legacy bytes
  // as UTF-8 (native ZIP uses CP437); the selected decoder still validates its name.
  const asciiName = rawName.replace(/[\x80-\xff]/g, "_");
  validateArchiveEntryPath(asciiName);
  if (!(flags & 0x800)) return undefined;
  if (asciiName === rawName && !types.isSharedArrayBuffer(name.buffer)) return rawName;
  const decoded = utf8(name); validateArchiveEntryPath(decoded);
  return decoded;
}

function unicodeName(name: Buffer, extra: Map<number, Buffer>): string | undefined {
  const field = extra.get(0x7075);
  if (!field) return undefined;
  if (field.length < 6 || field[0] !== 1) zipFormat("invalid Unicode Path field");
  if (field.readUInt32LE(1) !== updateCrc32(0, name)) zipFormat("Unicode Path CRC mismatch");
  const decoded = utf8(field.subarray(5)); validateArchiveEntryPath(decoded);
  return decoded;
}

export function admitZipNames(params: {
  central: Buffer; local: Buffer; flags: number;
  centralExtra: Map<number, Buffer>; localExtra: Map<number, Buffer>;
  seen: Set<string>;
}): { path?: string; portableKey: string; portableDirectory: boolean; directory: boolean } {
  const { central, local, flags, centralExtra, localExtra, seen } = params;
  if (!central.length || !local.length) zipFormat("empty entry name");
  // Reuse only within this synchronous call; shared backing bytes can change
  // concurrently even though admission does not yield while checking names.
  const sameName = !types.isSharedArrayBuffer(central.buffer) &&
    !types.isSharedArrayBuffer(local.buffer) && central.equals(local);
  const centralRaw = central.toString("latin1");
  const localRaw = sameName ? centralRaw : local.toString("latin1");
  const centralUtf8 = originalName(central, centralRaw, flags);
  const localUtf8 = sameName ? centralUtf8 : originalName(local, localRaw, flags);
  const centralUnicode = unicodeName(central, centralExtra);
  const centralField = centralExtra.get(0x7075); const localField = localExtra.get(0x7075);
  // Only immutable identical fields share their CRC-bound name admission.
  const sameUnicode = (!centralField || !types.isSharedArrayBuffer(centralField.buffer)) &&
    (!localField || !types.isSharedArrayBuffer(localField.buffer)) &&
    (centralField === localField ||
      (centralField !== undefined && localField !== undefined && centralField.equals(localField)));
  const localUnicode = sameName && sameUnicode ? centralUnicode : unicodeName(local, localExtra);
  const centralKey = zipPathKey(centralRaw);
  if (!sameName && centralKey !== zipPathKey(localRaw)) {
    zipFormat("central and local names disagree");
  }
  const interpretations = [centralUtf8, localUtf8, centralUnicode, localUnicode].filter(
    (value): value is string => value !== undefined,
  );
  // Canonical paths erase terminal separators. Preserve their kind meaning in
  // every interpretation, including Unicode overrides of legacy-encoded names.
  const directory = /[/\\]$/.test(centralRaw);
  if (/[/\\]$/.test(localRaw) !== directory ||
      interpretations.some((value) => /[/\\]$/.test(value) !== directory)) {
    zipFormat("conflicting terminal directory markers");
  }
  const firstInterpretation = interpretations[0];
  const interpretationKey = firstInterpretation === undefined ? undefined
    : firstInterpretation === centralRaw ? centralKey : zipPathKey(firstInterpretation);
  if (interpretations.some((value) => value !== interpretations[0] && zipPathKey(value) !== interpretationKey)) {
    zipFormat("conflicting Unicode name interpretations");
  }
  // JSZip checks the central Unicode field against the local name. A slash-only
  // spelling difference must not make one decoder ignore a meaningful override.
  if (centralUnicode && !central.equals(local) &&
      zipPathKey(centralUnicode) !== zipPathKey(local.toString("utf8"))) {
    zipFormat("Unicode override disagrees with local decoder name");
  }
  if (!centralUnicode && localUnicode && zipPathKey(localUnicode) !== zipPathKey(local.toString("utf8"))) {
    zipFormat("local-only Unicode override changes the name");
  }
  const unicodeKey = centralUnicode === undefined
    ? undefined : zipPathKey(Buffer.from(centralUnicode).toString("latin1"));
  if (seen.has(centralKey) ||
      (unicodeKey !== undefined && unicodeKey !== centralKey && seen.has(unicodeKey))) {
    throw new ArchiveSecurityError("entry-path", "zip archive contains duplicate or colliding entry names");
  }
  seen.add(centralKey);
  if (unicodeKey !== undefined && unicodeKey !== centralKey) seen.add(unicodeKey);
  const path = centralUnicode ?? centralUtf8 ?? (central.every((byte) => byte < 128) ? central.toString("ascii") : undefined);
  const portablePath = centralUnicode ?? localUtf8 ?? (sameName && path !== undefined ? path : local.toString("utf8"));
  // Reuse the admitted interpretation, never the Latin-1 Unicode collision key.
  // Unflagged legacy names can decode differently and need their own key.
  const portableKey = portablePath === centralRaw ? centralKey
    : interpretations.includes(portablePath) ? interpretationKey! : zipPathKey(portablePath);
  // JSZip prioritizes flagged local UTF-8 and checks a central Unicode field
  // against local bytes. Canonically equal names can end in different separators.
  const decoderPath = flags & 0x800 ? localUtf8!
    : centralUnicode !== undefined && (sameName || centralField!.readUInt32LE(1) === updateCrc32(0, local))
      ? centralUnicode : local.toString("utf8");
  return {
    path,
    portableKey,
    portableDirectory: decoderPath.endsWith("/"),
    directory,
  };
}
