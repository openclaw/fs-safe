import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SYNC_LOCK_ROOT_CAPTURE_PATH =
  "benchmarks/sync-lock-root-crabbox-capture-wsl2.sh";
export const SYNC_LOCK_ROOT_LANE_PATH =
  "benchmarks/sync-lock-root-crabbox-wsl2.sh";
export const SYNC_LOCK_ROOT_WORKFLOW_PATH =
  ".github/workflows/sync-lock-root-performance-proof.yml";
const FIXED_INPUTS = Object.freeze([
  ".crabbox.yaml",
  ".gitattributes",
  SYNC_LOCK_ROOT_WORKFLOW_PATH,
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);
export const SYNC_LOCK_ROOT_REQUIRED_HARNESS_PATHS = Object.freeze([
  "benchmarks/measured-distribution.mjs",
  "benchmarks/method-audit-evidence.mjs",
  "benchmarks/method-audit-plan.mjs",
  "benchmarks/runner.mjs",
  "benchmarks/sync-lock-root-analysis.mjs",
  "benchmarks/sync-lock-root-analyze.mjs",
  "benchmarks/sync-lock-root-campaign-state.mjs",
  "benchmarks/sync-lock-root-capture-files.mjs",
  "benchmarks/sync-lock-root-contract.mjs",
  SYNC_LOCK_ROOT_CAPTURE_PATH,
  "benchmarks/sync-lock-root-crabbox-capture.mjs",
  SYNC_LOCK_ROOT_LANE_PATH,
  "benchmarks/sync-lock-root-finalize-study.mjs",
  "benchmarks/sync-lock-root-gates.mjs",
  "benchmarks/sync-lock-root-harness-integrity.mjs",
  "benchmarks/sync-lock-root-hosted-provenance.mjs",
  "benchmarks/sync-lock-root-provenance.mjs",
  "benchmarks/sync-lock-root-tar.mjs",
  "benchmarks/sync-lock-root.mjs",
  ...FIXED_INPUTS,
]);
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(repositoryRoot, args, encoding = null) {
  return execFileSync("git", ["--no-replace-objects", "-C", repositoryRoot, ...args], {
    encoding,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
}

function immutableBytes(repositoryRoot, harnessSha, relative) {
  return git(repositoryRoot, ["cat-file", "blob", `${harnessSha}:${relative}`]);
}

export function createImmutableHarnessManifest(repositoryRoot, harnessSha) {
  assert.match(harnessSha, SHA1, "harness integrity SHA is invalid");
  const root = fs.realpathSync.native(repositoryRoot);
  const benchmarkPaths = String(git(root, [
    "ls-tree", "-r", "--name-only", harnessSha, "--", "benchmarks",
  ], "utf8")).split(/\r?\n/u).filter(Boolean);
  const paths = [...new Set([...benchmarkPaths, ...FIXED_INPUTS])].sort();
  for (const required of SYNC_LOCK_ROOT_REQUIRED_HARNESS_PATHS) {
    assert(paths.includes(required), `reviewed harness omits required input: ${required}`);
  }
  const files = paths.map((relative) => {
    const bytes = immutableBytes(root, harnessSha, relative);
    const blob = String(git(root, ["rev-parse", `${harnessSha}:${relative}`], "utf8")).trim();
    assert.match(blob, SHA1, `reviewed harness blob is invalid: ${relative}`);
    return { path: relative, blob, sha256: sha256(bytes), size: bytes.length };
  });
  const capture = files.find(({ path: relative }) => relative === SYNC_LOCK_ROOT_CAPTURE_PATH);
  assert(capture, "reviewed harness has no outer capture launcher");
  return {
    schema: "fs-safe-sync-lock-root-harness-integrity-v1",
    harnessSha,
    files,
    executedCapture: {
      sourcePath: SYNC_LOCK_ROOT_CAPTURE_PATH,
      sha256: capture.sha256,
      size: capture.size,
    },
  };
}

export function validateHarnessIntegrityManifest(manifest) {
  assert.deepEqual(Object.keys(manifest ?? {}).sort(), [
    "executedCapture", "files", "harnessSha", "schema",
  ]);
  assert.equal(manifest.schema, "fs-safe-sync-lock-root-harness-integrity-v1");
  assert.match(manifest.harnessSha, SHA1);
  assert(Array.isArray(manifest.files) &&
    manifest.files.length >= SYNC_LOCK_ROOT_REQUIRED_HARNESS_PATHS.length);
  assert.deepEqual(manifest.files.map(({ path: relative }) => relative),
    manifest.files.map(({ path: relative }) => relative).sort(),
  "harness integrity paths are not sorted");
  assert.equal(new Set(manifest.files.map(({ path: relative }) => relative)).size,
    manifest.files.length, "harness integrity paths overlap");
  for (const required of SYNC_LOCK_ROOT_REQUIRED_HARNESS_PATHS) {
    assert(manifest.files.some(({ path: relative }) => relative === required),
      `harness integrity omits required input: ${required}`);
  }
  for (const file of manifest.files) {
    assert.deepEqual(Object.keys(file).sort(), ["blob", "path", "sha256", "size"]);
    assert.equal(typeof file.path, "string");
    const components = file.path.split("/");
    assert(!path.isAbsolute(file.path) && !file.path.includes("\\") &&
      components.every((component) => component !== "" && component !== "." && component !== "..") &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(file.path),
    "harness integrity path is unsafe");
    assert.match(file.blob, SHA1);
    assert.match(file.sha256, SHA256);
    assert(Number.isSafeInteger(file.size) && file.size > 0);
  }
  assert.deepEqual(Object.keys(manifest.executedCapture ?? {}).sort(), [
    "sha256", "size", "sourcePath",
  ]);
  assert.equal(manifest.executedCapture.sourcePath, SYNC_LOCK_ROOT_CAPTURE_PATH);
  assert.match(manifest.executedCapture.sha256, SHA256);
  assert(Number.isSafeInteger(manifest.executedCapture.size) &&
    manifest.executedCapture.size > 0);
  const capture = manifest.files.find(({ path: relative }) =>
    relative === SYNC_LOCK_ROOT_CAPTURE_PATH);
  assert.deepEqual({
    sha256: manifest.executedCapture.sha256,
    size: manifest.executedCapture.size,
  }, { sha256: capture.sha256, size: capture.size },
  "executed capture receipt differs from its immutable source blob");
  return manifest;
}

export function assertHarnessBytesMatchManifest(repositoryRoot, executedCapture, manifest) {
  validateHarnessIntegrityManifest(manifest);
  const root = fs.realpathSync.native(repositoryRoot);
  for (const expected of manifest.files) {
    const file = path.join(root, ...expected.path.split("/"));
    const stat = fs.lstatSync(file, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n,
      `harness input is not a regular file: ${expected.path}`);
    const bytes = fs.readFileSync(file);
    assert.deepEqual({ sha256: sha256(bytes), size: bytes.length }, {
      sha256: expected.sha256, size: expected.size,
    }, `harness input bytes differ from reviewed blob: ${expected.path}`);
  }
  const captureStat = fs.lstatSync(executedCapture, { bigint: true });
  assert(captureStat.isFile() && !captureStat.isSymbolicLink() && captureStat.nlink === 1n,
    "executed capture launcher is not a private regular file");
  const captureBytes = fs.readFileSync(executedCapture);
  assert.deepEqual({ sha256: sha256(captureBytes), size: captureBytes.length }, {
    sha256: manifest.executedCapture.sha256,
    size: manifest.executedCapture.size,
  }, "executed capture launcher differs from reviewed blob");
  return manifest;
}

export function validateImmutableHarness(repositoryRoot, harnessSha, executedCapture) {
  const expected = createImmutableHarnessManifest(repositoryRoot, harnessSha);
  return assertHarnessBytesMatchManifest(repositoryRoot, executedCapture, expected);
}
