import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { configureFsSafeNative } from "../dist/index.js";
import { extractArchive, readArchiveEntry } from "../dist/archive.js";
import { readSecretFile, readSecretFileSync, tryReadSecretFile, tryReadSecretFileSync } from "../dist/secret.js";

const mode = process.argv[2];
assert.ok(mode === "off" || mode === "require", "usage: device-path-proof.mjs <off|require>");
configureFsSafeNative({ mode });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-device-proof-"));
const payload = Buffer.from("synthetic archive member\n");
const cases = [
  ["NUL", true],
  ["CON.txt", true],
  ["nul .txt", true],
  ["nested/COM1 .log", true],
  ["NUL/leaf.txt", true],
  ["console.txt", false],
  ["content.txt", false],
];

try {
  for (const [index, [member, reserved]] of cases.entries()) {
    const zip = new JSZip();
    zip.file(member, payload);
    const archivePath = path.join(directory, `${index}.zip`);
    const destDir = path.join(directory, `out-${index}`);
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    await fs.mkdir(destDir);
    const rejected = process.platform === "win32" && reserved;
    const extract = () => extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 10_000 });
    const read = () => readArchiveEntry(archivePath, member, { kind: "zip", maxBytes: payload.length });
    if (rejected) {
      await assert.rejects(extract, { code: "entry-path" });
      await assert.rejects(read, { code: "entry-path" });
      assert.deepEqual(await fs.readdir(destDir), []);
    } else {
      await extract();
      assert.deepEqual(await fs.readFile(path.join(destDir, member)), payload);
      assert.deepEqual(await read(), payload);
    }
    console.log(JSON.stringify({ platform: process.platform, mode, member,
      extraction: rejected ? "entry-path; destination empty" : "exact payload",
      boundedRead: rejected ? "entry-path" : "exact payload" }));
  }

  const regular = path.join(directory, "secret.txt");
  await fs.writeFile(regular, " synthetic token\n", { mode: 0o600 });
  assert.equal(await readSecretFile(regular, "proof"), "synthetic token");
  assert.equal(readSecretFileSync(regular, "proof"), "synthetic token");
  const devices = process.platform === "win32"
    ? [path.join(directory, "NUL"), path.join(directory, "nul .txt")]
    : ["/dev/urandom", "/dev/fd/99"];
  for (const device of devices) {
    await assert.rejects(() => readSecretFile(device, "proof"), { code: "device-path" });
    await assert.rejects(() => tryReadSecretFile(device, "proof"), { code: "device-path" });
    assert.throws(() => readSecretFileSync(device, "proof"), { code: "device-path" });
    assert.throws(() => tryReadSecretFileSync(device, "proof"), { code: "device-path" });
  }
  console.log(JSON.stringify({ platform: process.platform, mode,
    secretReads: "regular file accepted; async/sync strict/optional device paths rejected", result: "PASS" }));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
