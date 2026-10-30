import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { nativeBinaryLoaded, packageProofSource } from "./consumer-proof-metadata.mjs";

export function assertWindowsCapacityProof(proof) {
  assert.ok(["fallback", "native", "coverage"].includes(proof.workload), "unknown qualification workload");
  assert.ok(["standard", "control"].includes(proof.capacity), "unknown qualification capacity");
  assert.match(proof.expectedCommit, /^[0-9a-f]{40}$/u, "expected source commit is required");
  assert.equal(proof.source.commit, proof.expectedCommit, "qualification must use the exact frozen commit");
  assert.match(proof.source.tree, /^[0-9a-f]{40}$/u, "source tree is required");
  assert.equal(proof.source.dirty, false, "qualification source must be clean");
  assert.equal(proof.platform, "win32", "qualification requires native Windows");
  assert.equal(proof.arch, "x64", "qualification requires x64 Node");
  assert.equal(proof.logicalProcessors, proof.capacity === "standard" ? 4 : 16,
    "unexpected runner capacity; re-register the hardware comparison");
  assert.equal(proof.nodeMajor, proof.expectedNodeMajor, "unexpected Node release");
  assert.ok([22, 24, 26].includes(proof.nodeMajor), "unsupported qualification Node release");
  assert.ok(Number.isSafeInteger(proof.totalPhysicalBytes) && proof.totalPhysicalBytes > 0,
    "physical memory evidence is required");
  assert.ok(Number.isSafeInteger(proof.freePhysicalBytes) && proof.freePhysicalBytes > 0,
    "free memory evidence is required");
  assert.equal(proof.bindings.length, proof.workload === "coverage" ? 2 : 0,
    "fallback/native admission must be unbuilt; coverage must have both staged Windows bindings");
  if (proof.workload === "coverage") {
    assert.equal(proof.bindings[0].sha256, proof.bindings[1].sha256, "staged native bytes must match");
    assert.equal(proof.nativeLoaded, true, "coverage requires a loadable native binding");
  } else {
    assert.equal(proof.nativeLoaded, false, "fallback must not silently load a native binding");
  }
}

export function collectWindowsCapacityProof(env = process.env) {
  const paths = ["native/fs-safe-native.win32-x64-msvc.node", "packages/win32-x64-msvc/fs-safe-native.node"];
  const bindings = paths.filter((path) => existsSync(path)).map((path) => ({
    path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));
  let nativeLoaded = false;
  if (env.FS_SAFE_CAPACITY_WORKLOAD === "coverage" && bindings.length === 2) {
    createRequire(import.meta.url)(resolve(paths[0]));
    nativeLoaded = nativeBinaryLoaded(resolve(paths[0]));
  }
  const proof = {
    schema: 1,
    workload: env.FS_SAFE_CAPACITY_WORKLOAD,
    capacity: env.FS_SAFE_CAPACITY_STANDARD === "true" ? "standard" : "control",
    expectedCommit: env.FS_SAFE_CAPACITY_EXPECTED_COMMIT,
    source: packageProofSource(),
    platform: process.platform,
    arch: process.arch,
    logicalProcessors: cpus().length,
    cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
    totalPhysicalBytes: totalmem(),
    freePhysicalBytes: freemem(),
    node: process.version,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    expectedNodeMajor: Number(env.FS_SAFE_CAPACITY_NODE),
    image: { os: env.ImageOS, version: env.ImageVersion },
    bindings,
    nativeLoaded,
  };
  assertWindowsCapacityProof(proof);
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const proof = collectWindowsCapacityProof();
  assert.ok(process.env.RUNNER_TEMP, "runner evidence directory is required");
  const output = resolve(process.env.RUNNER_TEMP, "fs-safe-windows-capacity-proof.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
}
