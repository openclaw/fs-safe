import assert from "node:assert/strict";
import {
  expectedWorkloadSemantics,
  validateFilenameFallbackProfile,
} from "./filename-fallback-profile.mjs";
import { validateTempWorkspaceWorkloadResult } from "./temp-workspace-fixtures.mjs";

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

export function validateMeasuredDistribution(plan, reportPlan, report, expectedDistHash) {
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
  for (const result of report.results ?? []) {
    const semantics = expectedWorkloadSemantics(result.name);
    if (semantics !== undefined) {
      assert.equal(result.workloadSemantics, semantics, `${reportPlan.file} workload semantics mismatch for ${result.name}`);
    }
    validateTempWorkspaceWorkloadResult(result);
  }
}

export const MEASURED_SOURCE_ARGUMENT_NAMES = Object.freeze(
  ARGUMENT_FIELDS.map(([option]) => option),
);
