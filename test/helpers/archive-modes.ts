import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { tarFixture } from "./archive-fuzz.js";

export type ModeEntry = { path: string; mode?: number | null; directory?: boolean };

// Only owned synthetic fixtures: assertions can fail before restoring traversal.
export async function removeModeFixture(directory: string): Promise<void> {
  await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeModeFixture(path.join(directory, entry.name));
  }
  await fs.rm(directory, { recursive: true, force: true });
}

export async function modeArchive(kind: "tar" | "zip", entries: ModeEntry[]): Promise<Buffer> {
  if (kind === "tar") {
    return tarFixture(entries.map((entry) => ({
      path: entry.path, mode: entry.mode ?? undefined,
      type: entry.directory ? "5" : "0", body: entry.directory ? "" : "NEW",
    })));
  }
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.directory ? "" : "NEW", {
      dir: entry.directory, createFolders: false,
    });
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  let offset = bytes.readUInt32LE(bytes.length - 6);
  for (const entry of entries) {
    // JSZip's writer defaults zero modes. Set real central attributes explicitly.
    bytes[offset + 5] = entry.mode == null ? 0 : 3;
    bytes.writeUInt32LE((((entry.mode ?? 0) << 16) | (entry.directory ? 0x10 : 0)) >>> 0, offset + 38);
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return bytes;
}
