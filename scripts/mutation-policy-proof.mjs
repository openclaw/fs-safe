import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EXTENDED_CASES, extendedCase, executeExtendedCase } from "./mutation-policy-proof-cases.mjs";

const PROOF = "mutation-policy-public-behavior";
const SCHEMA = "fs-safe-mutation-policy-proof-v2";
const WORKER_SCHEMA = "fs-safe-mutation-policy-worker-v2";
const RECEIPT_MAX_BYTES = 32 * 1024;
const WORKER_MAX_BYTES = 4 * 1024;
const WORKER_TIMEOUT_MS = 15_000;
const IO_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 10_000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ADDON_BYTES = 128 * 1024 * 1024;
const PAYLOAD = Buffer.from("mutation-policy-proof-payload\n", "utf8");

const ALL_CASES = Object.freeze([
  "allowed-mkdir",
  "allowed-open-writable",
  "allowed-append",
  "post-create-symlink-optimized",
  "post-create-symlink-forced",
  "post-create-file-optimized",
  "post-create-file-forced",
  "post-create-observation-optimized",
  "post-create-observation-forced",
  "os-eexist-directory",
  "os-eexist-file",
  "parent-replacement-authority-fence",
  "root-replacement-authority-fence",
  "stale-missing-parent-recapture",
  "denied-parent-redirect",
  "deny-spelling-drift",
  "native-config-drift",
  "selected-destination-stable",
  "selected-destination-retarget",
  "authority-refusal-immediate",
  "authority-refusal-mid-walk",
  "pinned-write-off",
  "pinned-write-require",
  "pinned-create-off",
  "pinned-create-require",
  "pinned-copy-in-off",
  "pinned-copy-in-require",
  ...EXTENDED_CASES.map(entry => entry.name),
]);

const POSIX_ONLY_CASES = new Set([
  "root-replacement-authority-fence",
  "pinned-write-off",
  "pinned-write-require",
  "pinned-create-off",
  "pinned-create-require",
  "pinned-copy-in-off",
  "pinned-copy-in-require",
]);

const PINNED_CASES = new Set([
  "pinned-write-off",
  "pinned-write-require",
  "pinned-create-off",
  "pinned-create-require",
  "pinned-copy-in-off",
  "pinned-copy-in-require",
]);

const REQUIRE_CASES = new Set([
  "pinned-write-require",
  "pinned-create-require",
  "pinned-copy-in-require",
]);

const HASH_BINDINGS = Object.freeze({
  mutationAdmissionSource: "src/pinned-mutation-admission.ts",
  mutationObservationSource: "src/pinned-mutation-observation.ts",
  sharedRouteSource: "src/pinned-mutation-shared-route.ts",
  guardedMkdirSource: "src/guarded-mkdir.ts",
  rootDirectoryCreationSource: "src/root-directory-creation.ts",
  rootWriteAdmissionSource: "src/root-write-admission.ts",
  rootWriteCompleteParentSource: "src/root-write-complete-parent.ts",
  rootWriteCompatibilitySource: "src/root-write-compatibility.ts",
  rootWriteLockBindingSource: "src/root-write-lock-binding.ts",
  rootPathExistingSource: "src/root-path-existing.ts",
  stagedDirectorySource: "src/staged-directory.ts",
  nativePolicyDirectoryObservationSource: "src/native-policy-directory-observation.ts",
  nativePinnedWriteSource: "src/native-pinned-write.ts",
  pinnedWriteSource: "src/pinned-write.ts",
  rootImplementationSource: "src/root-impl.ts",
  publicIndexSource: "src/index.ts",
  mutationAdmissionBuilt: "dist/pinned-mutation-admission.js",
  mutationObservationBuilt: "dist/pinned-mutation-observation.js",
  sharedRouteBuilt: "dist/pinned-mutation-shared-route.js",
  guardedMkdirBuilt: "dist/guarded-mkdir.js",
  rootDirectoryCreationBuilt: "dist/root-directory-creation.js",
  rootWriteAdmissionBuilt: "dist/root-write-admission.js",
  rootWriteCompleteParentBuilt: "dist/root-write-complete-parent.js",
  rootWriteCompatibilityBuilt: "dist/root-write-compatibility.js",
  rootWriteLockBindingBuilt: "dist/root-write-lock-binding.js",
  rootPathExistingBuilt: "dist/root-path-existing.js",
  stagedDirectoryBuilt: "dist/staged-directory.js",
  nativePolicyDirectoryObservationBuilt: "dist/native-policy-directory-observation.js",
  nativePinnedWriteBuilt: "dist/native-pinned-write.js",
  pinnedWriteBuilt: "dist/pinned-write.js",
  rootImplementationBuilt: "dist/root-impl.js",
  publicIndexBuilt: "dist/index.js",
  nativeUnixSource: "native/src/unix.rs",
  nativeWindowsSource: "native/src/windows.rs",
  nativeLibrarySource: "native/src/lib.rs",
  nativeDirectoryObservationSource: "native/src/directory_observation.rs",
  publicPackageManifest: "package.json",
  dependencyLock: "pnpm-lock.yaml",
  proofHarness: "scripts/mutation-policy-proof.mjs",
  proofCases: "scripts/mutation-policy-proof-cases.mjs",
  proofWorkflow: ".github/workflows/mutation-policy-proof.yml",
  proofContractTests: "test/mutation-policy-proof-contract.test.ts",
  proofCaseContractTests: "test/mutation-policy-proof-cases-contract.test.ts",
  publicTestHooksSource: "src/test-hooks.ts",
  publicTestHooksBuilt: "dist/test-hooks.js",
  nativeStageSource: "src/native-staged-file.ts",
  nativeStageBuilt: "dist/native-staged-file.js",
  nativeOperationsSource: "src/native-operations.ts",
  nativeOperationsBuilt: "dist/native-operations.js",
  writeHandleSource: "src/write-file-handle.ts",
  writeHandleBuilt: "dist/write-file-handle.js",
  stageCleanupSource: "src/replace-file-temp-owner.ts",
  stageCleanupBuilt: "dist/replace-file-temp-owner.js",
  optimizedMutationTests: "test/root-shared-js-mutation-policy.test.ts",
  completeParentTests: "test/root-shared-js-complete-parent.test.ts",
  missingParentTests: "test/root-shared-js-missing-parent.test.ts",
  postCreateTests: "test/root-mkdir-post-create.test.ts",
  receiptStateTests: "test/pinned-mutation-receipt.test.ts",
  receiptWalkTests: "test/pinned-mutation-receipt-walk.test.ts",
  nativeAdmissionTests: "test/native-mutation-policy-admission.test.ts",
  nativeIntegrationTests: "test/native-mutation-policy-integration.test.ts",
});

const FORBIDDEN_RECEIPT_KEYS = new Set([
  "cwd", "directory", "fd", "file", "filename", "host", "hostname",
  "message", "pathname", "stack",
]);

class ProofFailure extends Error {
  constructor(proofCode) {
    super("proof invariant failed");
    this.proofCode = proofCode;
  }
}

function invariant(value, code) {
  if (!value) throw new ProofFailure(code);
}

function safeCode(value) {
  return typeof value === "string" &&
    /^(?:[A-Z][A-Z0-9_]{0,47}|[a-z][a-z0-9-]{0,47})$/u.test(value)
    ? value
    : undefined;
}

function safeStage(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/u.test(value)
    ? value
    : "unknown";
}

export function sanitizeProofFailure(error, stage = "unknown") {
  const candidate = error instanceof ProofFailure
    ? error.proofCode
    : error && (typeof error === "object" || typeof error === "function")
      ? error.code
      : undefined;
  const failure = {
    kind: error instanceof ProofFailure ? "proof" : error instanceof Error ? "error" : "non-error",
    stage: safeStage(stage),
  };
  const code = safeCode(candidate);
  if (code !== undefined) failure.code = code;
  return failure;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
    }
    return result;
  }
  invariant(typeof value !== "bigint", "RECEIPT_BIGINT");
  if (typeof value === "number") invariant(Number.isFinite(value), "RECEIPT_NONFINITE");
  return value;
}

export function canonicalReceipt(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function safeReceiptTree(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value === "string") {
    return Buffer.byteLength(value) <= 256 &&
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[A-Za-z]:[\\/]/u.test(value) &&
      !value.includes("file://");
  }
  if (Array.isArray(value)) {
    return value.length <= 128 && value.every((entry) => safeReceiptTree(entry, depth + 1));
  }
  if (typeof value !== "object") return false;
  const keys = Object.keys(value);
  return keys.length <= 128 && keys.every((key) =>
    /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key) &&
    !FORBIDDEN_RECEIPT_KEYS.has(key.toLowerCase()) &&
    safeReceiptTree(value[key], depth + 1));
}

