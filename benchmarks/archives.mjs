import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";

export async function registerArchives({ api: a, workspace: w, register: add }) {
  const source = path.join(w, "archive-source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "entry.json"), '{"ok":true}');
  const zip = new JSZip();
  zip.file("entry.json", '{"ok":true}');
  const zipBytes = await zip.generateAsync({ type: "nodebuffer" });
  const zipPath = path.join(w, "fixture.zip");
  fs.writeFileSync(zipPath, zipBytes);
  const tarPath = path.join(w, "fixture.tar");
  const gzipPath = path.join(w, "fixture.tgz");
  await tar.c({ cwd: source, file: tarPath, portable: true }, ["entry.json"]);
  await tar.c({ cwd: source, file: gzipPath, portable: true, gzip: true }, ["entry.json"]);
  const destination = path.join(w, "archive-destination");
  fs.mkdirSync(destination);
  const simple = {
    isWindowsDrivePath: ["package/entry.json"], normalizeArchiveEntryPath: ["package\\entry.json"],
    stripArchivePath: ["package/entry.json", 1], validateArchiveEntryPath: ["package/entry.json"],
    resolveArchiveOutputPath: [{ rootDir: destination, relPath: "entry.json", originalPath: "entry.json" }],
    resolveArchiveKind: ["fixture.tar.gz"], readZipCentralDirectoryEntryCount: [zipBytes],
    createArchiveSymlinkTraversalError: ["fixture/link"],
  };
  for (const [name, values] of Object.entries(simple)) add(name, () => a[name](...values), { sync: true, batch: 100 });
  add("ArchiveFormatError", () => new a.ArchiveFormatError("synthetic"), { sync: true, batch: 100 });
  add("ArchiveSecurityError", () => new a.ArchiveSecurityError("entry-path", "synthetic"), { sync: true, batch: 100 });
  add("ArchiveLimitError", () => new a.ArchiveLimitError(a.ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT), { sync: true, batch: 100 });
  add("createTarEntryPreflightChecker", () => a.createTarEntryPreflightChecker({ rootDir: destination }), { sync: true });
  add("createTarEntryPreflightChecker/call", (check) => check({ path: "entry.json", type: "File", size: 11 }), { sync: true, before: () => a.createTarEntryPreflightChecker({ rootDir: destination }) });
  add("loadZipArchiveWithPreflight", () => a.loadZipArchiveWithPreflight(zipBytes));
  add("prepareArchiveDestinationDir", () => a.prepareArchiveDestinationDir(destination));
  add("prepareArchiveOutputPath", () => a.prepareArchiveOutputPath({ destinationDir: destination, destinationRealDir: destination, outPath: path.join(destination, "entry.json"), relPath: "entry.json", originalPath: "entry.json", isDirectory: false }));
  add("resolvePackedRootDir", () => a.resolvePackedRootDir(source, { rootMarkers: ["entry.json"] }));
  add("withStagedArchiveDestination", () => a.withStagedArchiveDestination({ destinationRealDir: destination, run: async () => 1 }));
  add("mergeExtractedTreeIntoDestination", () => a.mergeExtractedTreeIntoDestination({ sourceDir: source, destinationDir: destination, destinationRealDir: destination }), {
    before: () => { fs.writeFileSync(path.join(source, "entry.json"), '{"ok":true}'); },
    after: () => fs.rmSync(path.join(destination, "entry.json"), { force: true }), divisor: 10,
  });
  for (const [kind, archivePath] of [["zip", zipPath], ["tar", tarPath], ["gzip", gzipPath]]) {
    add(`extractArchive/${kind}`, () => a.extractArchive({ archivePath, destDir: destination, timeoutMs: 30_000 }), {
      after: () => fs.rmSync(path.join(destination, "entry.json"), { force: true }), divisor: 10,
      verify: () => assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, "entry.json"), "utf8")), { ok: true }),
    });
    add(`readArchiveEntry/${kind}`, () => a.readArchiveEntry(archivePath, "entry.json", { maxBytes: 1024 }), { divisor: 10 });
    if (kind !== "zip") add(`inspectTarArchive/${kind}`, () => a.inspectTarArchive({ archivePath, timeoutMs: 30_000 }), { divisor: 10 });
  }
}
