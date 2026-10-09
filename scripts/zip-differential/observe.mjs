import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Each package/backend gets a fresh process, so native bindings and config cannot leak.
const [packageDirectory, corpusDirectory, mode, output] = process.argv.slice(2);
if (!output || !["auto", "require", "off"].includes(mode)) {
  throw new Error("usage: observe.mjs <package-directory> <corpus-directory> <auto|require|off> <output.json>");
}
const packageRoot = await fs.realpath(packageDirectory);
const api = await import(pathToFileURL(path.join(packageRoot, "dist/archive.js")));
const config = await import(pathToFileURL(path.join(packageRoot, "dist/config.js")));
config.configureFsSafeNative({ mode });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const compact = entries => entries.length > 1000 ? { count: entries.length, sha256: hash(JSON.stringify(entries)), first: entries[0], last: entries.at(-1) } : entries;
const scratch = await fs.mkdtemp(path.join(tmpdir(), "fs-safe-zip-differential-"));
const canonicalScratch = await fs.realpath(scratch);
// Monitor each absolute/drive interpretation used by the generated corpus.
// The UNC case targets this machine's C$ share, never a third-party server.
const externalProbes = process.platform === "win32"
  ? [...new Set([path.resolve("/zip9-escape"), "C:\\zip9-escape", path.resolve("C:zip9-escape")])]
  : ["/zip9-escape", "/localhost/C$/zip9-escape"];
async function assertNoExternalOutput() {
  for (const probe of externalProbes) {
    let present = false;
    try { await fs.lstat(probe); present = true; }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    assert.equal(present, false, `external ZIP probe exists: ${probe}; preserve it for investigation`);
  }
}
function errorResult(error) {
  if (error?.code === "helper-unavailable" || /timed out|panic/i.test(String(error?.message))) throw error;
  return { ok: false, name: error?.name ?? typeof error, code: error?.code ?? null,
    message: String(error?.message ?? error).split(canonicalScratch).join("<scratch>").split(scratch).join("<scratch>") };
}
async function outcome(operation) {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return errorResult(error); }
}
async function tree(directory, prefix = "") {
  const result = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const file = path.join(directory, name), relative = prefix + name;
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() || stat.isDirectory(), `unexpected published type: ${relative}`);
    const real = await fs.realpath(file);
    assert.ok(real.startsWith(canonicalScratch + path.sep), "published path escaped scratch");
    // Own synthetic output can deliberately be unreadable. Record original mode
    // before granting inspection/cleanup access; this is never library policy.
    await fs.chmod(file, (stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600));
    result.push({ path: relative, kind: stat.isDirectory() ? "directory" : "file", mode: stat.mode & 0o7777,
      ...(stat.isFile() ? { size: stat.size, sha256: hash(await fs.readFile(file)) } : {}) });
    if (stat.isDirectory()) result.push(...await tree(file, relative + "/"));
  }
  return result;
}
async function extract(archivePath, entryModes, skip = false, large = false) {
  const destination = await fs.mkdtemp(path.join(scratch, "out-"));
  const callbacks = [];
  const result = await outcome(() => api.extractArchive({ archivePath, destDir: destination,
    kind: "zip", timeoutMs: 30000, entryModes, onFiltered: "skip-entry",
    limits: { maxEntries: large ? 70000 : 50000, maxEntryBytes: 1024 * 1024, maxExtractedBytes: 8 * 1024 * 1024 },
    entryFilter: entry => { callbacks.push(entry); return skip ? "skip" : "extract"; },
  }));
  // Assertions deliberately live outside outcome(): confinement failures fail the harness.
  const files = await tree(destination);
  await fs.rm(destination, { recursive: true, force: true });
  return { ...result, callbacks: compact(callbacks), tree: compact(files) };
}

let native;
let bindingInfo;
if (mode !== "off") {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const { getNativeBinding } = await import(pathToFileURL(path.join(packageRoot, "dist/native.js")));
  native = getNativeBinding();
  assert.ok(native, "native coverage requires the package's selected binding");
  const modules = Object.values(require.cache).filter(module => module.filename.endsWith(".node") && module.exports === native);
  assert.equal(modules.length, 1, "identify the exact binding selected by the package (including libc)");
  bindingInfo = { sha256: hash(await fs.readFile(modules[0].filename)) };
}
const nativeLimits = { maxEntries: 70000, maxMetaEntryBytes: 1024 * 1024, maxManifestBytes: 64 * 1024 * 1024, maxDecodedBytes: 16 * 1024 * 1024 };
try {
  // Refuse pre-existing probe paths before testing; never overwrite unknown data.
  await assertNoExternalOutput();
  const manifest = JSON.parse(await fs.readFile(path.join(corpusDirectory, "manifest.json"), "utf8"));
  assert.ok(Array.isArray(manifest) && manifest.length > 0, "corpus must be nonempty");
  assert.ok(manifest.every(record => /^[a-z0-9-]+$/.test(record.id)), "invalid corpus case id");
  assert.equal(new Set(manifest.map(record => record.id)).size, manifest.length, "duplicate corpus ids");
  const observations = [];
  for (const record of manifest) {
    const archivePath = path.join(scratch, "input.zip");
    const bytes = await fs.readFile(path.join(corpusDirectory, `${record.id}.zip`));
    await fs.writeFile(archivePath, bytes);
    await fs.writeFile(path.join(scratch, "escape"), "confinement sentinel");
    const observed = { id: record.id, sha256: hash(bytes) };
    observed.count = await outcome(() => api.readZipCentralDirectoryEntryCount(bytes));
    const readNames = new Set(["payload"]);
    observed.preflight = await outcome(async () => {
      const archive = await api.loadZipArchiveWithPreflight(bytes, record.large ? { maxEntries: 70000 } : undefined);
      return compact(Object.values(archive.files).map(entry => {
        if (!entry.dir && readNames.size < 12) readNames.add(entry.name);
        return { name: entry.name, kind: entry.dir ? "directory" : "file", mode: entry.unixPermissions,
          dosPermissions: entry.dosPermissions, size: entry._data?.uncompressedSize };
      }));
    });
    observed.extractClamp = await extract(archivePath, "clamp", false, false);
    observed.extractPreserve = await extract(archivePath, "preserve", false, false);
    observed.extractSkip = await extract(archivePath, "clamp", true, Boolean(record.large));
    observed.reads = [];
    for (const name of readNames) {
      observed.reads.push({ name, result: await outcome(async () => {
        const data = await api.readArchiveEntry(archivePath, name, { kind: "zip", maxBytes: 1024 * 1024 });
        return { size: data.length, sha256: hash(data) };
      }) });
    }
    // Supplement public APIs with the native metadata boundary that ZIP 9 changed.
    // These diagnostics are not public admission and never publish files.
    if (native) observed.nativeManifest = await outcome(async () => {
      const owned = Buffer.allocUnsafeSlow(bytes.length); bytes.copy(owned);
      const reader = await native.openZipBufferNative(owned, nativeLimits);
      return compact(reader.entries);
    });
    assert.equal(await fs.readFile(path.join(scratch, "escape"), "utf8"), "confinement sentinel");
    await assertNoExternalOutput();
    assert.deepEqual((await fs.readdir(scratch)).sort(), ["escape", "input.zip"]);
    observations.push(observed);
    console.log(JSON.stringify({ case: record.id, mode }));
  }
  await fs.writeFile(output, JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version,
    mode, packageVersion: JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"))).version,
    binding: bindingInfo, observations }, null, 2) + "\n");
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
