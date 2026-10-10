import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import { provePipe } from "../test/fixtures/pipe-proof.mjs";
import { proveCanonicalization } from "./freebsd-canonical-proof.mjs";
import { packageProofSource } from "./consumer-proof-metadata.mjs";

const completed = ["owned-anonymous-pipe", "reopen-and-eof", "idempotent-close",
  "close-on-exec", "stream-native-close", "1000-cycles-no-leak"];
assert.deepEqual(await provePipe(), completed);
const canonical = await proveCanonicalization();
const canonicalWorker = new Worker(new URL("./freebsd-canonical-proof.mjs", import.meta.url));
try {
  const signal = AbortSignal.timeout(15_000);
  const [[result], [code]] = await Promise.all([once(canonicalWorker, "message", { signal }), once(canonicalWorker, "exit", { signal })]);
  assert.equal(code, 0);
  assert.deepEqual(result, canonical);
} finally {
  await canonicalWorker.terminate();
}
const worker = new Worker(new URL("../test/fixtures/pipe-proof.mjs", import.meta.url), { stdout: true, stderr: true });
let stderr = "";
worker.stdout.resume();
worker.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
try {
  const signal = AbortSignal.timeout(15_000);
  const [[result], [code]] = await Promise.all([once(worker, "message", { signal }), once(worker, "exit", { signal })]);
  assert.equal(code, 0);
  assert.deepEqual(result, { completed, warnings: [] });
  assert.equal(stderr, "");
} finally {
  await worker.terminate();
}
for (const thread of ["main", "worker"]) {
  const result = spawnSync("/bin/sh", ["-c", 'ulimit -n 64 || exit; exec "$1" "$2" "$3"', "fs-safe-pipe-limit",
    process.execPath, fileURLToPath(new URL("../test/fixtures/pipe-descriptor-limit.mjs", import.meta.url)), thread],
  { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { thread, failures: ["EMFILE", "EMFILE"], recovered: true });
  assert.equal(result.stderr, "");
}
const source = packageProofSource();
if (process.env.FS_SAFE_EXPECTED_SOURCE_COMMIT) {
  assert.equal(source.commit, process.env.FS_SAFE_EXPECTED_SOURCE_COMMIT);
  assert.equal(source.dirty, false);
}
const proof = { platform: process.platform, arch: process.arch, node: process.version, source,
  main: completed, worker: completed, canonical, canonicalWorker: canonical,
  descriptorLimit: ["main", "worker"] };
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/freebsd-native-proof.json", `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify(proof));
