import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";

// Run against an already installed packed consumer, never a workspace source import.
const consumer = process.argv[2];
if (!consumer) throw new Error("usage: pnpm archive:producer-smoke <packed-consumer-directory> [off|require]");
const mode = process.argv[3] ?? "off";
if (!["off", "require"].includes(mode)) throw new Error("mode must be off or require");
const require = createRequire(path.resolve(consumer, "package.json"));
const manifest = require.resolve("@openclaw/fs-safe/package.json");
const packageDir = path.dirname(manifest);
const { configureFsSafeNative } = await import(pathToFileURL(require.resolve("@openclaw/fs-safe/config")));
const { extractArchive, readArchiveEntry } = await import(pathToFileURL(require.resolve("@openclaw/fs-safe/archive")));
assert.equal(JSON.parse(await fs.readFile(manifest, "utf8")).optionalDependencies.tar, undefined);
await fs.access(path.join(packageDir, "dist/archive-parser.wasm"));
configureFsSafeNative({ mode });
const scratch = await fs.mkdtemp(path.join(tmpdir(), "fs-safe-producers-"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
try {
  const source = path.join(scratch, "source");
  await fs.mkdir(source);
  const names = ["雪.txt", "café", "\ufeffBOM", "01", "long-" + "a".repeat(130), ...(process.platform === "win32" ? [] : ["line\n.txt"])];
  for (const name of names) await fs.writeFile(path.join(source, name), `synthetic:${name}`);
  const producers = process.platform === "win32" ? ["npm"] : ["system", "npm"];
  const observations = [];
  for (const producer of producers) {
    const archivePath = path.join(scratch, `${producer}.tgz`);
    if (producer === "system") {
      const canonical = await fs.realpath(source), stat = await fs.stat(source, { bigint: true });
      const bytes = execFileSync(process.execPath, [fileURLToPath(new URL("./archive-system-tar-worker.cjs", import.meta.url)),
        source, canonical, String(stat.dev), String(stat.ino)], { maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
      await fs.writeFile(archivePath, bytes);
    }
    else await tar.c({ file: archivePath, cwd: source, portable: true, gzip: true }, names);
    const encoded = await fs.readFile(archivePath);
    observations.push({ producer, bytes: encoded.length, sha256: digest(encoded) });
    const destDir = path.join(scratch, `${producer}-out`);
    await fs.mkdir(destDir);
    await extractArchive({ archivePath, destDir, timeoutMs: 15000 });
    const actual = await fs.readdir(destDir);
    assert.deepEqual(actual.filter((name) => !name.startsWith("._")).sort(), [...names].sort());
    const companions = producer === "system" && process.platform === "darwin"
      ? new Set(["._.", ...names.map((name) => `._${name}`)]) : new Set();
    for (const name of actual.filter((name) => name.startsWith("._"))) {
      assert.ok(companions.has(name), "unexpected producer companion name");
      const bytes = await fs.readFile(path.join(destDir, name));
      // AppleDouble signature (RFC 1740); companion values are producer metadata.
      assert.equal(bytes.readUInt32BE(0), 0x00051607);
      assert.equal(digest(await readArchiveEntry(archivePath, name, { maxBytes: bytes.length })), digest(bytes));
    }
    for (const name of names) {
      const original = await fs.readFile(path.join(source, name));
      assert.equal(digest(await fs.readFile(path.join(destDir, name))), digest(original));
      assert.equal(digest(await readArchiveEntry(archivePath, name, { maxBytes: original.length })), digest(original));
    }
  }
  // Valid effective PAX metadata never excuses an invalid raw fallback field.
  const metadata = Buffer.from(new tar.Pax({ path: "safe" }).encodeBody());
  function header(name, type, size) {
    const h = new tar.Header({ path: name, type, size, mode: 0o644 });
    h.encode();
    return Buffer.from(h.block);
  }
  const raw = header("raw", "File", 0);
  raw[0] = 0xff;
  raw.fill(32, 148, 156);
  raw.write(`${raw.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  const invalid = path.join(scratch, "invalid.tar");
  await fs.writeFile(invalid, Buffer.concat([header("PaxHeader", "ExtendedHeader", metadata.length), metadata,
    Buffer.alloc((512 - metadata.length % 512) % 512), raw, Buffer.alloc(1024)]));
  const destDir = path.join(scratch, "invalid-out");
  await fs.mkdir(destDir);
  await assert.rejects(extractArchive({ archivePath: invalid, destDir, timeoutMs: 10000 }), { code: "entry-path" });
  await assert.rejects(readArchiveEntry(invalid, "safe", { maxBytes: 0 }), { code: "entry-path" });
  assert.deepEqual(await fs.readdir(destDir), []);
  console.log(JSON.stringify({ result: "pass", mode, producers, observations, systemRoute: process.platform === "win32" ? "skipped (POSIX only)" : "bound cwd /usr/bin/tar -czf - . stdout", filenames: names.length, invalidRawRejected: true }));
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
