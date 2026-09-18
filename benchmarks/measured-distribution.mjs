import assert from "node:assert/strict";
import {
  expectedWorkloadSemantics,
  validateFilenameFallbackProfile,
} from "./filename-fallback-profile.mjs";
import { validateDirectoryModeOwnerWorkloadResult } from "./directory-mode-owner.mjs";
import { validateTempWorkspaceWorkloadResult } from "./temp-workspace-fixtures.mjs";
import {
  validateSidecarPathSnapshotReport,
  validateSidecarPathSnapshotWorkloadResult,
} from "./sidecar-path-snapshot.mjs";
import {
  validateSyncCopyFallbackAdmissionReport,
  validateSyncCopyFallbackAdmissionWorkloadResult,
} from "./sync-copy-fallback-admission.mjs";
import { validateGuestBenchmarkReport } from "./guest.mjs";
import {
  validateCopyFallbackSuccessReport,
  validateCopyFallbackSuccessWorkloadResult,
} from "./copy-fallback-success.mjs";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BUILD_ID = /^[a-z][a-z0-9-]{0,63}$/u;
export const SAMPLE_SEMANTICS = "Each samplesUs value is an average microseconds per call over result.iterations.";
const ARGUMENT_FIELDS = Object.freeze([
  ["measured-build-id", "buildId"],
  ["measured-source-role", "sourceRole"],
  ["measured-source-commit", "sourceCommit"],
  ["measured-source-tree", "sourceTree"],
  ["filename-source-blob", "filenameSourceBlob"],
  ["filename-source-hash", "filenameSourceHash"],
  ["expected-filename-fallback-profile", "expectedFilenameFallbackProfile"],
]);

function validateBinding(binding) {
  assert(binding && typeof binding === "object", "measured source binding is required");
  assert.match(binding.buildId, BUILD_ID, "invalid measured build ID");
  assert(["candidate", "baseline"].includes(binding.sourceRole), "invalid measured source role");
  assert.match(binding.sourceCommit, SHA1, "invalid measured source commit");
  assert.match(binding.sourceTree, SHA1, "invalid measured source tree");
  assert.match(binding.filenameSourceBlob, SHA1, "invalid filename source blob");
  assert.match(binding.filenameSourceHash, SHA256, "invalid filename source hash");
  validateFilenameFallbackProfile(binding.expectedFilenameFallbackProfile, "planned filename fallback profile");
  return binding;
}

export function measuredSourceBinding(plan, reportPlan) {
  const build = plan.builds.find(({ id }) => id === reportPlan.buildId);
  assert(build, `missing build ${reportPlan.buildId}`);
  const source = plan.sources[build.sourceRole];
  assert(source, `missing ${build.sourceRole} source for ${reportPlan.file}`);
  return validateBinding({
    buildId: build.id,
    sourceRole: build.sourceRole,
    sourceCommit: source.commit,
    sourceTree: source.tree,
    filenameSourceBlob: source.filenameSourceBlob,
    filenameSourceHash: source.filenameSourceHash,
    expectedFilenameFallbackProfile: source.filenameFallbackProfile,
  });
}

export function measuredSourceArguments(binding) {
  const normalized = validateBinding(binding);
  return ARGUMENT_FIELDS.flatMap(([option, property]) => [`--${option}`, normalized[property]]);
}

export function parseMeasuredSourceArguments(args) {
  const present = ARGUMENT_FIELDS.filter(([option]) => args[option] !== undefined);
  if (present.length === 0) return null;
  assert.equal(present.length, ARGUMENT_FIELDS.length, "measured source arguments must be supplied together");
  return validateBinding(Object.fromEntries(ARGUMENT_FIELDS.map(([option, property]) => [property, args[option]])));
}

export function measuredDistributionMetadata(binding, observedProfile, distHash) {
  const observed = validateFilenameFallbackProfile(observedProfile, "observed filename fallback profile");
  assert.match(distHash, SHA256, "invalid measured distribution hash");
  if (!binding) {
    return {
      binding: "standalone",
      distHash,
      expectedFilenameFallbackProfile: null,
      observedFilenameFallbackProfile: observed,
    };
  }
  const normalized = validateBinding(binding);
  assert.equal(
    observed,
    normalized.expectedFilenameFallbackProfile,
    "Observed filename fallback profile does not match the planned source profile",
  );
  return {
    binding: "method-audit-plan-v1",
    ...normalized,
    distHash,
    observedFilenameFallbackProfile: observed,
  };
}

