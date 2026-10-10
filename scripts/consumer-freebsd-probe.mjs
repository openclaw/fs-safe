import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { root } from "@openclaw/fs-safe/root";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { sha256File } from "@openclaw/fs-safe/durability";
import { probeTreeClone } from "@openclaw/fs-safe/copy";

assert.equal(process.platform, "freebsd");
const expected = JSON.parse(readFileSync("expected.json", "utf8"));
const require = createRequire(import.meta.url);
const rootRequire = createRequire(require.resolve("@openclaw/fs-safe/package.json"));
const rows = [];
const directory = await fs.mkdtemp(path.join(process.cwd(), "freebsd-proof-"));
try {
  const native = expected.omitted ? undefined : rootRequire(expected.host.package);
  if (native) {
    assert.deepEqual(Object.keys(native).sort(), ["canonicalizePath", "closeOwnedFd"]);
    const file = path.join(directory, "original");
    const link = path.join(directory, "link");
    await fs.writeFile(file, "native canonicalization");
    await fs.symlink("original", link);
    for (const ordinary of [false, true]) {
      assert.equal(native.canonicalizePath(link, ordinary).path, await fs.realpath(file));
      assert.equal(native.canonicalizePath(path.join(directory, "missing"), ordinary).errno, 2);
    }
    assert.throws(() => native.closeOwnedFd(-1), { code: "EBADF" });
    rows.push("native-exports", "native-canonicalization", "native-negative-close");
  }
  for (const mode of ["off", "auto"]) {
    configureFsSafeNative({ mode });
    const scoped = await root(directory);
    await scoped.write(`${mode}/file`, "guarded fallback");
    assert.equal((await scoped.read(`${mode}/file`)).buffer.toString(), "guarded fallback");
    assert.equal((await sha256File(path.join(directory, mode, "file"))).bytes, 16);
    assert.equal(probeTreeClone(directory), undefined);
    await assert.rejects(scoped.read("../outside"));
    await fs.symlink("file", path.join(directory, mode, "alias"));
    await assert.rejects(scoped.read(`${mode}/alias`));
    rows.push(`${mode}-write-read`, `${mode}-hash`, `${mode}-confinement`);
  }
  configureFsSafeNative({ mode: "require" });
  const scoped = await root(directory);
  await assert.rejects(scoped.write("unavailable", "must not publish"), { code: "helper-unavailable" });
  await assert.rejects(fs.stat(path.join(directory, "unavailable")), { code: "ENOENT" });
  await assert.rejects(sha256File(path.join(directory, "auto/file")), { code: "helper-unavailable" });
  assert.throws(() => probeTreeClone(directory), { code: "helper-unavailable" });
  rows.push("require-before-mutation", "require-hash", "require-clone");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const [[workerRows], [exitCode]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
  assert.equal(exitCode, 0);
  assert.deepEqual(workerRows, rows);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version,
    omitted: expected.omitted, main: rows, worker: workerRows }));
} else parentPort.postMessage(rows);