export function validateFinalReceiptText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > RECEIPT_MAX_BYTES ||
    !/^[\x20-\x7e]*\n$/u.test(text)) return null;
  let value;
  let canonical;
  try { value = JSON.parse(text); canonical = canonicalReceipt(value); } catch { return null; }
  if (canonical !== text || !safeReceiptTree(value) || !exactKeys(value, [
    "cases", "coverage", "failure", "passed", "proof", "provenance", "runtime", "schema", "status",
  ]) || !exactKeys(value?.coverage, ["complementary", "hosted", "limitations"]) ||
    !exactKeys(value?.runtime, ["arch", "libuv", "node", "platform", "v8"]) ||
    value?.schema !== SCHEMA || value?.proof !== PROOF ||
    typeof value?.passed !== "boolean" ||
    !["pending", "failed", "passed"].includes(value?.status) ||
    value.passed !== (value.status === "passed") || !Array.isArray(value?.cases) ||
    ![value.coverage.complementary, value.coverage.hosted, value.coverage.limitations]
      .every((entries) => Array.isArray(entries) && entries.every((entry) => typeof entry === "string"))) {
    return null;
  }
  if (value.passed ? value.failure !== null :
    (!exactKeys(value.failure, ["kind", "stage"]) &&
      !exactKeys(value.failure, ["code", "kind", "stage"]))) return null;
  if (!value.passed && (
    !["proof", "error", "non-error"].includes(value.failure.kind) ||
    safeStage(value.failure.stage) !== value.failure.stage ||
    (Object.hasOwn(value.failure, "code") && safeCode(value.failure.code) === undefined)
  )) return null;
  if (!validateFinalReceiptSemantics(value)) return null;
  return value;
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function expectedCaseNames(platform) {
  return ALL_CASES.filter((caseName) => {
    const extension = extendedCase(caseName);
    if (extension) return (platform === "win32") === (extension.platform === "win32");
    return platform !== "win32" || !POSIX_ONLY_CASES.has(caseName);
  });
}

function expectedCoverage(platform) {
  return {
    complementary: [
      "awaited-selected-retarget--optimizedMutationTests",
      "optimized-complete-parent-replacement--completeParentTests",
      "optimized-config-refresh-counts--receiptStateTests",
      "optimized-denial-order--completeParentTests",
      "post-create-error-contracts--postCreateTests",
      "receipt-stale-epoch--receiptStateTests",
      "receipt-walk-transitions--receiptWalkTests",
      "real-native-admission--nativeAdmissionTests",
      "real-native-integration--nativeIntegrationTests",
    ],
    hosted: [
      "allowed-shared-mutations",
      "authority-refusal",
      "exact-parent-post-create",
      "live-config-drift",
      "missing-parent-state",
      "os-eexist-classification",
      "parent-identity-fences",
      ...(platform === "win32" ? [] : ["posix-pinned-off-and-require"]),
      ...(platform === "win32"
        ? ["windows-buffer-write-refusal-and-private-stage-cleanup"]
        : ["posix-pinned-parent-denial-and-replacement", "posix-pinned-write-refusal-epochs"]),
      "selected-destination-authority-boundary",
    ],
    limitations: platform === "win32"
      ? [
        "awaited-admission-seams-bound-to-hashed-internal-tests",
        "posix-pinned-routes-not-applicable",
        "root-replacement-not-hosted-on-windows",
        "stale-receipt-refresh-bound-to-hashed-internal-tests",
        "compat-require-native-addon-use-is-lock-publication",
      ]
      : [
        "awaited-admission-seams-bound-to-hashed-internal-tests",
        "stale-receipt-refresh-bound-to-hashed-internal-tests",
        "redirect-injection-uses-built-public-test-hook-after-preflight",
      ],
  };
}

function validRuntime(runtime) {
  return exactKeys(runtime, ["arch", "libuv", "node", "platform", "v8"]) &&
    ["linux", "darwin", "win32"].includes(runtime.platform) &&
    ["x64", "arm64"].includes(runtime.arch) &&
    (runtime.platform !== "win32" || runtime.arch === "x64") &&
    typeof runtime.node === "string" && /^v[0-9]{1,3}\.[0-9][0-9A-Za-z.+_-]{0,62}$/u.test(runtime.node) &&
    typeof runtime.libuv === "string" && /^[0-9A-Za-z.+_-]{1,64}$/u.test(runtime.libuv) &&
    typeof runtime.v8 === "string" && /^[0-9A-Za-z.+_-]{1,64}$/u.test(runtime.v8);
}

function nativeTargetMatchesRuntime(target, runtime) {
  if (runtime.platform === "darwin") return target === `darwin-${runtime.arch}`;
  if (runtime.platform === "win32") return target === "win32-x64-msvc";
  return target === `linux-${runtime.arch}-gnu` || target === `linux-${runtime.arch}-musl`;
}

function validateProvenance(provenance, runtime) {
  if (!exactKeys(provenance, ["binding", "stableAfterWorkers", "token"]) ||
    typeof provenance.stableAfterWorkers !== "boolean" ||
    typeof provenance.token !== "string" || !/^[0-9a-f]{64}$/u.test(provenance.token)) return null;
  const binding = provenance.binding;
  if (!exactKeys(binding, ["checkout", "event", "hashes", "nativeTarget", "run"]) ||
    !exactKeys(binding.checkout, [
      "commit", "dirty", "expectedCommit", "expectedMatches", "tree",
    ]) || !exactKeys(binding.event, ["base", "head", "headMatchesCheckout", "name"]) ||
    !exactKeys(binding.run, ["attempt", "id", "number"])) return null;
  const sha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
  if (!sha(binding.checkout.commit) || !sha(binding.checkout.expectedCommit) ||
    !sha(binding.checkout.tree) || binding.checkout.commit !== binding.checkout.expectedCommit ||
    binding.checkout.dirty !== false || binding.checkout.expectedMatches !== true ||
    !sha(binding.event.head) || binding.event.head !== binding.checkout.commit ||
    binding.event.headMatchesCheckout !== true ||
    !(binding.event.base === null || sha(binding.event.base)) ||
    typeof binding.event.name !== "string" || !/^[a-z_]{1,32}$/u.test(binding.event.name) ||
    !nativeTargetMatchesRuntime(binding.nativeTarget, runtime)) return null;
  for (const value of Object.values(binding.run)) {
    if (typeof value !== "string" ||
      !(value === "unavailable" || /^[0-9]{1,20}$/u.test(value))) return null;
  }
  const hashLabels = [...Object.keys(HASH_BINDINGS), "nativePackageManifest", "nativeAddon"];
  if (!exactKeys(binding.hashes, hashLabels)) return null;
  for (const [label, value] of Object.entries(binding.hashes)) {
    const maximum = label === "nativeAddon" ? MAX_ADDON_BYTES : MAX_SOURCE_BYTES;
    if (!exactKeys(value, ["bytes", "sha256"]) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maximum ||
      typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) return null;
  }
  if (sha256(canonicalReceipt(binding)) !== provenance.token) return null;
  return provenance;
}

function validateCases(cases, expectedNames, token, requireComplete, platform) {
  if (cases.length > expectedNames.length || (requireComplete && cases.length !== expectedNames.length)) {
    return false;
  }
  return cases.every((worker, index) => {
    const caseName = expectedNames[index];
    const parsed = parseWorkerReceipt(
      canonicalReceipt(worker), caseName, expectedBackend(caseName), token,
    );
    return parsed !== null &&
      (!parsed.passed || validateSuccessfulObservations(
        caseName,
        expectedBackend(caseName),
        parsed.observations,
        platform,
      )) &&
      (!requireComplete || parsed.passed);
  });
}

function exactObservationValues(observations, expected) {
  return exactKeys(observations, Object.keys(expected)) &&
    Object.entries(expected).every(([key, value]) => observations[key] === value);
}