export function validateMeasuredResult(result, expectedSamples, context = "benchmark result") {
  assert(result && typeof result === "object", `${context} is missing`);
  assert.equal(typeof result.name, "string", `${context} name is invalid`);
  assert(result.name.length > 0, `${context} name is empty`);
  if (result.skipped !== undefined) {
    assert.equal(typeof result.skipped, "string", `${context} skip reason is invalid`);
    assert(result.skipped.length > 0, `${context} skip reason is empty`);
    return;
  }

  assert(Number.isSafeInteger(result.iterations) && result.iterations > 0,
    `${context} iterations are invalid`);
  assert(Array.isArray(result.samplesUs) && result.samplesUs.length === expectedSamples,
    `${context} sample set is incomplete`);
  assert(result.samplesUs.every((sample) => Number.isFinite(sample) && sample >= 0),
    `${context} sample set contains an invalid duration`);
  const sorted = [...result.samplesUs].sort((a, b) => a - b);
  const median = (sorted[Math.floor((sorted.length - 1) / 2)] +
    sorted[Math.floor(sorted.length / 2)]) / 2;
  assert.equal(result.minUs, sorted[0], `${context} minimum does not match its samples`);
  assert.equal(result.maxUs, sorted.at(-1), `${context} maximum does not match its samples`);
  assert.equal(result.medianUs, median, `${context} median does not match its samples`);
}

export function validateMeasuredDistribution(plan, reportPlan, report, expectedDistHash) {
  validateGuestBenchmarkReport(report, plan.settings.filter);
  const expected = measuredSourceBinding(plan, reportPlan);
  const actual = report.metadata?.measuredDistribution;
  assert(actual && actual.binding === "method-audit-plan-v1", `${reportPlan.file} lacks a plan-bound distribution identity`);
  for (const [property, value] of Object.entries(expected)) {
    assert.equal(actual[property], value, `${reportPlan.file} measured ${property} mismatch`);
  }
  assert.equal(actual.distHash, expectedDistHash, `${reportPlan.file} measured dist hash mismatch`);
  assert.equal(report.metadata?.distHash, expectedDistHash, `${reportPlan.file} distribution hash mismatch`);
  assert.equal(report.metadata?.sampleSemantics, SAMPLE_SEMANTICS,
    `${reportPlan.file} sample semantics mismatch`);
  assert.equal(
    actual.observedFilenameFallbackProfile,
    expected.expectedFilenameFallbackProfile,
    `${reportPlan.file} filename fallback profile mismatch`,
  );
  const results = report.results ?? [];
  const names = results.map(({ name }) => name);
  assert.equal(new Set(names).size, names.length, `${reportPlan.file} contains duplicate result names`);
  for (const result of results) {
    validateMeasuredResult(result, plan.settings.samples, `${reportPlan.file} result ${result.name ?? "<unnamed>"}`);
    if (plan.settings.filter) {
      assert(result.name.includes(plan.settings.filter),
        `${reportPlan.file} contains a result outside its filter: ${result.name}`);
    }
    const semantics = expectedWorkloadSemantics(result.name);
    if (semantics !== undefined) {
      assert.equal(result.workloadSemantics, semantics, `${reportPlan.file} workload semantics mismatch for ${result.name}`);
    }
    validateDirectoryModeOwnerWorkloadResult(result);
    validateTempWorkspaceWorkloadResult(result);
    validateSidecarPathSnapshotWorkloadResult(result);
    validateCopyFallbackSuccessWorkloadResult(result);
    validateSyncCopyFallbackAdmissionWorkloadResult(result);
  }
  validateSidecarPathSnapshotReport(report, plan.settings.filter, plan.settings.iterations);
  validateCopyFallbackSuccessReport(report, plan.settings.filter, plan.settings.iterations);
  validateSyncCopyFallbackAdmissionReport(report, plan.settings.filter, plan.settings.iterations);
}

export const MEASURED_SOURCE_ARGUMENT_NAMES = Object.freeze(
  ARGUMENT_FIELDS.map(([option]) => option),
);
