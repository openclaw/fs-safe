import { ArchiveFormatError } from "./archive-errors.js";
import { validateArchiveEntryPath } from "./archive-entry.js";

// Keep the byte grammar aligned with native/src/tar_meter.rs. Parsers differ
// on embedded NULs and malformed UTF-8, so validate before either sees a name.
export function validateGnuMetadata(body: Buffer, type: "L" | "K"): void {
  const value = body.at(-1) === 0 ? body.subarray(0, -1) : body;
  if (!value.length || value.includes(0)) {
    throw new ArchiveFormatError("invalid GNU metadata: empty name or embedded NUL");
  }
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    throw new ArchiveFormatError("invalid GNU metadata: name is not valid UTF-8");
  }
  if (type === "L") validateArchiveEntryPath(name);
}