function validateSuccessfulObservations(caseName, backend, observations, platform) {
  const common = {
    addonLoaded: backend === "pinned-native/require" || backend === "windows-js/require",
    builtPublicImport: true,
    node24: true,
    privateFixture: true,
    privilegeModel: platform === "win32" ? "no-elevation-requested" : "posix-nonroot",
  };
  let specific;
  if (extendedCase(caseName)) {
    specific = extendedCase(caseName).observations;
  } else if (caseName === "allowed-mkdir") {
    specific = { route: "shared-missing-parent", targetDirectory: true };
  } else if (caseName === "allowed-open-writable" || caseName === "allowed-append") {
    specific = { route: "shared-missing-parent", targetBytes: PAYLOAD.length };
  } else if (caseName.startsWith("post-create-")) {
    const forced = caseName.endsWith("forced");
    const observation = caseName.includes("observation");
    if (!Number.isSafeInteger(observations.authorityCalls) ||
      (forced ? observations.authorityCalls < 1 : observations.authorityCalls !== 0)) return false;
    specific = {
      authorityCalls: observations.authorityCalls,
      faultCount: observation ? 1 : 0,
      mkdirAttempts: 1,
      mkdirCompletions: 1,
      route: forced ? "component-walk-authority" : "exact-parent-optimized",
    };
  } else if (caseName === "os-eexist-directory" || caseName === "os-eexist-file") {
    specific = {
      collision: caseName.endsWith("directory") ? "directory" : "file",
      genuineEexist: true,
      mkdirAttempts: 1,
      route: "exact-parent-optimized",
    };
  } else if (caseName === "parent-replacement-authority-fence") {
    specific = { authoritySwap: true, childMkdirSubmissions: 0, route: "component-walk-authority" };
  } else if (caseName === "root-replacement-authority-fence") {
    specific = { authoritySwap: true, originalParentEmpty: true, replacementParentEmpty: true,
      route: "component-walk-authority" };
  } else if (caseName === "stale-missing-parent-recapture") {
    specific = {
      currentParentUsed: true,
      route: "shared-post-create-current-selection",
      staleParentUnused: true,
    };
  } else if (caseName === "denied-parent-redirect") {
    specific = { deniedParentEmpty: true, displacedParentEmpty: true, rejectedCode: "denied-path",
      redirectInjected: true, route: "full-policy-refresh" };
  } else if (caseName === "deny-spelling-drift") {
    specific = {
      denySpellingAppeared: true,
      nextComponentMkdirSubmissions: 0,
      route: "shared-policy-refresh",
    };
  } else if (caseName === "native-config-drift") {
    if (!Number.isSafeInteger(observations.safeMkdirs) || observations.safeMkdirs < 2) return false;
    specific = {
      configChanged: true,
      modeAfter: "auto",
      route: "shared-refresh",
      safeMkdirs: observations.safeMkdirs,
    };
  } else if (caseName === "selected-destination-stable" ||
    caseName === "selected-destination-retarget") {
    const retarget = caseName.endsWith("retarget");
    specific = {
      authorityCallbacks: retarget ? 1 : 0,
      handlesClosed: true,
      route: retarget ? "followed-final-authority-fence" : "followed-final-stable",
    };
  } else if (caseName === "authority-refusal-immediate" ||
    caseName === "authority-refusal-mid-walk") {
    const midWalk = caseName.endsWith("mid-walk");
    specific = {
      authorityCalls: midWalk ? 2 : 1,
      firstMkdirs: midWalk ? 1 : 0,
      route: "component-walk-authority",
      secondMkdirs: 0,
    };
  } else if (caseName.startsWith("pinned-")) {
    const operation = caseName.startsWith("pinned-write-") ? "write" :
      caseName.startsWith("pinned-create-") ? "create" : "copy";
    specific = {
      operation,
      route: operation === "copy" ? "pinned-file-copy" : "pinned-buffer-write",
      targetBytes: PAYLOAD.length,
    };
  } else {
    return false;
  }
  return exactObservationValues(observations, { ...specific, ...common });
}

function isTerminalWorkflowFallback(value) {
  return value.passed === false && value.status === "failed" &&
    value.cases.length === 0 && value.provenance === null &&
    JSON.stringify(value.coverage) === JSON.stringify({
      complementary: [], hosted: [], limitations: [],
    }) && exactObservationValues(value.failure, {
      code: "RECEIPT_INVALID", kind: "proof", stage: "workflow-fallback",
    }) && exactObservationValues(value.runtime, {
      arch: "unknown", libuv: "unknown", node: "unknown", platform: "unknown", v8: "unknown",
    });
}

function validateFinalReceiptSemantics(value) {
  if (isTerminalWorkflowFallback(value)) return true;
  if (!validRuntime(value.runtime)) return false;
  if (value.passed && !value.runtime.node.startsWith("v24.")) return false;
  const emptyCoverage = { complementary: [], hosted: [], limitations: [] };
  const coverage = expectedCoverage(value.runtime.platform);
  const coverageText = JSON.stringify(value.coverage);
  const hasExpectedCoverage = coverageText === JSON.stringify(coverage);
  const hasEmptyCoverage = coverageText === JSON.stringify(emptyCoverage);
  if (value.status === "pending") {
    return value.cases.length === 0 && value.provenance === null && hasEmptyCoverage;
  }
  if (value.provenance === null) {
    return !value.passed && value.cases.length === 0 && (hasExpectedCoverage || hasEmptyCoverage);
  }
  const provenance = validateProvenance(value.provenance, value.runtime);
  if (provenance === null || !hasExpectedCoverage) return false;
  const expectedNames = expectedCaseNames(value.runtime.platform);
  if (!validateCases(
    value.cases, expectedNames, provenance.token, value.passed, value.runtime.platform,
  )) return false;
  return !value.passed || provenance.stableAfterWorkers === true;
}

export function expectedFinalReceiptContract() {
  const caseNames = expectedCaseNames(process.platform);
  return {
    cases: caseNames.map((name) => ({ backend: expectedBackend(name), name })),
    coverage: expectedCoverage(process.platform),
    hashLabels: [...Object.keys(HASH_BINDINGS), "nativePackageManifest", "nativeAddon"],
    nativeTarget: nativeTargetLabel(),
  };
}

function safeObservation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 40 && entries.every(([key, entry]) =>
    /^[a-z][A-Za-z0-9]{0,47}$/u.test(key) &&
    (typeof entry === "boolean" ||
      (Number.isSafeInteger(entry) && entry >= 0 && entry <= 1_000_000) ||
      (typeof entry === "string" && /^[A-Za-z0-9][A-Za-z0-9_/-]{0,63}$/u.test(entry))));
}

export function parseWorkerReceipt(output, expectedCase, expectedBackend, expectedProvenance) {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : output;
  if (typeof text !== "string" || Buffer.byteLength(text) > WORKER_MAX_BYTES ||
    !/^[\x20-\x7e]*\n$/u.test(text)) return null;
  let value;
  let canonical;
  try { value = JSON.parse(text); canonical = canonicalReceipt(value); } catch { return null; }
  if (canonical !== text || !exactKeys(value, [
    "backend", "case", "complete", "failure", "observations", "passed", "provenance", "schema",
  ]) || !safeReceiptTree(value) || value.schema !== WORKER_SCHEMA ||
    value.case !== expectedCase || value.backend !== expectedBackend ||
    value.provenance !== expectedProvenance || typeof value.complete !== "boolean" ||
    typeof value.passed !== "boolean" || value.complete !== value.passed ||
    !safeObservation(value.observations)) return null;
  if (value.passed) {
    if (value.failure !== null) return null;
  } else if (!exactKeys(value.failure, ["kind", "stage"]) &&
    !exactKeys(value.failure, ["code", "kind", "stage"])) return null;
  if (!value.passed && (
    !["proof", "error", "non-error"].includes(value.failure.kind) ||
    !["arguments", "public-import", "behavior"].includes(value.failure.stage) ||
    (Object.hasOwn(value.failure, "code") && safeCode(value.failure.code) === undefined)
  )) return null;
  return value;
}

function pendingReceipt(code = "PENDING", stage = "startup") {
  return {
    cases: [],
    coverage: { complementary: [], hosted: [], limitations: [] },
    failure: { code, kind: "proof", stage },
    passed: false,
    proof: PROOF,
    provenance: null,
    runtime: {
      arch: process.arch,
      libuv: process.versions.uv,
      node: process.version,
      platform: process.platform,
      v8: process.versions.v8,
    },
    schema: SCHEMA,
    status: "pending",
  };
}

