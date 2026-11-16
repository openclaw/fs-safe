import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempFile, withTempFile } from "@openclaw/fs-safe/advanced";
import { configureFsSafeNative, getFsSafeNativeStatus } from "@openclaw/fs-safe/config";
import { nativeBinaryLoaded } from "./consumer-proof-metadata.mjs";

// Copied into the root-only npm/pnpm consumer by consumerInstallSmoke.
const [mode, childKind, childRoot, childSafety, childLength] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.ok(mode === "off" || mode === "require");
const expected = JSON.parse(readFileSync("expected.json", "utf8"));
const consumer = realpathSync(process.cwd());
const require = createRequire(import.meta.url);
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function insideConsumer(file) {
  const relative = path.relative(consumer, realpathSync(file));
  assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
const manifest = require.resolve("@openclaw/fs-safe/package.json");
insideConsumer(manifest);
const entry = require.resolve("@openclaw/fs-safe/advanced");
insideConsumer(entry);
const compiledHash = hash(path.join(path.dirname(entry), "temp-target.js"));
assert.equal(compiledHash, expected.tempFile.compiledSha256);
assert.equal(hash(fileURLToPath(import.meta.url)), expected.tempFile.probeSha256);
const binary = createRequire(manifest).resolve(expected.host.package);
insideConsumer(binary);
assert.equal(hash(binary), expected.hostBinarySha256);
configureFsSafeNative({ mode });
const nativeStatus = await getFsSafeNativeStatus({ probe: true });
assert.equal(nativeStatus.loaded, mode === "require");
assert.equal(nativeBinaryLoaded(binary), mode === "require");

const payload = Buffer.from("public temp file\n中文\0payload");
const prefix = "consumer";
const absent = (file) => assert.rejects(fs.lstat(file), { code: "ENOENT" });
async function roundTrip(file, root, length) {
  assert.equal(path.dirname(path.dirname(file)), root);
  assert.equal(path.dirname(file).length, length);
  assert.equal(file.startsWith("\\\\?\\"), false);
  await fs.writeFile(file, payload, { flag: "wx" });
  assert.deepEqual(await fs.readFile(file), payload);
  const nested = path.join(path.dirname(file), "nested");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "owned.txt"), payload);
}

if (childKind) {
  assert.ok(childKind === "natural-exit" || childKind === "explicit-exit");
  const target = await tempFile({ rootDir: childRoot, prefix, cleanupSafety: childSafety });
  await roundTrip(target.path, childRoot, Number(childLength));
  // No explicit cleanup: the parent checks the exit handler removed this tree.
  await new Promise((resolve, reject) => process.stdout.write(JSON.stringify({
    dir: target.dir, nativeLoaded: nativeStatus.loaded, roundTrip: true,
  }), (error) => error ? reject(error) : resolve()));
  if (childKind === "explicit-exit") process.exit(0);
} else {
  const scratchPrefix = path.join(os.tmpdir(), "fs-safe-temp-consumer-");
  const created = await fs.mkdtemp(path.toNamespacedPath(scratchPrefix));
  const scratch = path.join(path.dirname(scratchPrefix), path.basename(created));
  const rows = [];
  async function rootForLength(requestedLength) {
    // An unusually long TEMP must still exercise a long path, never a negative repeat.
    const rootLength = Math.max(scratch.length + 2, requestedLength - prefix.length - 8);
    let root = scratch;
    while (root.length < rootLength) {
      const remaining = rootLength - root.length;
      let componentLength = Math.min(32, remaining - 1);
      if (remaining - componentLength - 1 === 1) componentLength -= 1;
      assert.ok(componentLength > 0);
      root = path.join(root, "r".repeat(componentLength));
    }
    await fs.mkdir(root, { recursive: true });
    return { root, length: root.length + prefix.length + 8 };
  }
  try {
    for (const cleanupSafety of mode === "require" ? ["compatible", "require-bounded"] : ["compatible"]) {
      for (const requestedLength of [180, 259, 260, 261, 300, 340]) {
        const { root, length } = await rootForLength(requestedLength);
        const errors = [];
        const options = { rootDir: root, prefix, cleanupSafety, onCleanupError: (error) => errors.push(error) };
        for (const lifecycle of ["explicit", "scoped", "scoped-throw"]) {
          let file;
          if (lifecycle === "explicit") {
            const target = await tempFile(options);
            file = target.path;
            try {
              assert.equal(target.file("peer.txt"), path.join(target.dir, "peer.txt"));
              await roundTrip(file, root, length);
            } finally { await target.cleanup(); }
          } else {
            const sentinel = new Error("consumer callback failure");
            const operation = withTempFile(options, async (candidate) => {
              file = candidate;
              await roundTrip(file, root, length);
              if (lifecycle === "scoped-throw") throw sentinel;
              return "roundtrip";
            });
            if (lifecycle === "scoped-throw") await assert.rejects(operation, (error) => error === sentinel);
            else assert.equal(await operation, "roundtrip");
          }
          await absent(path.dirname(file));
          assert.deepEqual(errors, []);
          assert.deepEqual(await fs.readdir(root), []);
          rows.push({ cleanupSafety, lifecycle, requestedLength, directoryLength: length });
        }
      }
      const { root, length } = await rootForLength(340);
      for (const lifecycle of ["natural-exit", "explicit-exit"]) {
        const { stdout } = await promisify(execFile)(process.execPath, [
          fileURLToPath(import.meta.url), mode, lifecycle, root, cleanupSafety, String(length),
        ], { cwd: consumer, env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true });
        const result = JSON.parse(stdout);
        assert.equal(result.nativeLoaded, mode === "require");
        assert.equal(result.roundTrip, true);
        assert.equal(path.dirname(result.dir), root);
        assert.equal(result.dir.length, length);
        await absent(result.dir);
        assert.deepEqual(await fs.readdir(root), []);
        rows.push({ cleanupSafety, lifecycle, directoryLength: length });
      }
    }
    for (const cleanupSafety of ["compatible", "require-bounded"]) {
      let called = false;
      await assert.rejects(withTempFile({ rootDir: `${scratch}::$INDEX_ALLOCATION`, prefix, cleanupSafety },
        async () => { called = true; }), { code: "invalid-path" });
      assert.equal(called, false);
    }
    if (mode === "off") {
      await assert.rejects(tempFile({ rootDir: scratch, prefix, cleanupSafety: "require-bounded" }),
        { code: "helper-unavailable" });
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  await absent(scratch);
  console.log(JSON.stringify({ mode, source: expected.source, rootIntegrity: expected.rootIntegrity,
    compiledSha256: compiledHash, hostBinarySha256: hash(binary), nativeLoaded: nativeStatus.loaded,
    rows, aliasRejection: true, scratchRemoved: true }));
}
