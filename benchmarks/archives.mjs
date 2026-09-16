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
  const paddedGzipPath = path.join(w, "zero-padded.tgz");
  fs.writeFileSync(paddedGzipPath, Buffer.concat([fs.readFileSync(gzipPath), Buffer.alloc(64 * 1024 * 1024)]));
  add("readArchiveEntry/gzip-64MiB-zero-padding", () => a.readArchiveEntry(paddedGzipPath, "entry.json", { maxBytes: 1024 }), {
    divisor: 100, verify: result => assert.equal(result.toString(), '{"ok":true}'),
  });
  add("inspectTarArchive/gzip-64MiB-zero-padding", () => a.inspectTarArchive({ archivePath: paddedGzipPath, timeoutMs: 30_000 }), {
    divisor: 100, verify: entries => {
      assert.equal(entries.length, 1);
      assert.equal(entries[0].path, "entry.json");
      assert.equal(entries[0].size, 11);
    },
  });
  const destination = path.join(w, "archive-destination");
  fs.mkdirSync(destination);
  const smallMemberCount = 10_000;
  const smallMembers = Buffer.alloc(smallMemberCount * 1024 + 1024);
  for (let index = 0; index < smallMemberCount; index++) {
    const offset = index * 1024;
    new tar.Header({ path: `small-${index}.txt`, type: "File", size: 128,
      mode: 0o644, uid: 0, gid: 0, mtime: new Date(0) }).encode(smallMembers, offset);
    smallMembers.fill(42, offset + 512, offset + 512 + 128);
  }
  const smallMembersPath = path.join(w, "many-small-members.tar");
  fs.writeFileSync(smallMembersPath, smallMembers);
  add("inspectTarArchive/tar-10000-small-members", () => a.inspectTarArchive({
    archivePath: smallMembersPath, timeoutMs: 30_000,
  }), {
    divisor: 100, verify: entries => {
      assert.equal(entries.length, smallMemberCount);
      assert.ok(entries.every((entry, index) => entry.path === `small-${index}.txt` &&
        entry.kind === "file" && entry.size === 128));
    },
  });
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
  for (const unicode of [false, true]) {
    for (const compression of ["STORE", "DEFLATE"]) {
      const manyZip = new JSZip();
      const names = Array.from({ length: 512 }, (_, i) => `entry-${i}${unicode ? "-café" : ""}`);
      const payload = Buffer.alloc(64, 42);
      for (const name of names) manyZip.file(name, payload, { createFolders: false });
      const bytes = await manyZip.generateAsync({ type: "nodebuffer", compression });
      const label = `zip-512-${unicode ? "unicode" : "ascii"}-${compression.toLowerCase()}`;
      const archivePath = path.join(w, `${label}.zip`);
      fs.writeFileSync(archivePath, bytes);
      add(`readArchiveEntry/${label}`, () => a.readArchiveEntry(archivePath, names.at(-1), { maxBytes: 64 }), {
        divisor: 10, verify: result => assert.ok(result.equals(payload)),
      });
      add(`loadZipArchiveWithPreflight/${label}`, () => a.loadZipArchiveWithPreflight(bytes), {
        divisor: 10, verify: result => {
          assert.equal(Object.keys(result.files).length, names.length);
          for (const name of names) assert.equal(result.files[name]?.dir, false);
        },
      });
      add(`extractArchive/${label}-skip-all`, async () => {
        let inspected = 0;
        await a.extractArchive({ archivePath, destDir: destination, timeoutMs: 30_000,
          entryFilter: () => { inspected++; return "skip"; }, onFiltered: "skip-entry" });
        return inspected;
      }, { divisor: 10, verify: inspected => {
        assert.equal(inspected, names.length);
        assert.deepEqual(fs.readdirSync(destination), []);
      } });
    }
  }
  const mixedZip = new JSZip();
  const mixedKinds = new Map();
  for (let index = 0; index < 512; index++) {
    const directory = index % 2 === 0;
    const name = `mixed-${index}`;
    mixedKinds.set(name, directory ? "directory" : "file");
    mixedZip.file(name + (directory ? "/" : ""), directory ? "" : "payload", { dir: directory, createFolders: false });
  }
  const mixedBytes = await mixedZip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  const mixedPath = path.join(w, "zip-512-mixed-kinds.zip");
  fs.writeFileSync(mixedPath, mixedBytes);
  add("loadZipArchiveWithPreflight/zip-512-mixed-kinds", () => a.loadZipArchiveWithPreflight(mixedBytes), {
    divisor: 10, verify: result => {
      assert.equal(Object.keys(result.files).length, mixedKinds.size);
      for (const [name, kind] of mixedKinds) {
        const directory = kind === "directory";
        assert.equal(result.files[name + (directory ? "/" : "")]?.dir, directory);
      }
    },
  });
  add("readArchiveEntry/zip-512-mixed-kinds", () => a.readArchiveEntry(mixedPath, "mixed-511", { maxBytes: 7 }), {
    divisor: 10, verify: result => assert.equal(result.toString(), "payload"),
  });
  add("extractArchive/zip-512-mixed-kinds-skip-all", async () => {
    const entries = [];
    await a.extractArchive({ archivePath: mixedPath, destDir: destination, timeoutMs: 30_000,
      entryFilter: entry => { entries.push([entry.path, entry.kind]); return "skip"; }, onFiltered: "skip-entry" });
    return entries;
  }, { divisor: 10, verify: entries => {
    assert.deepEqual(entries, [...mixedKinds]);
    assert.deepEqual(fs.readdirSync(destination), []);
  } });
  const manySource = path.join(w, "tar-many-source");
  fs.mkdirSync(manySource);
  const names = Array.from({ length: 512 }, (_, index) => `entry-${index}`);
  const memberPayload = Buffer.alloc(64, 42);
  for (const name of names) fs.writeFileSync(path.join(manySource, name), memberPayload);
  for (const gzip of [false, true]) {
    const archivePath = path.join(w, `many.${gzip ? "tgz" : "tar"}`);
    await tar.c({ cwd: manySource, file: archivePath, portable: true, gzip }, names);
    const label = `${gzip ? "gzip" : "tar"}-512-members`;
    add(`readArchiveEntry/${label}`, () => a.readArchiveEntry(archivePath, names.at(-1), { maxBytes: 64 }), {
      divisor: 10, verify: result => assert.ok(result.equals(memberPayload)),
    });
    add(`inspectTarArchive/${label}`, () => a.inspectTarArchive({ archivePath, timeoutMs: 30_000 }), {
      divisor: 10, verify: entries => assert.equal(entries.length, names.length),
    });
  }
  for (const size of [1024 * 1024, 16 * 1024 * 1024]) {
    const payload = Buffer.alloc(size, 0x61);
    const tarSource = path.join(w, `tar-source-${size}`);
    fs.mkdirSync(tarSource);
    fs.writeFileSync(path.join(tarSource, "payload.bin"), payload);
    for (const gzip of [false, true]) {
      const archivePath = path.join(w, `large-${size}.${gzip ? "tgz" : "tar"}`);
      await tar.c({ cwd: tarSource, file: archivePath, portable: true, gzip }, ["payload.bin"]);
      add(`readArchiveEntry/${gzip ? "gzip" : "tar"}-${size / 1024 / 1024}MiB`,
        () => a.readArchiveEntry(archivePath, "payload.bin", { maxBytes: size }), {
          divisor: 10, verify: result => assert.ok(result.equals(payload)),
        });
      const label = `${gzip ? "gzip" : "tar"}-${size / 1024 / 1024}MiB`;
      add(`extractArchive/${label}`, () => a.extractArchive({ archivePath, destDir: destination, timeoutMs: 30_000 }), {
        divisor: 10,
        verify: () => assert.ok(fs.readFileSync(path.join(destination, "payload.bin")).equals(payload)),
        after: () => fs.rmSync(path.join(destination, "payload.bin"), { force: true }),
      });
      add(`inspectTarArchive/${label}`, () => a.inspectTarArchive({ archivePath, timeoutMs: 30_000 }), {
        divisor: 10, verify: entries => {
          assert.equal(entries.length, 1);
          assert.equal(entries[0].path, "payload.bin");
          assert.equal(entries[0].size, size);
        },
      });
    }
    for (const compression of ["STORE", "DEFLATE"]) {
      const largeZip = new JSZip();
      largeZip.file("payload.bin", payload);
      const archivePath = path.join(w, `large-${size}-${compression}.zip`);
      fs.writeFileSync(archivePath, await largeZip.generateAsync({ type: "nodebuffer", compression }));
      const label = `zip-${size / 1024 / 1024}MiB-${compression.toLowerCase()}`;
      add(`readArchiveEntry/${label}`, () => a.readArchiveEntry(archivePath, "payload.bin", { maxBytes: size }), {
        divisor: 10,
        verify: (result) => assert.ok(result.equals(payload)),
      });
      add(`extractArchive/${label}`, () => a.extractArchive({ archivePath, destDir: destination, timeoutMs: 30_000 }), {
        divisor: 10,
        verify: () => assert.ok(fs.readFileSync(path.join(destination, "payload.bin")).equals(payload)),
        after: () => fs.rmSync(path.join(destination, "payload.bin"), { force: true }),
      });
    }
  }
}
