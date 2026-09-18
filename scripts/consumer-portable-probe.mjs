import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Copied into an isolated npm/pnpm consumer and run in a fresh process per mode.
const mode = process.argv[2];
assert(["off", "auto"].includes(mode), "portable consumer mode must be off or auto");
const expected = JSON.parse(fsSync.readFileSync("expected.json", "utf8"));
assert.equal(expected.omitted, true, "portable proof requires an omitted-optional install");
const consumer = fsSync.realpathSync(process.cwd());
const require = createRequire(import.meta.url);
const manifestPath = require.resolve("@openclaw/fs-safe/package.json");
const rootRequire = createRequire(manifestPath);
const manifest = JSON.parse(fsSync.readFileSync(manifestPath, "utf8"));
assert.deepEqual(manifest, expected.rootPkg);
const sha256 = (file) => createHash("sha256").update(fsSync.readFileSync(file)).digest("hex");
const withinConsumer = (file) => {
  const relative = path.relative(consumer, fsSync.realpathSync(file));
  assert(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
withinConsumer(manifestPath);
const entry = require.resolve("@openclaw/fs-safe");
withinConsumer(entry);
assert.equal(sha256(entry), expected.entryHash);
assert.equal(sha256(fileURLToPath(import.meta.url)), expected.portableProbeHash);
const modules = {};
for (const [name, hash] of Object.entries(expected.portableModuleHashes)) {
  const file = path.join(path.dirname(entry), name);
  withinConsumer(file);
  assert.equal(sha256(file), hash, `packed module mismatch: ${name}`);
  modules[name] = hash;
}
for (const name of expected.platforms) {
  assert.throws(() => rootRequire.resolve(name), { code: "MODULE_NOT_FOUND" });
}
withinConsumer(rootRequire.resolve("jszip"));
assert.equal(typeof manifest.dependencies.jszip, "string");
const warnings = [];
const observeWarning = (warning) => {
  if (warning.code === "FS_SAFE_NATIVE_FALLBACK") warnings.push(warning.message);
};
process.on("warning", observeWarning);
const { configureFsSafeNative, getFsSafeNativeConfig } = await import("@openclaw/fs-safe/config");
configureFsSafeNative({ mode });
let importedSubpaths = 0;
for (const subpath of Object.keys(manifest.exports)) {
  if (subpath === "./package.json") continue;
  await import(subpath === "." ? manifest.name : manifest.name + subpath.slice(1));
  importedSubpaths++;
}
const { root } = await import("@openclaw/fs-safe");
const { stageFileInDirectory, tempFile } = await import("@openclaw/fs-safe/advanced");
const { publishFileExclusive } = await import("@openclaw/fs-safe/durability");
const { copyTree, createCloneSource, probeTreeClone, readCloneFileMetadata } = await import("@openclaw/fs-safe/copy");
const { tempWorkspace, tempWorkspaceSync, withTempWorkspace, withTempWorkspaceSync } = await import("@openclaw/fs-safe/temp");
const { extractArchive, readArchiveEntry, resolveArchiveKind } = await import("@openclaw/fs-safe/archive");
const { createPrivateDirectory, readOwnerAndDacl } = await import("@openclaw/fs-safe/permissions");
const { readSecureFile } = await import("@openclaw/fs-safe/secure-file");
const JSZip = rootRequire("jszip");

// Synthetic USTAR bytes from the shared framing fixtures, compressed with Python
// bz2 and Node zstd. Fixed bytes keep Node 22 proof independent of compressors.
const archives = {
  "tar-bzip2": {
    suffix: ".tar.bz2",
    good: "QlpoOTFBWSZTWbPXrCMAAMPfgd+QQAD/ggBFQcJu59/oAACJCDAAubYakAAAAAAABoCEjENA0AA0TQxNME0wSSpp6jQGmmjRtRoMgA0D1IX+u+w9ZqJSMZDHmXhEKzEhJT0D2kQ9Ewh7mdpFjReEkwImtBG3seOElEhhAqqqytyBJOIf1N0KtPAYQujXESJKDJIzmdEGQXaWKQPikdZpQAh1H5naQFqGpqI3Gi3d+6gyKiucMFQ26XZIQqNpkHv3oWEqHwRdgZZIIg4kaNQnItiQfxdyRThQkLPXrCM=",
    bad: "QlpoOTFBWSZTWb5wTi4AADJbgOmAQABlgAAIZgTfIAgYIABUUnpoEwmANNQSU1Bpo009QAaaRKoe0QY8TkUnKKCrA1GE0BDsF8LFg9jiCMFzei6BGAmJmuKU/i7kinChIXzgnFw=",
  },
  "tar-zstd": {
    suffix: ".tar.zst",
    good: "KLUv/WABF8UFAGKHGBpwaXVELDuNvxheHE1fMV8LIEkT/hLE/nf/UpBRjuSYHCuUKv1giSUoTEvWtqWxzY8VSVU3Yx2AwWUXgsPb5iSKx5pUkR1bywZxC/7t9imgkWNNpX7/z9T/d6Dh2jMwh1gBICBwg6QkzQH+Ef7gOQV5gtUZo155PBgAZXpcZRRNMkAwAFPNbuSUJ6caAJvUgKnmdjjAMfREmVVgJgVGLYzggDGcCc2pA6aXFf9wBQfHXsYm4QU=",
    bad: "KLUv/WABB10CAAQDdmFsdWUAMDAwMDY0NDAwMDAwMDcAADAwNzAwMQAgMAB1c3RhcgAwcGF5bG9hZAABCQD1gZ8hQAXxhtQAkByIAAYNcKxcZidQBA==",
  },
};
const directory = await fs.mkdtemp(path.join(consumer, `portable-${mode}-`));
const rows = [];
let modeZeroMove;
const child = async (name) => {
  const target = path.join(directory, name);
  await fs.mkdir(target, { mode: 0o700 });
  return target;
};
const identity = async (file) => {
  const stat = await fs.lstat(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
};
const text = (file) => fs.readFile(file, "utf8");
async function proveSourceRetirement(owner, replaceBeforeCapture) {
  const fixture = await child(owner + (replaceBeforeCapture ? "-capture-mismatch" : "-public-replacement"));
  const sourcePath = path.join(fixture, "source");
  const targetPath = path.join(fixture, "published");
  const retiredPath = path.join(fixture, "original-retired");
  await fs.writeFile(sourcePath, "original A", { mode: 0o600 });
  const originalIdentity = await fs.lstat(sourcePath, { bigint: true });
  const scoped = owner === "root" ? await root(fixture) : undefined;
  const renameDescriptor = Object.getOwnPropertyDescriptor(fsSync, "renameSync");
  assert(renameDescriptor && typeof renameDescriptor.value === "function");
  const rename = renameDescriptor.value;
  let captures = 0, capturePath, capturedIdentity, publicIdentity, failure, result;
  try {
    Object.defineProperty(fsSync, "renameSync", { ...renameDescriptor, value(from, to) {
      if (from !== sourcePath) return Reflect.apply(rename, fsSync, [from, to]);
      assert.equal(captures++, 0, "source retirement must capture once");
      assert.equal(typeof to, "string");
      capturePath = to;
      assert.equal(path.dirname(path.dirname(capturePath)), fixture);
      assert.match(path.basename(path.dirname(capturePath)), /^\.fs-safe-move-/);
      assert.equal(path.basename(capturePath), "source");
      if (replaceBeforeCapture) {
        Reflect.apply(rename, fsSync, [sourcePath, retiredPath]);
        fsSync.writeFileSync(sourcePath, "captured replacement B", { flag: "wx", mode: 0o600 });
        capturedIdentity = fsSync.lstatSync(sourcePath, { bigint: true });
      }
      const moved = Reflect.apply(rename, fsSync, [from, to]);
      fsSync.writeFileSync(sourcePath, "public replacement C", { flag: "wx", mode: 0o600 });
      publicIdentity = fsSync.lstatSync(sourcePath, { bigint: true });
      return moved;
    } });
    result = scoped ? await scoped.move("source", "published") : await publishFileExclusive({
      sourcePath, targetPath, strategy: "rename-noreplace",
    });
  } catch (error) {
    failure = error;
  } finally {
    Object.defineProperty(fsSync, "renameSync", renameDescriptor);
  }
  assert.equal(fsSync.renameSync, rename, "retirement dispatch override must be restored");
  assert.equal(captures, 1, "the public operation must reach source capture");
  const assertFile = async (file, expected, data, links) => {
    const current = await fs.lstat(file, { bigint: true });
    assert.equal(current.isFile(), true);
    assert.equal(current.dev, expected.dev);
    assert.equal(current.ino, expected.ino);
    assert.equal(current.nlink, links);
    assert.equal(await text(file), data);
  };
  await assertFile(targetPath, originalIdentity, "original A", replaceBeforeCapture ? 2n : 1n);
  await assertFile(sourcePath, publicIdentity, "public replacement C", 1n);
  if (replaceBeforeCapture) {
    assert.equal(failure?.code, "path-mismatch");
    assert.equal(failure.details.sourceConsumed, false);
    assert.deepEqual(failure.details.sourceRecovery, { path: capturePath, status: "preserved" });
    if (owner === "publication") {
      assert.equal(failure.details.targetCreated, true);
      assert.equal(failure.details.cleanup, "preserved");
    }
    await assertFile(retiredPath, originalIdentity, "original A", 2n);
    await assertFile(capturePath, capturedIdentity, "captured replacement B", 1n);
    const privateDirectory = await fs.lstat(path.dirname(capturePath), { bigint: true });
    assert.equal(privateDirectory.isDirectory(), true);
    assert.equal(privateDirectory.mode & 0o077n, 0n);
    return { case: "replacement-at-capture", errorCode: failure.code, sourceConsumed: false,
      recovery: { status: "preserved", relativePath: path.relative(consumer, capturePath) },
      originalTargetPreserved: true, originalRetiredPreserved: true, capturedReplacementPreserved: true,
      publicReplacementPreserved: true, dispatchRestored: true };
  }
  if (owner === "publication") {
    assert.equal(failure?.code, "path-mismatch");
    assert.equal(failure.details.sourceConsumed, true);
    assert.equal(failure.details.targetCreated, true);
    assert.equal(failure.details.cleanup, "preserved");
    assert.equal(Object.hasOwn(failure.details, "sourceRecovery"), false);
  } else {
    assert.equal(failure, undefined, "Root.move must preserve a new public source after retiring the original");
    assert.equal(result, undefined);
  }
  await assert.rejects(fs.lstat(capturePath), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.dirname(capturePath)), { code: "ENOENT" });
  return { case: "public-replacement-after-capture", sourceConsumed: true,
    originalTargetPreserved: true, publicReplacementPreserved: true, privateCaptureRemoved: true,
    dispatchRestored: true,
    ...(owner === "publication" ? { errorCode: "path-mismatch", cleanup: "preserved", recoveryAbsent: true } : {}) };
}
try {
  const moveDir = await child("move");
  const scoped = await root(moveDir);
  await scoped.write("source", "move bytes");
  await scoped.write("collision", "sentinel");
  const sourceIdentity = await identity(path.join(moveDir, "source"));
  await assert.rejects(scoped.move("source", "collision"), { code: "already-exists" });
  assert.equal(await text(path.join(moveDir, "source")), "move bytes");
  assert.equal(await text(path.join(moveDir, "collision")), "sentinel");
  await scoped.move("source", "moved");
  await assert.rejects(fs.lstat(path.join(moveDir, "source")), { code: "ENOENT" });
  assert.deepEqual(await identity(path.join(moveDir, "moved")), sourceIdentity);
  assert.equal(await text(path.join(moveDir, "moved")), "move bytes");
  await assert.rejects(scoped.move("moved", "../escaped"), { code: "invalid-path" });
  await fs.link(path.join(moveDir, "moved"), path.join(moveDir, "alias"));
  await assert.rejects(scoped.move("alias", "alias-moved"), { code: "hardlink" });
  assert.equal(await text(path.join(moveDir, "moved")), "move bytes");
  await assert.rejects(fs.lstat(path.join(directory, "escaped")), { code: "ENOENT" });
  if (process.platform !== "win32") {
    const sourceName = "mode-zero-source-é";
    const intermediateName = "mode-zero-intermediate-é";
    const finalName = "mode-zero-final-é";
    const restricted = path.join(moveDir, sourceName);
    const final = path.join(moveDir, finalName);
    await fs.writeFile(restricted, "permission-preserved bytes", { mode: 0o600 });
    await fs.chmod(restricted, 0);
    const before = await fs.lstat(restricted, { bigint: true });
    assert.equal(before.mode & 0o7777n, 0n);
    const deniedOpen = async (flags) => {
      let handle;
      try {
        handle = await fs.open(restricted, flags);
        return false;
      } catch (error) {
        assert(["EACCES", "EPERM"].includes(error.code), "unexpected mode-zero admission failure");
        return true;
      } finally { await handle?.close(); }
    };
    // Observe real access denial without reading or writing any payload bytes.
    const readDenied = await deniedOpen(fsSync.constants.O_RDONLY);
    const writeDenied = await deniedOpen(fsSync.constants.O_WRONLY);
    if (process.geteuid?.() !== 0) {
      assert.equal(readDenied, true, "unprivileged mode-zero fixture must deny content reads");
      assert.equal(writeDenied, true, "unprivileged mode-zero fixture must deny content writes");
    }
    const assertPreserved = async (file) => {
      const current = await fs.lstat(file, { bigint: true });
      assert.equal(current.dev, before.dev);
      assert.equal(current.ino, before.ino);
      assert.equal(current.mode, before.mode);
      assert.equal(current.mode & 0o7777n, 0n);
      assert.equal(current.nlink, 1n);
      assert.equal(current.isFile(), true);
    };
    await assert.rejects(scoped.move(sourceName, "collision"), { code: "already-exists" });
    await assertPreserved(restricted);
    assert.equal(await text(path.join(moveDir, "collision")), "sentinel");
    await scoped.move(sourceName, intermediateName);
    await assertPreserved(path.join(moveDir, intermediateName));
    await assert.rejects(fs.lstat(restricted), { code: "ENOENT" });
    // A second denied-content move also checks command-warning deduplication.
    await scoped.move(intermediateName, finalName);
    await assertPreserved(final);
    await assert.rejects(fs.lstat(path.join(moveDir, intermediateName)), { code: "ENOENT" });
    // Only the fixture restores read permission, after both move outcomes and modes were checked.
    await fs.chmod(final, 0o600);
    assert.equal(await text(final), "permission-preserved bytes");
    assert.equal(await text(path.join(moveDir, "collision")), "sentinel");
    modeZeroMove = {
      mode: 0, moves: 2, contentAccessDenied: readDenied && writeDenied,
      identityPreserved: true, modePreserved: true, sourceConsumed: true,
      collisionPreserved: true, bytesVerifiedAfterFixtureModeRestore: true,
    };
  }
  const rootRetirement = process.platform === "win32" ? undefined : [
    await proveSourceRetirement("root", true), await proveSourceRetirement("root", false),
  ];
  rows.push({ scenario: "root-no-clobber-move", sourceConsumed: true, identityPreserved: true, collisionsAndHazardsRejected: true,
    ...(modeZeroMove ? { modeZero: modeZeroMove, sourceRetirement: rootRetirement } : {}) });

  const publishDir = await child("publication");
  const sourcePath = path.join(publishDir, "source");
  const targetPath = path.join(publishDir, "target");
  await fs.writeFile(sourcePath, "publication bytes");
  await fs.writeFile(targetPath, "sentinel");
  const publicationIdentity = await identity(sourcePath);
  await assert.rejects(publishFileExclusive({ sourcePath, targetPath, strategy: "rename-noreplace" }), { code: "EEXIST" });
  assert.equal(await text(sourcePath), "publication bytes");
  assert.equal(await text(targetPath), "sentinel");
  const publishedPath = path.join(publishDir, "published");
  const published = await publishFileExclusive({ sourcePath, targetPath: publishedPath, strategy: "rename-noreplace" });
  assert.equal(published.method, "hardlink");
  assert.equal(published.sourceConsumed, true);
  assert(["synced", "unsupported"].includes(published.directorySync.status));
  await assert.rejects(fs.lstat(sourcePath), { code: "ENOENT" });
  assert.deepEqual(await identity(publishedPath), publicationIdentity);
  assert.equal(await text(publishedPath), "publication bytes");
  const publicationRetirement = process.platform === "win32" ? undefined : [
    await proveSourceRetirement("publication", true), await proveSourceRetirement("publication", false),
  ];
  rows.push({ scenario: "standalone-no-clobber-publication", method: published.method, sourceConsumed: published.sourceConsumed, directorySync: published.directorySync, collisionPreserved: true,
    ...(publicationRetirement ? { sourceRetirement: publicationRetirement } : {}) });

  const stagingDir = await child("staging");
  await fs.writeFile(path.join(stagingDir, "collision"), "sentinel");
  const stage = await stageFileInDirectory({ directory: stagingDir, content: "staged bytes" });
  assert.equal(stage.receipt.targeting, "guarded-pathname");
  await assert.rejects(stage.publish("collision", { overwrite: false }), { code: "already-exists" });
  assert.equal(await text(path.join(stagingDir, "collision")), "sentinel");
  await stage.assertCurrent();
  const stagedPublication = await stage.publish("published", { overwrite: false });
  assert.equal(stagedPublication.method, "link-unlink");
  assert.equal(await text(path.join(stagingDir, "published")), "staged bytes");
  assert.equal((await stage.cleanup()).status, "not-needed");
  const discarded = await stageFileInDirectory({ directory: stagingDir, content: "discarded bytes" });
  assert.equal((await discarded.cleanup()).status, "removed");
  assert.deepEqual((await fs.readdir(stagingDir)).sort(), ["collision", "published"]);
  rows.push({ scenario: "staged-publication-and-cleanup", targeting: stage.receipt.targeting, method: stagedPublication.method, collisionsPreserved: true });

  const driftDir = await child("stage-drift");
  const drift = await stageFileInDirectory({ directory: driftDir, content: "original stage" });
  const retiredDir = path.join(directory, "retired-stage-parent");
  await fs.rename(driftDir, retiredDir);
  await fs.mkdir(driftDir);
  await fs.writeFile(path.join(driftDir, drift.receipt.temporaryBasename), "replacement stage");
  await assert.rejects(drift.publish("must-not-publish", { overwrite: false }), (error) =>
    error?.details?.publication?.status === "not-published");
  const driftCleanup = await drift.cleanup();
  assert.equal(driftCleanup.status, "preserved");
  assert.equal(driftCleanup.resources, "closed");
  assert.equal(await text(path.join(retiredDir, drift.receipt.temporaryBasename)), "original stage");
  assert.equal(await text(path.join(driftDir, drift.receipt.temporaryBasename)), "replacement stage");
  await assert.rejects(fs.lstat(path.join(driftDir, "must-not-publish")), { code: "ENOENT" });
  rows.push({ scenario: "staged-parent-drift", targeting: driftCleanup.targeting, cleanup: driftCleanup.status, bothSentinelsPreserved: true });

  const copyDir = await child("copy");
  const cloneSource = path.join(copyDir, "source");
  const cloneTarget = path.join(copyDir, "target");
  await createCloneSource(cloneSource);
  assert.equal(probeTreeClone(copyDir), undefined);
  await fs.writeFile(path.join(cloneSource, "payload"), "copy bytes");
  await assert.rejects(createCloneSource(cloneSource), { code: "EEXIST" });
  await copyTree(cloneSource, cloneTarget, { clone: "always" });
  assert.equal(await text(path.join(cloneTarget, "payload")), "copy bytes");
  await fs.writeFile(path.join(cloneTarget, "payload"), "independent edit");
  assert.equal(await text(path.join(cloneSource, "payload")), "copy bytes");
  const copyRoot = await root(copyDir);
  await copyRoot.copyIn("copied-file", path.join(cloneSource, "payload"), { clone: "always", overwrite: false });
  assert.equal(await text(path.join(copyDir, "copied-file")), "copy bytes");
  assert.deepEqual(await readCloneFileMetadata([path.join(cloneSource, "payload"), path.join(copyDir, "copied-file")]), [undefined, undefined]);
  await assert.rejects(readCloneFileMetadata(["relative"]), { code: "invalid-path" });
  rows.push({ scenario: "copy-and-clone-metadata", cloneGuarantee: false, independentBytes: true, metadataUnavailable: true });

  const tempDir = await child("temp");
  const options = { rootDir: tempDir, prefix: "owned", cleanupSafety: "require-bounded" };
  const workspace = await tempWorkspace(options);
  assert.equal(workspace.cleanupMechanism, "guarded-path");
  await workspace.writeText("payload", "temporary bytes");
  assert.equal((await workspace.read("payload")).toString(), "temporary bytes");
  assert.equal(await workspace.cleanup(), "removed");
  const sync = tempWorkspaceSync(options);
  assert.equal(sync.cleanupMechanism, "guarded-path");
  sync.writeText("payload", "sync bytes");
  assert.equal(sync.read("payload").toString(), "sync bytes");
  assert.equal(sync.cleanup(), "removed");
  await withTempWorkspace(options, async (value) => {
    assert.equal(value.cleanupMechanism, "guarded-path");
    await value.writeText("payload", "scoped bytes");
  });
  withTempWorkspaceSync(options, (value) => {
    assert.equal(value.cleanupMechanism, "guarded-path");
    value.writeText("payload", "scoped sync bytes");
  });
  const target = await tempFile(options);
  assert.equal(target.cleanupMechanism, "guarded-path");
  await fs.writeFile(target.path, "temp file bytes");
  await target.cleanup();
  assert.deepEqual(await fs.readdir(tempDir), []);
  const replacement = await tempWorkspace(options);
  await replacement.writeText("sentinel", "owned sentinel");
  const retiredWorkspace = path.join(directory, "retired-workspace");
  await fs.rename(replacement.dir, retiredWorkspace);
  await fs.mkdir(replacement.dir);
  await fs.writeFile(path.join(replacement.dir, "sentinel"), "replacement sentinel");
  assert.equal(await replacement.cleanup(), "identity-mismatch");
  assert.equal(await text(path.join(retiredWorkspace, "sentinel")), "owned sentinel");
  assert.equal(await text(path.join(replacement.dir, "sentinel")), "replacement sentinel");
  rows.push({ scenario: "temp-cleanup-mechanism", mechanism: "guarded-path", variants: 5, replacementPreserved: true });

  for (const [kind, fixture] of Object.entries(archives)) {
    const archiveDir = await child(kind);
    const archivePath = path.join(archiveDir, `fixture${fixture.suffix}`);
    const destDir = path.join(archiveDir, "output");
    await fs.mkdir(destDir);
    await fs.writeFile(archivePath, Buffer.from(fixture.good, "base64"));
    assert.equal(resolveArchiveKind(archivePath), kind);
    await extractArchive({ archivePath, destDir, kind, timeoutMs: 10000 });
    assert.equal(await text(path.join(destDir, "value")), "payload");
    assert.equal(await text(path.join(destDir, "directory", "x".repeat(120))), "gnu");
    assert.equal((await readArchiveEntry(archivePath, "value", { kind, maxBytes: 7 })).toString(), "payload");
    await assert.rejects(readArchiveEntry(archivePath, "value", { kind, maxBytes: 6 }), { code: "archive-entry-extracted-size-exceeds-limit" });
    const rejected = path.join(archiveDir, "rejected");
    await fs.mkdir(rejected);
    await fs.writeFile(path.join(rejected, "sentinel"), "unchanged");
    await fs.writeFile(archivePath, Buffer.from(fixture.bad, "base64"));
    await assert.rejects(extractArchive({ archivePath, destDir: rejected, kind, timeoutMs: 10000 }), { code: "archive-header-invalid" });
    await assert.rejects(readArchiveEntry(archivePath, "value", { kind, maxBytes: 7 }), { code: "archive-header-invalid" });
    assert.deepEqual(await fs.readdir(rejected), ["sentinel"]);
    assert.equal(await text(path.join(rejected, "sentinel")), "unchanged");
    rows.push({ scenario: kind, extractAndRead: true, byteLimitEnforced: true, malformedTrailerRejected: true });
  }

  const zipDir = await child("zip");
  const zipPath = path.join(zipDir, "fixture.zip");
  const zipOut = path.join(zipDir, "output");
  await fs.mkdir(zipOut);
  const zip = new JSZip();
  zip.file("nested/雪.txt", "zip bytes");
  await fs.writeFile(zipPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  await extractArchive({ archivePath: zipPath, destDir: zipOut, timeoutMs: 10000 });
  assert.equal(await text(path.join(zipOut, "nested", "雪.txt")), "zip bytes");
  assert.equal((await readArchiveEntry(zipPath, "nested/雪.txt", { maxBytes: 9 })).toString(), "zip bytes");
  const maliciousZip = new JSZip();
  maliciousZip.file("../escaped", "unsafe");
  await fs.writeFile(zipPath, await maliciousZip.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(extractArchive({ archivePath: zipPath, destDir: zipOut, timeoutMs: 10000 }), { code: "entry-path" });
  await assert.rejects(fs.lstat(path.join(zipDir, "escaped")), { code: "ENOENT" });
  assert.equal(await text(path.join(zipOut, "nested", "雪.txt")), "zip bytes");
  rows.push({ scenario: "zip", requiredCodecInstalled: true, extractAndRead: true, traversalRejected: true });

  if (process.platform === "win32") {
    const windowsDir = await child("windows-security");
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
    assert(systemRoot && path.isAbsolute(systemRoot), "Windows system directory missing");
    const icacls = (target, ...args) => execFileSync(path.join(systemRoot, "System32", "icacls.exe"), [target, ...args], {
      windowsHide: true, stdio: "pipe", timeout: 30000,
    });
    icacls(windowsDir, "/grant", "*S-1-1-0:(OI)(CI)F");
    const privatePath = path.join(windowsDir, "private-é");
    await createPrivateDirectory(privatePath);
    const facts = readOwnerAndDacl(privatePath);
    assert.equal(facts.status, "supported");
    assert.equal(facts.ownerSid, facts.currentUserSid);
    assert.equal(facts.complete, true);
    assert.equal(facts.daclPresent, true);
    assert.deepEqual(facts.unsupportedAceTypes, []);
    assert.deepEqual(facts.aces.map((ace) => ace.sid).sort(), [facts.currentUserSid, "s-1-5-18", "s-1-5-32-544"].sort());
    const secret = path.join(privatePath, "secret");
    await fs.writeFile(secret, "private bytes");
    const secured = await readSecureFile({ filePath: secret });
    assert.equal(secured.buffer.toString(), "private bytes");
    assert.equal(secured.permissions.source, "windows-acl");
    assert.equal(secured.permissions.ownerTrusted, true);
    assert.equal(secured.permissions.worldReadable, false);
    assert.equal(secured.permissions.groupReadable, false);
    await assert.rejects(createPrivateDirectory(privatePath), { code: "EEXIST" });
    icacls(secret, "/grant", "*S-1-1-0:R");
    await assert.rejects(readSecureFile({ filePath: secret }), { code: "insecure-permissions" });
    assert.equal(await text(secret), "private bytes");
    rows.push({ scenario: "windows-security", platform: "win32", rawFacts: true, privateCreation: true, secureRead: true, broadAclRejected: true, collisionPreserved: true });
  } else {
    assert.deepEqual(readOwnerAndDacl(directory), { status: "unsupported-platform", platform: process.platform });
    rows.push({ scenario: "windows-security", platform: process.platform, status: "unsupported-platform" });
  }

  assert.equal(getFsSafeNativeConfig().mode, mode);
  const nativeLoaded = process.report.getReport().sharedObjects.some((file) =>
    file.endsWith(".node") && path.basename(file).includes("fs-safe"));
  assert.equal(nativeLoaded, false);
  await setImmediate();
  assert(warnings.length > 0, "portable limitations must be observable");
  assert.equal(new Set(warnings).size, warnings.length, "fallback warnings must be deduplicated");
  assert(warnings.every((warning) => !warning.includes(consumer)), "fallback warnings must omit consumer paths");
  let moveWarnings;
  if (process.platform === "darwin") {
    const ordinary = warnings.filter((warning) => warning.startsWith("No-clobber move is ")).length;
    const atomicCommand = warnings.filter((warning) => warning.startsWith("macOS atomic no-clobber move is ")).length;
    const expectedAtomic = modeZeroMove.contentAccessDenied ? 1 : 0;
    assert.equal(ordinary, 1, "ordinary move fallback must warn once");
    assert.equal(atomicCommand, expectedAtomic, "atomic move command must warn once across both denied-content moves");
    assert.equal(warnings.length, 7 + expectedAtomic, "unexpected Darwin portable warning inventory");
    moveWarnings = { ordinary, atomicCommand, total: warnings.length };
  }
  console.log(JSON.stringify({
    mode, packageManager: expected.manager, source: expected.source,
    package: { name: manifest.name, version: manifest.version, integrity: expected.rootIntegrity },
    probeSha256: expected.portableProbeHash, modules, importedSubpaths, nativePackages: [], nativeLoaded, warnings, rows,
    ...(moveWarnings ? { moveWarnings } : {}),
  }));
} finally {
  process.off("warning", observeWarning);
  await fs.rm(directory, { recursive: true, force: true });
}