async function bounded(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProofFailure(code)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanup(operation) {
  try {
    await bounded(Promise.resolve().then(operation), CLEANUP_TIMEOUT_MS, "CLEANUP_TIMEOUT");
    return true;
  } catch {
    return false;
  }
}

async function writeReceiptAtomically(receiptPath, receipt) {
  const text = canonicalReceipt(receipt);
  invariant(validateFinalReceiptText(text) !== null, "FINAL_RECEIPT_INVALID");
  const temporary = `${receiptPath}.new-${process.pid}`;
  let handle;
  try {
    try {
      const current = await bounded(fs.lstat(receiptPath), IO_TIMEOUT_MS, "RECEIPT_LSTAT_TIMEOUT");
      invariant(current.isFile() && !current.isSymbolicLink(), "RECEIPT_TARGET_UNSAFE");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    handle = await bounded(fs.open(temporary, "wx", 0o600), IO_TIMEOUT_MS, "RECEIPT_OPEN_TIMEOUT");
    await bounded(handle.writeFile(text, "utf8"), IO_TIMEOUT_MS, "RECEIPT_WRITE_TIMEOUT");
    await bounded(handle.sync(), IO_TIMEOUT_MS, "RECEIPT_SYNC_TIMEOUT");
    await bounded(handle.close(), IO_TIMEOUT_MS, "RECEIPT_CLOSE_TIMEOUT");
    handle = undefined;
    await bounded(fs.rename(temporary, receiptPath), IO_TIMEOUT_MS, "RECEIPT_RENAME_TIMEOUT");
  } finally {
    if (handle !== undefined) await cleanup(() => handle.close());
    await cleanup(() => fs.rm(temporary, { force: true }));
  }
  return text;
}

function parsePairs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new ProofFailure("INVALID_ARGUMENTS");
    }
    values.set(key, value);
  }
  return values;
}

export function parseArguments(argv) {
  const mode = argv[0];
  if (mode === "--initialize" || mode === "--ensure") {
    const values = parsePairs(argv.slice(1));
    if (values.size !== 1 || !values.has("--receipt")) throw new ProofFailure("INVALID_ARGUMENTS");
    const receiptPath = values.get("--receipt");
    if (!path.isAbsolute(receiptPath) || receiptPath.includes("\0")) {
      throw new ProofFailure("INVALID_ARGUMENTS");
    }
    return { mode: mode.slice(2), receiptPath };
  }
  if (mode !== "--run") throw new ProofFailure("INVALID_ARGUMENTS");
  const values = parsePairs(argv.slice(1));
  const required = [
    "--receipt", "--expected-commit", "--event-head", "--event-base", "--event-name",
    "--install-result", "--build-result", "--native-result",
  ];
  if (values.size !== required.length || required.some((key) => !values.has(key))) {
    throw new ProofFailure("INVALID_ARGUMENTS");
  }
  const receiptPath = values.get("--receipt");
  const hash = (value) => /^[0-9a-f]{40}$/u.test(value);
  const result = (value) => ["success", "failure", "skipped", "cancelled"].includes(value);
  if (!path.isAbsolute(receiptPath) || receiptPath.includes("\0") ||
    !hash(values.get("--expected-commit")) || !hash(values.get("--event-head")) ||
    !(values.get("--event-base") === "none" || hash(values.get("--event-base"))) ||
    !/^[a-z_]{1,32}$/u.test(values.get("--event-name")) ||
    !result(values.get("--install-result")) || !result(values.get("--build-result")) ||
    !result(values.get("--native-result"))) throw new ProofFailure("INVALID_ARGUMENTS");
  return {
    buildResult: values.get("--build-result"),
    eventBase: values.get("--event-base") === "none" ? null : values.get("--event-base"),
    eventHead: values.get("--event-head"),
    eventName: values.get("--event-name"),
    expectedCommit: values.get("--expected-commit"),
    installResult: values.get("--install-result"),
    mode: "run",
    nativeResult: values.get("--native-result"),
    receiptPath,
  };
}

export function runBoundedProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? WORKER_MAX_BYTES;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;
    let spawnCode;
    let forceTimer;
    const stop = () => {
      try { child.kill("SIGTERM"); } catch { /* The close/error event remains authoritative. */ }
      forceTimer ??= setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* The workflow timeout remains the outer bound. */ }
      }, 1_000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxStdoutBytes) chunks.push(chunk);
      else { overflow = true; stop(); }
    });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
    child.on("error", (error) => { spawnCode = safeCode(error?.code); });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({
        exitCode,
        overflow,
        reaped: true,
        signal: signal === null ? null : safeCode(signal) ?? "signal",
        spawnCode,
        stderrBytes,
        stdout: Buffer.concat(chunks),
        stdoutBytes,
        timedOut,
      });
    });
  });
}

function git(repository, args) {
  const run = fsSync.realpathSync.native(repository);
  const command = process.platform === "win32" ? "git.exe" : "git";
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: run,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
}

async function hashFile(repository, relativePath, maximumBytes = MAX_SOURCE_BYTES) {
  const pathname = path.resolve(repository, relativePath);
  invariant(path.relative(repository, pathname).split(path.sep)[0] !== "..", "HASH_TARGET_OUTSIDE");
  const pathBefore = await bounded(fs.lstat(pathname, { bigint: true }), IO_TIMEOUT_MS, "HASH_LSTAT_TIMEOUT");
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink(), "HASH_PATH_INVALID");
  const handle = await bounded(fs.open(pathname, "r"), IO_TIMEOUT_MS, "HASH_OPEN_TIMEOUT");
  try {
    const before = await bounded(handle.stat({ bigint: true }), IO_TIMEOUT_MS, "HASH_STAT_TIMEOUT");
    invariant(before.isFile() && before.dev === pathBefore.dev && before.ino === pathBefore.ino &&
      before.size > 0n && before.size <= BigInt(maximumBytes), "HASH_FILE_INVALID");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const result = await bounded(handle.read(buffer, 0, buffer.length, null), IO_TIMEOUT_MS, "HASH_READ_TIMEOUT");
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      invariant(bytes <= maximumBytes, "HASH_SIZE_LIMIT");
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await bounded(handle.stat({ bigint: true }), IO_TIMEOUT_MS, "HASH_RESTAT_TIMEOUT");
    const pathAfter = await bounded(fs.lstat(pathname, { bigint: true }), IO_TIMEOUT_MS, "HASH_RELSTAT_TIMEOUT");
    invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mode === after.mode && before.nlink === after.nlink &&
      after.dev === pathAfter.dev && after.ino === pathAfter.ino && after.size === pathAfter.size &&
      bytes === Number(before.size), "HASH_IDENTITY_CHANGED");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await bounded(handle.close(), IO_TIMEOUT_MS, "HASH_CLOSE_TIMEOUT");
  }
}

function nativeTargetLabel() {
  if (process.platform === "darwin" && ["x64", "arm64"].includes(process.arch)) {
    return `darwin-${process.arch}`;
  }
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64-msvc";
  if (process.platform === "linux" && ["x64", "arm64"].includes(process.arch)) {
    const gnu = Boolean(process.report.getReport().header?.glibcVersionRuntime);
    return `linux-${process.arch}-${gnu ? "gnu" : "musl"}`;
  }
  throw new ProofFailure("UNSUPPORTED_HOST");
}

