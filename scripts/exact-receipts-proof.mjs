import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative } from "../dist/index.js";
import { publishFileExclusive } from "../dist/durability.js";
import { sameFileIdentity } from "../dist/advanced.js";

const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-exact-source-"));
const targetDir = await fs.mkdtemp(path.join(process.argv[2] ?? os.tmpdir(), "fs-safe-exact-target-"));
const counts = { files: 0, hardlink: 0, "exclusive-copy": 0, roundTrips: 0, falseMatches: 0, falseRejections: 0, unsafeNumericIds: 0 };
configureFsSafeNative({ mode: "off" });
try {
  for (let index = 0; index < 256; index++) {
    const source = path.join(sourceDir, `source-${index}`);
    await fs.writeFile(source, `exact receipt ${index}`);
    for (const [directory, route] of [[sourceDir, "same-volume"], [targetDir, "cross-volume"]]) {
      const target = path.join(directory, `published-${index}`);
      const receipt = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" });
      counts.files++;
      counts[receipt.method]++;
      if (!Number.isSafeInteger(receipt.identity.ino)) counts.unsafeNumericIds++;
      const handle = await fs.open(target);
      try {
        const observed = await handle.stat({ bigint: true });
        assert.deepEqual(receipt.exactIdentity, { dev: observed.dev, ino: observed.ino });
        assert.equal(sameFileIdentity(receipt, observed), true);
        assert.equal(sameFileIdentity(receipt, { dev: observed.dev, ino: observed.ino + 1n }), false);
        const second = await publishFileExclusive({ sourcePath: target, targetPath: path.join(directory, `roundtrip-${index}`), strategy: "link-required", expectedSourceIdentity: receipt.exactIdentity });
        assert.deepEqual(second.exactIdentity, receipt.exactIdentity);
        counts.roundTrips++;
        await assert.rejects(publishFileExclusive({ sourcePath: target, targetPath: path.join(directory, `wrong-${index}`), strategy: "link-required", expectedSourceIdentity: { dev: observed.dev, ino: observed.ino + 1n } }), { code: "path-mismatch" });
        if (route === "cross-volume" && process.argv[2]) assert.equal(receipt.method, "exclusive-copy");
      } finally { await handle.close(); }
    }
  }
  console.log(JSON.stringify({ platform: process.platform, ...counts }));
} finally {
  await fs.rm(sourceDir, { recursive: true, force: true });
  await fs.rm(targetDir, { recursive: true, force: true });
}