function expectedBackend(caseName) {
  if (extendedCase(caseName)) return extendedCase(caseName).backend;
  if (REQUIRE_CASES.has(caseName)) return "pinned-native/require";
  if (PINNED_CASES.has(caseName)) return "pinned-js/off";
  if (caseName === "native-config-drift") return "shared-js/off-to-auto";
  return "shared-js/off";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRunNumber(value) {
  return typeof value === "string" && /^[0-9]{1,20}$/u.test(value) ? value : "unavailable";
}

async function collectProvenance(repository, config) {
  const [commit, tree, dirtyOutput] = await Promise.all([
    git(repository, ["rev-parse", "HEAD"]),
    git(repository, ["rev-parse", "HEAD^{tree}"]),
    git(repository, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  invariant(/^[0-9a-f]{40}$/u.test(commit) && /^[0-9a-f]{40}$/u.test(tree), "GIT_IDENTITY_INVALID");
  invariant(commit === config.expectedCommit && commit === config.eventHead, "PROVENANCE_MISMATCH");
  invariant(dirtyOutput === "", "TRACKED_TREE_DIRTY");
  const hashes = {};
  for (const [label, relativePath] of Object.entries(HASH_BINDINGS)) {
    hashes[label] = await hashFile(repository, relativePath);
  }
  const target = nativeTargetLabel();
  hashes.nativePackageManifest = await hashFile(repository, `packages/${target}/package.json`);
  hashes.nativeAddon = await hashFile(
    repository,
    `packages/${target}/fs-safe-native.node`,
    MAX_ADDON_BYTES,
  );
  const binding = {
    checkout: {
      commit,
      dirty: false,
      expectedCommit: config.expectedCommit,
      expectedMatches: true,
      tree,
    },
    event: {
      base: config.eventBase,
      head: config.eventHead,
      headMatchesCheckout: true,
      name: config.eventName,
    },
    hashes,
    nativeTarget: target,
    run: {
      attempt: safeRunNumber(process.env.GITHUB_RUN_ATTEMPT),
      id: safeRunNumber(process.env.GITHUB_RUN_ID),
      number: safeRunNumber(process.env.GITHUB_RUN_NUMBER),
    },
  };
  return { binding, token: sha256(canonicalReceipt(binding)) };
}

async function assertProvenanceStable(repository, provenance) {
  invariant(await git(repository, ["rev-parse", "HEAD"]) === provenance.binding.checkout.commit,
    "PROVENANCE_COMMIT_CHANGED");
  invariant(await git(repository, ["rev-parse", "HEAD^{tree}"]) === provenance.binding.checkout.tree,
    "PROVENANCE_TREE_CHANGED");
  invariant(await git(repository, ["status", "--porcelain", "--untracked-files=no"]) === "",
    "PROVENANCE_DIRTY_CHANGED");
  for (const [label, relativePath] of Object.entries(HASH_BINDINGS)) {
    const current = await hashFile(repository, relativePath);
    invariant(current.sha256 === provenance.binding.hashes[label].sha256 &&
      current.bytes === provenance.binding.hashes[label].bytes, "PROVENANCE_HASH_CHANGED");
  }
  const addon = await hashFile(
    repository,
    `packages/${provenance.binding.nativeTarget}/fs-safe-native.node`,
    MAX_ADDON_BYTES,
  );
  invariant(addon.sha256 === provenance.binding.hashes.nativeAddon.sha256 &&
    addon.bytes === provenance.binding.hashes.nativeAddon.bytes, "PROVENANCE_ADDON_CHANGED");
}

function baseFinalReceipt() {
  return {
    cases: [],
    coverage: expectedCoverage(process.platform),
    failure: null,
    passed: false,
    proof: PROOF,
    provenance: null,
    runtime: {
      arch: process.arch,
      libuv: process.versions.uv,
      node: process.version,
      platform: process.platform,
      v8: process.versions.v8,
    },
    schema: SCHEMA,
    status: "failed",
  };
}

async function runCoordinator(config) {
  let stage = "build-status";
  const receipt = baseFinalReceipt();
  const repository = path.resolve(import.meta.dirname, "..");
  try {
    invariant(process.versions.node.split(".")[0] === "24", "NODE_MAJOR_MISMATCH");
    invariant(config.installResult === "success", "INSTALL_FAILED");
    invariant(config.buildResult === "success", "BUILD_FAILED");
    invariant(config.nativeResult === "success", "NATIVE_BUILD_FAILED");
    stage = "provenance";
    const provenance = await collectProvenance(repository, config);
    receipt.provenance = {
      binding: provenance.binding,
      stableAfterWorkers: false,
      token: provenance.token,
    };
    const cases = expectedCaseNames(process.platform);
    stage = "workers";
    for (const caseName of cases) {
      const run = await runBoundedProcess(process.execPath, [
        import.meta.filename,
        "--worker",
        caseName,
        expectedBackend(caseName),
        provenance.token,
        provenance.binding.hashes.nativeAddon.sha256,
        provenance.binding.nativeTarget,
      ], {
        cwd: repository,
        env: { ...process.env, FS_SAFE_NATIVE_MODE: "off", OPENCLAW_FS_SAFE_NATIVE_MODE: "off",
          ...(caseName.startsWith("pinned-policy-") ? { NODE_ENV: "test" } : {}) },
      });
      invariant(run.reaped && !run.timedOut, "WORKER_TIMEOUT");
      invariant(!run.overflow && run.spawnCode === undefined, "WORKER_TRANSPORT_FAILED");
      const worker = parseWorkerReceipt(
        run.stdout,
        caseName,
        expectedBackend(caseName),
        provenance.token,
      );
      invariant(worker !== null, "WORKER_RECEIPT_INVALID");
      receipt.cases.push(worker);
      invariant(run.exitCode === 0 && worker.passed, "WORKER_FAILED");
    }
    stage = "provenance-final";
    await assertProvenanceStable(repository, provenance);
    receipt.provenance.stableAfterWorkers = true;
    invariant(receipt.cases.length === cases.length, "CASE_COUNT_MISMATCH");
    receipt.passed = true;
    receipt.status = "passed";
  } catch (error) {
    receipt.failure = sanitizeProofFailure(error, stage);
  }
  const output = await writeReceiptAtomically(config.receiptPath, receipt);
  process.stdout.write(output);
  return receipt.passed;
}

function replaceMethod(target, key, replacement) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  invariant(descriptor !== undefined, "WRAPPER_TARGET_MISSING");
  Object.defineProperty(target, key, { ...descriptor, value: replacement });
  return () => Object.defineProperty(target, key, descriptor);
}

async function io(promise, code = "FIXTURE_IO_TIMEOUT") {
  return await bounded(promise, IO_TIMEOUT_MS, code);
}

async function expectFailure(action, expectedCode) {
  try {
    await action();
  } catch (error) {
    invariant(error?.code === expectedCode, "UNEXPECTED_ERROR_CODE");
    return error;
  }
  throw new ProofFailure("EXPECTED_FAILURE_MISSING");
}

async function missing(pathname) {
  try {
    await io(fs.lstat(pathname));
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function policy(directory, mutationSymlinks = "reject") {
  return {
    denyMutations: { prefixes: [path.join(directory, "unrelated")] },
    ...(mutationSymlinks === undefined ? {} : { mutationSymlinks }),
  };
}

export async function withFixture(caseName, body) {
  const createdDirectory = await io(
    fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-mutation-policy-proof-")),
    "FIXTURE_CREATE_TIMEOUT",
  );
  const handles = new Set();
  let directory;
  let bodyError;
  let result;
  try {
    directory = await io(fs.realpath(createdDirectory), "FIXTURE_REALPATH_TIMEOUT");
    await io(fs.chmod(directory, 0o700), "FIXTURE_CHMOD_TIMEOUT");
    const stat = await io(fs.lstat(directory, { bigint: true }), "FIXTURE_STAT_TIMEOUT");
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), "FIXTURE_NOT_PRIVATE_DIRECTORY");
    if (process.platform !== "win32") {
      invariant((stat.mode & 0o777n) === 0o700n, "FIXTURE_MODE_NOT_PRIVATE");
    }
    result = await body({
      close: async (handle) => {
        await io(handle.close(), "HANDLE_CLOSE_TIMEOUT");
        handles.delete(handle);
      },
      directory,
      track: (handle) => { handles.add(handle); return handle; },
    });
  } catch (error) {
    bodyError = error;
  } finally {
    let cleanupPassed = true;
    for (const handle of handles) cleanupPassed = await cleanup(() => handle.close()) && cleanupPassed;
    cleanupPassed = await cleanup(() => fs.rm(createdDirectory, { force: true, recursive: true })) && cleanupPassed;
    if (!cleanupPassed && bodyError === undefined) bodyError = new ProofFailure("FIXTURE_CLEANUP_FAILED");
  }
  if (bodyError !== undefined) throw bodyError;
  return { ...result, privateFixture: true };
}

async function addonLoaded(addonPath) {
  const expected = fsSync.realpathSync.native(addonPath);
  const report = process.report.getReport();
  const matches = new Set();
  for (const entry of report.sharedObjects ?? []) {
    if (!entry.endsWith(".node")) continue;
    try {
      if (fsSync.realpathSync.native(entry) === expected) matches.add(expected);
    } catch {
      // A loader entry that cannot be canonicalized is not affirmative evidence.
    }
  }
  return matches.size === 1;
}

async function allowedCase(api, kind, fixture) {
  const { directory } = fixture;
  const safe = await io(api.root(directory));
  const target = path.join(directory, "one", "two", "value");
  const options = policy(directory);
  if (kind === "mkdir") {
    await io(safe.mkdir(path.join("one", "two", "value"), options));
    invariant((await io(fs.lstat(target))).isDirectory(), "ALLOWED_MKDIR_MISSING");
    return { route: "shared-missing-parent", targetDirectory: true };
  }
  if (kind === "open") {
    const opened = await io(safe.openWritable(path.join("one", "two", "value"), {
      ...options,
      writeMode: "update",
    }));
    fixture.track(opened.handle);
    const write = await io(opened.handle.write(PAYLOAD, 0, PAYLOAD.length, 0));
    invariant(write.bytesWritten === PAYLOAD.length, "OPEN_WRITABLE_SHORT_WRITE");
    await fixture.close(opened.handle);
    invariant((await io(fs.readFile(target))).equals(PAYLOAD), "OPEN_WRITABLE_BYTES");
    return { route: "shared-missing-parent", targetBytes: PAYLOAD.length };
  }
  await io(safe.append(path.join("one", "two", "value"), PAYLOAD, {
    ...options,
    durable: false,
  }));
  invariant((await io(fs.readFile(target))).equals(PAYLOAD), "APPEND_BYTES");
  return { route: "shared-missing-parent", targetBytes: PAYLOAD.length };
}

async function postCreateCase(api, failure, forced, fixture) {
  const { directory } = fixture;
  const parent = path.join(directory, "existing");
  const target = path.join(parent, "value");
  const replacement = path.join(directory, "replacement");
  await io(fs.mkdir(parent));
  if (failure === "symlink") await io(fs.mkdir(replacement));
  const safe = await io(api.root(directory));
  const realMkdir = fs.mkdir.bind(fs);
  const realLstat = fsSync.lstatSync.bind(fsSync);
  let attempts = 0;
  let mutations = 0;
  let fault = false;
  let faults = 0;
  let authorityCalls = 0;
  const restoreMkdir = replaceMethod(fs, "mkdir", async (...args) => {
    const selected = String(args[0]) === target;
    if (selected) attempts += 1;
    const value = await realMkdir(...args);
    if (!selected) return value;
    mutations += 1;
    if (failure === "symlink") {
      await io(fs.rm(target, { recursive: true }));
      await io(fs.symlink(replacement, target, process.platform === "win32" ? "junction" : "dir"));
    } else if (failure === "file") {
      await io(fs.rm(target, { recursive: true }));
      await io(fs.writeFile(target, "replacement", "utf8"));
    } else fault = true;
    return value;
  });
  const restoreLstat = replaceMethod(fsSync, "lstatSync", (...args) => {
    if (fault && String(args[0]) === target) {
      fault = false;
      faults += 1;
      throw Object.assign(new Error("proof observation fault"), { code: "EIO" });
    }
    return realLstat(...args);
  });
  let caught;
  try {
    const action = () => safe.mkdir(path.join("existing", "value"), {
      ...policy(directory),
      ...(forced ? { assertBeforeMutation() { authorityCalls += 1; } } : {}),
    });
    if (failure === "observation" && !forced) await io(action());
    else caught = await expectFailure(action, failure === "symlink" ? "symlink" :
      failure === "file" ? "not-file" : "path-alias");
  } finally {
    restoreLstat();
    restoreMkdir();
  }
  invariant(attempts === 1 && mutations === 1, "POST_CREATE_MKDIR_COUNT");
  invariant(faults === (failure === "observation" ? 1 : 0), "POST_CREATE_FAULT_COUNT");
  invariant(!forced || authorityCalls >= 1, "FORCED_AUTHORITY_UNUSED");
  if (failure === "symlink") invariant((await io(fs.lstat(target))).isSymbolicLink(), "SYMLINK_NOT_RETAINED");
  if (failure === "file") invariant((await io(fs.readFile(target, "utf8"))) === "replacement", "FILE_NOT_RETAINED");
  if (failure === "observation") {
    invariant((await io(fs.lstat(target))).isDirectory(), "DIRECTORY_NOT_RETAINED");
    if (forced) invariant(caught?.cause?.code === "EIO", "OBSERVATION_CAUSE_NOT_RETAINED");
  }
  return {
    authorityCalls,
    faultCount: faults,
    mkdirAttempts: attempts,
    mkdirCompletions: mutations,
    route: forced ? "component-walk-authority" : "exact-parent-optimized",
  };
}

async function eexistCase(api, kind, fixture) {
  const { directory } = fixture;
  const parent = path.join(directory, "existing");
  const target = path.join(parent, "value");
  await io(fs.mkdir(parent));
  const safe = await io(api.root(directory));
  const realMkdir = fs.mkdir.bind(fs);
  let injected = false;
  let eexist = false;
  let attempts = 0;
  const restore = replaceMethod(fs, "mkdir", async (...args) => {
    if (String(args[0]) !== target) return await realMkdir(...args);
    attempts += 1;
    if (injected) return await realMkdir(...args);
    injected = true;
    if (kind === "directory") await realMkdir(target);
    else await io(fs.writeFile(target, "collision", "utf8"));
    try {
      return await realMkdir(...args);
    } catch (error) {
      if (error?.code === "EEXIST") eexist = true;
      throw error;
    }
  });
  try {
    const action = () => safe.mkdir(path.join("existing", "value"), policy(directory));
    if (kind === "directory") await io(action());
    else await expectFailure(action, "not-file");
  } finally { restore(); }
  invariant(injected && eexist && attempts === 1, "OS_EEXIST_NOT_OBSERVED");
  if (kind === "directory") invariant((await io(fs.lstat(target))).isDirectory(), "EEXIST_DIRECTORY_MISSING");
  else invariant((await io(fs.readFile(target, "utf8"))) === "collision", "EEXIST_FILE_CHANGED");
  return { collision: kind, genuineEexist: true, mkdirAttempts: attempts, route: "exact-parent-optimized" };
}

async function parentReplacementCase(api, fixture) {
  const { directory } = fixture;
  const parent = path.join(directory, "parent");
  const saved = path.join(directory, "saved");
  await io(fs.mkdir(parent));
  const safe = await io(api.root(directory));
  const realMkdir = fs.mkdir.bind(fs);
  let childMkdirs = 0;
  let swapped = false;
  const restore = replaceMethod(fs, "mkdir", async (...args) => {
    if (String(args[0]) === path.join(parent, "child")) childMkdirs += 1;
    return await realMkdir(...args);
  });
  try {
    await expectFailure(() => safe.openWritable(path.join("parent", "child", "value"), {
      ...policy(directory),
      assertBeforeMutation() {
        if (swapped) return;
        swapped = true;
        fsSync.renameSync(parent, saved);
        fsSync.mkdirSync(parent);
      },
      writeMode: "update",
    }), "path-mismatch");
  } finally { restore(); }
  invariant(swapped && childMkdirs === 0, "PARENT_REPLACEMENT_DISPATCHED");
  invariant((await io(fs.readdir(parent))).length === 0 && (await io(fs.readdir(saved))).length === 0,
    "PARENT_REPLACEMENT_MUTATED");
  return { authoritySwap: true, childMkdirSubmissions: childMkdirs, route: "component-walk-authority" };
}

async function rootReplacementCase(api, fixture) {
  const scope = path.join(fixture.directory, "scope");
  const saved = path.join(fixture.directory, "saved");
  const parent = path.join(scope, "parent");
  await io(fs.mkdir(parent, { recursive: true }));
  const safe = await io(api.root(scope));
  let swapped = false;
  try {
    await expectFailure(() => safe.openWritable(path.join("parent", "child", "value"), {
      ...policy(scope),
      assertBeforeMutation() {
        if (swapped) return;
        swapped = true;
        fsSync.renameSync(scope, saved);
        fsSync.mkdirSync(scope);
        fsSync.mkdirSync(path.join(scope, "parent"));
      },
      writeMode: "update",
    }), "path-mismatch");
    invariant(swapped, "ROOT_REPLACEMENT_NOT_TRIGGERED");
    invariant((await io(fs.readdir(path.join(scope, "parent")))).length === 0, "NEW_ROOT_MUTATED");
    invariant((await io(fs.readdir(path.join(saved, "parent")))).length === 0, "OLD_ROOT_MUTATED");
  } finally {
    if (swapped) {
      await io(fs.rm(scope, { force: true, recursive: true }), "ROOT_RESTORE_REMOVE_TIMEOUT");
      await io(fs.rename(saved, scope), "ROOT_RESTORE_RENAME_TIMEOUT");
    }
  }
  return { authoritySwap: true, originalParentEmpty: true, replacementParentEmpty: true,
    route: "component-walk-authority" };
}

async function staleMissingParentCase(api, fixture) {
  const { directory } = fixture;
  const first = path.join(directory, "one");
  const saved = path.join(directory, "saved");
  const target = path.join(first, "two", "value");
  const realMkdir = fs.mkdir.bind(fs);
  let injected = false;
  let safeMkdirs = 0;
  const restore = replaceMethod(fs, "mkdir", async (...args) => {
    const result = await realMkdir(...args);
    if (String(args[0]) === first) {
      safeMkdirs += 1;
      if (!injected) {
        injected = true;
        await io(fs.rename(first, saved));
        await realMkdir(first);
      }
    }
    return result;
  });
  try {
    const safe = await io(api.root(directory));
    const opened = await io(safe.openWritable(path.join("one", "two", "value"), {
      ...policy(directory), writeMode: "update",
    }));
    fixture.track(opened.handle);
    await fixture.close(opened.handle);
  } finally { restore(); }
  invariant(injected && safeMkdirs === 1, "STALE_STATE_NOT_INJECTED");
  invariant((await io(fs.readdir(saved))).length === 0, "STALE_PARENT_MUTATED");
  invariant((await io(fs.lstat(target))).isFile(), "CURRENT_PARENT_NOT_USED");
  return {
    currentParentUsed: true,
    staleParentUnused: true,
    route: "shared-post-create-current-selection",
  };
}

async function deniedRedirectCase(api, fixture) {
  const { directory } = fixture;
  const allowed = path.join(directory, "allowed");
  const saved = path.join(directory, "saved");
  const denied = path.join(directory, "denied");
  await io(fs.mkdir(denied));
  const realMkdir = fs.mkdir.bind(fs);
  let redirected = false;
  const restore = replaceMethod(fs, "mkdir", async (...args) => {
    const result = await realMkdir(...args);
    if (!redirected && String(args[0]) === allowed) {
      redirected = true;
      await io(fs.rename(allowed, saved));
      await io(fs.symlink(denied, allowed, process.platform === "win32" ? "junction" : "dir"));
    }
    return result;
  });
  try {
    const safe = await io(api.root(directory));
    await expectFailure(() => safe.openWritable(path.join("allowed", "child", "value"), {
      denyMutations: { prefixes: [denied] }, writeMode: "update",
    }), "denied-path");
  } finally { restore(); }
  invariant(redirected, "DENIED_REDIRECT_NOT_INJECTED");
  invariant((await io(fs.readdir(denied))).length === 0 && (await io(fs.readdir(saved))).length === 0,
    "DENIED_REDIRECT_MUTATED");
  return { deniedParentEmpty: true, displacedParentEmpty: true, rejectedCode: "denied-path",
    redirectInjected: true, route: "full-policy-refresh" };
}

async function denySpellingDriftCase(api, fixture) {
  const { directory } = fixture;
  const first = path.join(directory, "one");
  const second = path.join(first, "two");
  const denied = path.join(directory, "denyRoute");
  const realMkdir = fs.mkdir.bind(fs);
  let appeared = false;
  let secondMkdirs = 0;
  const restore = replaceMethod(fs, "mkdir", async (...args) => {
    if (String(args[0]) === second) secondMkdirs += 1;
    const result = await realMkdir(...args);
    if (!appeared && String(args[0]) === first) {
      appeared = true;
      await io(fs.symlink(first, denied, process.platform === "win32" ? "junction" : "dir"));
    }
    return result;
  });
  try {
    const safe = await io(api.root(directory));
    await expectFailure(() => safe.openWritable(path.join("one", "two", "value"), {
      denyMutations: { prefixes: [denied] }, mutationSymlinks: "reject", writeMode: "update",
    }), "denied-path");
  } finally { restore(); }
  invariant(appeared && secondMkdirs === 0, "DENY_DRIFT_DISPATCHED");
  invariant((await io(fs.readdir(first))).length === 0, "DENY_DRIFT_MUTATED");
  return { denySpellingAppeared: true, nextComponentMkdirSubmissions: secondMkdirs, route: "shared-policy-refresh" };
}

async function configDriftCase(api, fixture) {
  const { directory } = fixture;
  const first = path.join(directory, "one");
  const target = path.join(first, "two", "value");
  const realMkdir = fs.mkdir.bind(fs);
  let changed = false;
  let mkdirs = 0;
  const restore = replaceMethod(fs, "mkdir", async (...args) => {
    const result = await realMkdir(...args);
    if (String(args[0]).startsWith(directory)) mkdirs += 1;
    if (!changed && String(args[0]) === first) {
      changed = true;
      api.configureFsSafeNative({ mode: "auto" });
    }
    return result;
  });
  try {
    const safe = await io(api.root(directory));
    const opened = await io(safe.openWritable(path.join("one", "two", "value"), {
      ...policy(directory), writeMode: "update",
    }));
    fixture.track(opened.handle);
    await fixture.close(opened.handle);
  } finally { restore(); }
  invariant(changed && api.getFsSafeNativeConfig().mode === "auto", "CONFIG_DRIFT_NOT_LIVE");
  invariant(mkdirs >= 2 && (await io(fs.lstat(target))).isFile(), "CONFIG_DRIFT_OUTPUT");
  return { configChanged: true, modeAfter: "auto", route: "shared-refresh", safeMkdirs: mkdirs };
}

async function selectedDestinationCase(api, retarget, fixture) {
  const { directory } = fixture;
  const selected = path.join(directory, "selected");
  const other = path.join(directory, "other");
  const alias = path.join(directory, "alias");
  await io(fs.writeFile(selected, "selected", "utf8"));
  await io(fs.writeFile(other, "other", "utf8"));
  await io(fs.symlink(selected, alias, "file"));
  const realOpen = fs.open.bind(fs);
  const openedHandles = [];
  let callbacks = 0;
  const restore = replaceMethod(fs, "open", async (...args) => {
    const handle = await realOpen(...args);
    openedHandles.push(handle);
    return handle;
  });
  try {
    const safe = await io(api.root(directory));
    const options = {
      denyMutations: { prefixes: [path.join(directory, "unrelated")] },
      writeMode: "replace",
      ...(retarget ? { assertBeforeMutation() {
        callbacks += 1;
        if (callbacks === 1) {
          fsSync.unlinkSync(alias);
          fsSync.symlinkSync(other, alias, "file");
        }
      } } : {}),
    };
    if (retarget) {
      await expectFailure(() => safe.openWritable("alias", options), "path-mismatch");
    } else {
      const opened = await io(safe.openWritable("alias", options));
      fixture.track(opened.handle);
      await fixture.close(opened.handle);
    }
  } finally { restore(); }
  invariant(openedHandles.length > 0 && openedHandles.every((handle) => handle.fd === -1),
    "SELECTED_HANDLE_NOT_CLOSED");
  invariant((await io(fs.lstat(alias))).isSymbolicLink(), "SELECTED_ALIAS_LOST");
  invariant((await io(fs.readFile(other, "utf8"))) === "other", "RETARGET_BYTES_CHANGED");
  invariant((await io(fs.readFile(selected, "utf8"))) === (retarget ? "selected" : ""),
    "SELECTED_BYTES_UNEXPECTED");
  invariant(!retarget || callbacks === 1, "RETARGET_CALLBACK_COUNT");
  return {
    authorityCallbacks: callbacks,
    handlesClosed: true,
    route: retarget ? "followed-final-authority-fence" : "followed-final-stable",
  };
}

async function authorityCase(api, midWalk, fixture) {
  const { directory } = fixture;
  const revoked = new Error("proof authority revoked");
  let calls = 0;
  let firstMkdirs = 0;
  let secondMkdirs = 0;
  const first = path.join(directory, "one");
  const second = path.join(first, "two");
  const realMkdir = fs.mkdir.bind(fs);
  const restore = replaceMethod(fs, "mkdir", async (...args) => {
    if (String(args[0]) === first) firstMkdirs += 1;
    if (String(args[0]) === second) secondMkdirs += 1;
    return await realMkdir(...args);
  });
  let caught;
  try {
    const safe = await io(api.root(directory));
    try {
      await safe.openWritable(path.join("one", "two", "value"), {
        ...policy(directory),
        assertBeforeMutation() {
          calls += 1;
          if (!midWalk || calls === 2) throw revoked;
        },
        writeMode: "update",
      });
    } catch (error) { caught = error; }
  } finally { restore(); }
  invariant(caught === revoked, "AUTHORITY_REASON_CHANGED");
  if (midWalk) {
    invariant(calls === 2 && firstMkdirs === 1 && secondMkdirs === 0, "MID_WALK_AUTHORITY_ORDER");
    invariant((await io(fs.readdir(first))).length === 0, "MID_WALK_MUTATED_AFTER_REFUSAL");
  } else {
    invariant(calls === 1 && firstMkdirs === 0 && await missing(first), "IMMEDIATE_AUTHORITY_ORDER");
  }
  return {
    authorityCalls: calls,
    firstMkdirs,
    route: "component-walk-authority",
    secondMkdirs,
  };
}

async function pinnedCase(api, operation, fixture) {
  const { directory } = fixture;
  const safe = await io(api.root(directory));
  const relative = path.join("one", "two", "value");
  const target = path.join(directory, relative);
  const options = { ...policy(directory), durable: false };
  if (operation === "write") await io(safe.write(relative, PAYLOAD, options));
  else if (operation === "create") await io(safe.create(relative, PAYLOAD, options));
  else {
    const source = path.join(directory, "source");
    await io(fs.writeFile(source, PAYLOAD, { mode: 0o600 }));
    await io(safe.copyIn(relative, source, { ...options, clone: "never" }));
    invariant((await io(fs.readFile(source))).equals(PAYLOAD), "COPY_SOURCE_CHANGED");
  }
  invariant((await io(fs.readFile(target))).equals(PAYLOAD), "PINNED_OUTPUT_BYTES");
  return {
    operation,
    route: operation === "copy" ? "pinned-file-copy" : "pinned-buffer-write",
    targetBytes: PAYLOAD.length,
  };
}

async function executeWorkerCase(caseName, api, fixture) {
  const extension = extendedCase(caseName);
  if (extension) return await executeExtendedCase(extension, api, fixture, {
    io, invariant, expectFailure, PAYLOAD,
  });
  if (caseName === "allowed-mkdir") return await allowedCase(api, "mkdir", fixture);
  if (caseName === "allowed-open-writable") return await allowedCase(api, "open", fixture);
  if (caseName === "allowed-append") return await allowedCase(api, "append", fixture);
  if (caseName.startsWith("post-create-")) {
    const failure = caseName.includes("symlink") ? "symlink" :
      caseName.includes("file") ? "file" : "observation";
    return await postCreateCase(api, failure, caseName.endsWith("forced"), fixture);
  }
  if (caseName === "os-eexist-directory") return await eexistCase(api, "directory", fixture);
  if (caseName === "os-eexist-file") return await eexistCase(api, "file", fixture);
  if (caseName === "parent-replacement-authority-fence") return await parentReplacementCase(api, fixture);
  if (caseName === "root-replacement-authority-fence") return await rootReplacementCase(api, fixture);
  if (caseName === "stale-missing-parent-recapture") return await staleMissingParentCase(api, fixture);
  if (caseName === "denied-parent-redirect") return await deniedRedirectCase(api, fixture);
  if (caseName === "deny-spelling-drift") return await denySpellingDriftCase(api, fixture);
  if (caseName === "native-config-drift") return await configDriftCase(api, fixture);
  if (caseName === "selected-destination-stable") return await selectedDestinationCase(api, false, fixture);
  if (caseName === "selected-destination-retarget") return await selectedDestinationCase(api, true, fixture);
  if (caseName === "authority-refusal-immediate") return await authorityCase(api, false, fixture);
  if (caseName === "authority-refusal-mid-walk") return await authorityCase(api, true, fixture);
  if (caseName.startsWith("pinned-write-")) return await pinnedCase(api, "write", fixture);
  if (caseName.startsWith("pinned-create-")) return await pinnedCase(api, "create", fixture);
  if (caseName.startsWith("pinned-copy-in-")) return await pinnedCase(api, "copy", fixture);
  throw new ProofFailure("UNKNOWN_CASE");
}

async function runWorker(argv) {
  const [caseName, backend, provenance, addonSha256, target] = argv;
  const receipt = {
    backend: backend ?? "unresolved",
    case: caseName ?? "unknown",
    complete: false,
    failure: null,
    observations: {},
    passed: false,
    provenance: provenance ?? "missing",
    schema: WORKER_SCHEMA,
  };
  let stage = "arguments";
  let unhandled;
  const onUnhandled = (reason) => { unhandled ??= reason; };
  process.on("unhandledRejection", onUnhandled);
  try {
    invariant(argv.length === 5 && ALL_CASES.includes(caseName), "INVALID_WORKER_ARGUMENTS");
    invariant(backend === expectedBackend(caseName), "WORKER_BACKEND_ARGUMENT");
    invariant(/^[0-9a-f]{64}$/u.test(provenance) && /^[0-9a-f]{64}$/u.test(addonSha256),
      "WORKER_PROVENANCE_ARGUMENT");
    invariant(target === nativeTargetLabel(), "WORKER_NATIVE_TARGET");
    invariant(process.versions.node.split(".")[0] === "24", "NODE_MAJOR_MISMATCH");
    if (process.platform !== "win32") {
      invariant(process.getuid() !== 0 && process.geteuid() !== 0, "WORKER_PRIVILEGED");
    }
    if (POSIX_ONLY_CASES.has(caseName)) invariant(process.platform !== "win32", "CASE_PLATFORM_MISMATCH");
    invariant(expectedCaseNames(process.platform).includes(caseName), "CASE_PLATFORM_MISMATCH");
    const addonPath = path.resolve(`packages/${target}/fs-safe-native.node`);
    const addon = await hashFile(process.cwd(), path.relative(process.cwd(), addonPath), MAX_ADDON_BYTES);
    invariant(addon.sha256 === addonSha256, "WORKER_ADDON_HASH_MISMATCH");
    stage = "public-import";
    const resolved = import.meta.resolve("@openclaw/fs-safe");
    invariant(resolved.endsWith("/dist/index.js"), "PUBLIC_IMPORT_NOT_BUILT");
    const api = await import("@openclaw/fs-safe");
    invariant(typeof api.root === "function" && typeof api.configureFsSafeNative === "function" &&
      typeof api.getFsSafeNativeConfig === "function", "PUBLIC_EXPORTS_MISSING");
    const mode = backend.endsWith("/require") ? "require" : "off";
    api.configureFsSafeNative({ mode });
    invariant(api.getFsSafeNativeConfig().mode === mode, "NATIVE_MODE_NOT_SELECTED");
    const loadedBefore = await addonLoaded(addonPath);
    invariant(!loadedBefore, "ADDON_LOADED_BEFORE_CASE");
    stage = "behavior";
    const observations = await withFixture(caseName, async (fixture) =>
      await executeWorkerCase(caseName, api, fixture));
    const loadedAfter = await addonLoaded(addonPath);
    // Windows compatibility payload writes stay in JS; the retained sidecar
    // lock is published through Root.create and uses native mode when required.
    const requiresAddon = backend === "pinned-native/require" || backend === "windows-js/require";
    invariant(loadedAfter === requiresAddon,
      requiresAddon ? "REQUIRED_ADDON_NOT_LOADED" : "UNEXPECTED_ADDON_LOADED");
    await new Promise((resolve) => setImmediate(resolve));
    invariant(unhandled === undefined, "UNHANDLED_REJECTION");
    receipt.observations = {
      ...observations,
      addonLoaded: loadedAfter,
      builtPublicImport: true,
      node24: true,
      privilegeModel: process.platform === "win32" ? "no-elevation-requested" : "posix-nonroot",
    };
    invariant(safeObservation(receipt.observations), "OBSERVATION_SCHEMA_INVALID");
    receipt.complete = true;
    receipt.passed = true;
  } catch (error) {
    receipt.failure = sanitizeProofFailure(error, stage);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  const output = canonicalReceipt(receipt);
  if (Buffer.byteLength(output) <= WORKER_MAX_BYTES) process.stdout.write(output);
  return receipt.passed;
}

async function ensureReceipt(receiptPath) {
  try {
    const text = await bounded(fs.readFile(receiptPath, "utf8"), IO_TIMEOUT_MS, "RECEIPT_READ_TIMEOUT");
    if (validateFinalReceiptText(text) !== null) return true;
  } catch {
    // Replace any missing or malformed receipt with a finite sanitized failure.
  }
  const fallback = pendingReceipt("RECEIPT_INVALID", "workflow-fallback");
  fallback.status = "failed";
  await writeReceiptAtomically(receiptPath, fallback);
  return false;
}

async function main(argv) {
  if (argv[0] === "--worker") return await runWorker(argv.slice(1));
  let config;
  try { config = parseArguments(argv); } catch { return false; }
  if (config.mode === "initialize") {
    await writeReceiptAtomically(config.receiptPath, pendingReceipt());
    return true;
  }
  if (config.mode === "ensure") return await ensureReceipt(config.receiptPath);
  // This replacement precedes Git, source, build-artifact, and fixture inspection.
  await writeReceiptAtomically(config.receiptPath, pendingReceipt());
  return await runCoordinator(config);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  let passed = false;
  try { passed = await main(process.argv.slice(2)); } catch { passed = false; }
  if (!passed) process.exitCode = 1;
}
