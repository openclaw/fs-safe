import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  createPathPrefixFixtureCohort,
  validatePathPrefixFixtureReceipt,
} from "./path-prefix-campaign-fixture.mjs";

const CAMPAIGN_ID = "resolve-path-prefix-cursor-v1";
const FULL_CAMPAIGN_FILTERS = new Set(["resolvePathPrefixSync", "resolvePathPrefixSync/"]);
const SHIFT_QUEUE_COMPONENT_LIMIT = 32;
const SHORT_ITERATIONS = 10_000;
const DEEP_ITERATIONS = 2_000;

const DEFINITIONS = Object.freeze([
  ["existing", "short", "existing", null],
  ["missing", "short", "missing", null],
  ["queue-boundary-32", "short", "separator-only-queue-boundary", null],
  ["queue-boundary-33", "short", "separator-only-queue-boundary", null],
  ["separator-heavy", "short", "separator-heavy", null],
  ["populated-existing-depth-32", "deep-or-symlink", "populated-existing", null],
  ["populated-existing-depth-33", "deep-or-symlink", "populated-existing", null],
  ["symlink-small-to-small", "deep-or-symlink", "symlink-expansion", "small-to-small"],
  ["symlink-small-to-large", "deep-or-symlink", "symlink-expansion", "small-to-large"],
  ["symlink-large-to-small", "deep-or-symlink", "symlink-expansion", "large-to-small"],
  ["symlink-large-to-large", "deep-or-symlink", "symlink-expansion", "large-to-large"],
].map(([suffix, iterationClass, shape, queueTransition]) => {
  const effectiveIterations = iterationClass === "short" ? SHORT_ITERATIONS : DEEP_ITERATIONS;
  return Object.freeze({
    name: `resolvePathPrefixSync/${suffix}`,
    effectiveIterations,
    queueTransition,
    workloadSemantics: "equivalent-output",
    workloadDetails: Object.freeze({
      campaign: CAMPAIGN_ID,
      shape,
      queueTransition,
      iterationClass,
      effectiveIterations,
      timedOperation: "resolvePathPrefixSync",
      warmup: "one untimed full effective-iteration batch per runner process",
      verification: "every complete result after its batch timer",
    }),
  });
}));

export const PATH_PREFIX_CAMPAIGN_ROWS = DEFINITIONS;
export const PATH_PREFIX_CAMPAIGN_NAMES = Object.freeze(DEFINITIONS.map(({ name }) => name));

export function pathPrefixCampaignMetadata(filter) {
  if (!FULL_CAMPAIGN_FILTERS.has(filter)) return null;
  return Object.freeze({
    schemaVersion: 1,
    campaign: CAMPAIGN_ID,
    filter,
    rows: PATH_PREFIX_CAMPAIGN_NAMES,
    queueComponentLimit: SHIFT_QUEUE_COMPONENT_LIMIT,
    fixtureReceiptSchema: "path-prefix-fixture-v1",
    warmupBatchesPerRow: 1,
    warmupUnit: "full effective-iteration batch",
    resultVerification: "every complete warmup and timed result after its batch timer",
    effectiveIterations: Object.freeze({ short: SHORT_ITERATIONS, deepOrSymlink: DEEP_ITERATIONS }),
  });
}

function expectedReceipt(definition, sampleCount, samplesUs, fixtureReceipt) {
  const { effectiveIterations } = definition;
  return {
    schemaVersion: 1,
    campaign: CAMPAIGN_ID,
    effectiveIterations,
    fixtureReceipt,
    fixtureObservations: { before: fixtureReceipt, after: fixtureReceipt },
    warmupBatches: 1,
    warmupBatchIds: ["warmup-1"],
    warmupInvocations: effectiveIterations,
    warmupVerifiedResults: effectiveIterations,
    warmupInvocationCounts: [effectiveIterations],
    warmupVerifiedResultCounts: [effectiveIterations],
    timedBatches: sampleCount,
    timedBatchIds: Array.from({ length: sampleCount }, (_, index) => `timed-${index + 1}`),
    timedInvocations: effectiveIterations * sampleCount,
    timedVerifiedResults: effectiveIterations * sampleCount,
    timedInvocationCounts: Array(sampleCount).fill(effectiveIterations),
    timedVerifiedResultCounts: Array(sampleCount).fill(effectiveIterations),
    sampleDurationsUs: [...samplesUs],
  };
}

function observeFixture(benchmarkCase, phase) {
  assert(benchmarkCase.pathPrefixFixtureReceipt,
    `${benchmarkCase.name} is missing its bound fixture receipt`);
  assert.equal(typeof benchmarkCase.inspectPathPrefixFixture, "function",
    `${benchmarkCase.name} is missing live fixture inspection`);
  const observed = benchmarkCase.inspectPathPrefixFixture(phase);
  assert.deepEqual(observed, benchmarkCase.pathPrefixFixtureReceipt,
    `${benchmarkCase.name} fixture changed ${phase} measurement`);
  return observed;
}

function finishFixtureInspection(benchmarkCase, failure) {
  try {
    return { observed: observeFixture(benchmarkCase, "after"), failure };
  } catch (inspectionFailure) {
    if (failure) {
      return {
        observed: undefined,
        failure: new AggregateError(
          [failure, inspectionFailure],
          `${benchmarkCase.name} measurement and final fixture inspection failed`,
        ),
      };
    }
    return { observed: undefined, failure: inspectionFailure };
  }
}

export function measurePathPrefixCampaignCase(benchmarkCase, sampleCount, now = () => performance.now()) {
  const definition = DEFINITIONS.find(({ name }) => name === benchmarkCase.name);
  assert(definition, `Unknown path-prefix campaign row: ${benchmarkCase.name}`);
  assert.equal(benchmarkCase.sync, true, `${benchmarkCase.name} must remain synchronous`);
  assert.equal(benchmarkCase.before, undefined, `${benchmarkCase.name} must keep setup outside timing`);
  assert.equal(benchmarkCase.after, undefined, `${benchmarkCase.name} must keep cleanup outside timing`);
  assert.equal(benchmarkCase.expectError, undefined, `${benchmarkCase.name} must measure successful resolution`);
  assert.equal(typeof benchmarkCase.verify, "function", `${benchmarkCase.name} needs complete result verification`);
  assert(Number.isSafeInteger(sampleCount) && sampleCount > 0,
    "path-prefix campaign sample count is invalid");
  const fixtureBefore = observeFixture(benchmarkCase, "before");

  const runBatch = (phase, batchId) => {
    const outputs = new Array(definition.effectiveIterations);
    let actualInvocations = 0;
    const start = now({ phase, batchId, edge: "start" });
    assert(Number.isFinite(start), `${benchmarkCase.name} ${batchId} start time is invalid`);
    for (; actualInvocations < definition.effectiveIterations; actualInvocations += 1) {
      outputs[actualInvocations] = benchmarkCase.run();
    }
    const end = now({ phase, batchId, edge: "end" });
    assert(Number.isFinite(end) && end >= start,
      `${benchmarkCase.name} ${batchId} elapsed time is invalid`);
    let verifiedResults = 0;
    for (; verifiedResults < actualInvocations; verifiedResults += 1) {
      benchmarkCase.verify(outputs[verifiedResults]);
    }
    assert.equal(actualInvocations, definition.effectiveIterations,
      `${benchmarkCase.name} invocation count mismatch`);
    assert.equal(verifiedResults, actualInvocations,
      `${benchmarkCase.name} did not verify every returned result`);
    return { elapsed: end - start, actualInvocations, verifiedResults };
  };

  let warmup;
  const samplesUs = [];
  const timedInvocationCounts = [];
  const timedVerifiedResultCounts = [];
  let timedInvocations = 0;
  let timedVerifiedResults = 0;
  let failure;
  try {
    warmup = runBatch("warmup", "warmup-1");
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const measured = runBatch("timed", `timed-${sample + 1}`);
      timedInvocations += measured.actualInvocations;
      timedVerifiedResults += measured.verifiedResults;
      timedInvocationCounts.push(measured.actualInvocations);
      timedVerifiedResultCounts.push(measured.verifiedResults);
      samplesUs.push(measured.elapsed * 1000 / definition.effectiveIterations);
    }
  } catch (error) {
    failure = error;
  }
  const finished = finishFixtureInspection(benchmarkCase, failure);
  if (finished.failure) throw finished.failure;
  const receipt = {
    schemaVersion: 1,
    campaign: CAMPAIGN_ID,
    effectiveIterations: definition.effectiveIterations,
    fixtureReceipt: benchmarkCase.pathPrefixFixtureReceipt,
    fixtureObservations: { before: fixtureBefore, after: finished.observed },
    warmupBatches: 1,
    warmupBatchIds: ["warmup-1"],
    warmupInvocations: warmup.actualInvocations,
    warmupVerifiedResults: warmup.verifiedResults,
    warmupInvocationCounts: [warmup.actualInvocations],
    warmupVerifiedResultCounts: [warmup.verifiedResults],
    timedBatches: samplesUs.length,
    timedBatchIds: Array.from({ length: samplesUs.length }, (_, index) => `timed-${index + 1}`),
    timedInvocations,
    timedVerifiedResults,
    timedInvocationCounts,
    timedVerifiedResultCounts,
    sampleDurationsUs: [...samplesUs],
  };
  assert.deepEqual(
    receipt,
    expectedReceipt(definition, sampleCount, samplesUs, benchmarkCase.pathPrefixFixtureReceipt),
    `${benchmarkCase.name} execution receipt mismatch`,
  );
  return { iterations: definition.effectiveIterations, samplesUs, receipt };
}

function expectedWorkloadDetails(definition, fixtureReceipt) {
  return { ...definition.workloadDetails, fixtureReceipt };
}

export function validatePathPrefixCampaignWorkloadResult(result) {
  if (typeof result?.name !== "string" || !result.name.startsWith("resolvePathPrefixSync/")) return;
  if (result.pathPrefixCampaignReceipt === undefined) return;
  const definition = DEFINITIONS.find(({ name }) => name === result.name);
  assert(definition, `Unknown path-prefix campaign row: ${result.name}`);
  const fixtureReceipt = validatePathPrefixFixtureReceipt(
    result.pathPrefixFixtureReceipt,
    definition,
    result.pathPrefixFixtureReceipt?.platform,
    SHIFT_QUEUE_COMPONENT_LIMIT,
  );
  assert.equal(result.workloadSemantics, definition.workloadSemantics,
    `path-prefix campaign workload semantics mismatch for ${result.name}`);
  assert.deepEqual(result.workloadDetails, expectedWorkloadDetails(definition, fixtureReceipt),
    `path-prefix campaign workload details mismatch for ${result.name}`);
  assert.equal(result.iterations, definition.effectiveIterations,
    `path-prefix campaign effective iteration mismatch for ${result.name}`);
  assert.deepEqual(
    result.pathPrefixCampaignReceipt,
    expectedReceipt(definition, result.samplesUs?.length, result.samplesUs, fixtureReceipt),
    `path-prefix campaign execution receipt mismatch for ${result.name}`,
  );
}

function rejectUnexpectedCampaignEvidence(report) {
  assert.equal(report.metadata?.pathPrefixCampaign, undefined,
    "generic report contains unexpected path-prefix campaign metadata");
  for (const result of report.results ?? []) {
    assert.equal(result.pathPrefixCampaignReceipt, undefined,
      `generic report contains an unexpected campaign receipt: ${result.name}`);
    assert.equal(result.pathPrefixFixtureReceipt, undefined,
      `generic report contains an unexpected fixture receipt: ${result.name}`);
  }
}

export function validatePathPrefixCampaignReport(report, filter = "") {
  const expectedMetadata = pathPrefixCampaignMetadata(filter);
  if (!expectedMetadata) {
    rejectUnexpectedCampaignEvidence(report);
    return;
  }
  const actualMetadata = report.metadata?.pathPrefixCampaign;
  assert(actualMetadata && typeof actualMetadata === "object",
    "path-prefix campaign metadata is missing");
  const { fixtureReceipts, ...actualStaticMetadata } = actualMetadata;
  assert.deepEqual(actualStaticMetadata, expectedMetadata,
    "path-prefix campaign metadata mismatch");
  assert(["linux", "darwin", "win32"].includes(report.metadata?.platform),
    "path-prefix campaign report platform is unsupported");
  assert(Number.isSafeInteger(report.metadata?.samples) && report.metadata.samples > 0,
    "path-prefix campaign sample count is invalid");
  assert(Array.isArray(fixtureReceipts), "path-prefix campaign fixture receipts are missing");
  assert.deepEqual(fixtureReceipts.map(({ row }) => row), expectedMetadata.rows,
    "path-prefix campaign fixture row set mismatch");
  const fixtureByName = new Map();
  for (const receipt of fixtureReceipts) {
    const definition = DEFINITIONS.find(({ name }) => name === receipt.row);
    assert(definition, `Unknown path-prefix fixture row: ${receipt.row}`);
    validatePathPrefixFixtureReceipt(
      receipt,
      definition,
      report.metadata.platform,
      SHIFT_QUEUE_COMPONENT_LIMIT,
    );
    fixtureByName.set(receipt.row, receipt);
  }
  for (const receipt of fixtureReceipts.slice(1)) {
    assert.deepEqual(receipt.workspace, fixtureReceipts[0].workspace,
      "path-prefix campaign workspace receipt changed across rows");
  }

  const results = (report.results ?? [])
    .filter(({ name }) => name.startsWith("resolvePathPrefixSync/"));
  assert.deepEqual(results.map(({ name }) => name), expectedMetadata.rows,
    "path-prefix campaign report row set mismatch");
  for (const result of results) {
    assert.equal(result.skipped, undefined,
      `path-prefix campaign row was not measured on ${report.metadata.platform}: ${result.name}`);
    assert.deepEqual(result.pathPrefixFixtureReceipt, fixtureByName.get(result.name),
      `path-prefix campaign result fixture mismatch: ${result.name}`);
    assert(result.pathPrefixCampaignReceipt,
      `path-prefix campaign row lacks an execution receipt: ${result.name}`);
    assert.equal(result.samplesUs?.length, report.metadata.samples,
      `path-prefix campaign timed sample count mismatch: ${result.name}`);
    validatePathPrefixCampaignWorkloadResult(result);
  }
}

function registerGenericRows({ resolve, workspace, register, unavailable }) {
  const complete = (input, existingPath, unresolvedSegments = []) => ({
    absolutePath: input,
    existingPath: fs.realpathSync.native(existingPath),
    unresolvedSegments,
  });
  const existing = path.join(workspace, "input.json");
  const rows = [
    ["resolvePathPrefixSync", existing, complete(existing, existing)],
    [
      "resolvePathPrefixSync/missing",
      `${workspace}${path.sep}future${path.sep}..${path.sep}input.json`,
      complete(`${workspace}${path.sep}future${path.sep}..${path.sep}input.json`, workspace,
        ["future", "..", "input.json"]),
    ],
    [
      "resolvePathPrefixSync/separator-heavy",
      `${workspace}${path.sep.repeat(4096)}future`,
      complete(`${workspace}${path.sep.repeat(4096)}future`, workspace, ["future"]),
    ],
  ];
  for (const [name, input, expected] of rows) {
    register(name, () => resolve(input), {
      sync: true,
      skip: unavailable,
      verify: result => assert.deepEqual(result, expected),
    });
  }
}

export function registerPathPrefixCampaign({ api, workspace, register, filter }) {
  const resolve = api.resolvePathPrefixSync;
  const unavailable = typeof resolve !== "function"
    ? "Not exported by this explicitly selected older comparison build."
    : undefined;
  const staticMetadata = pathPrefixCampaignMetadata(filter);
  if (!staticMetadata) {
    registerGenericRows({ resolve, workspace, register, unavailable });
    return null;
  }

  const cohort = createPathPrefixFixtureCohort({
    workspace,
    definitions: DEFINITIONS,
    queueLimit: SHIFT_QUEUE_COMPONENT_LIMIT,
  });
  for (const definition of DEFINITIONS) {
    const fixture = cohort.fixtures.get(definition.name);
    assert(fixture, `Missing path-prefix campaign fixture: ${definition.name}`);
    const workloadDetails = Object.freeze(expectedWorkloadDetails(definition, fixture.receipt));
    register(definition.name, () => resolve(fixture.input), {
      sync: true,
      skip: unavailable,
      pathPrefixCampaign: true,
      pathPrefixFixtureReceipt: fixture.receipt,
      inspectPathPrefixFixture: fixture.inspect,
      workloadSemantics: definition.workloadSemantics,
      workloadDetails,
      verify: result => assert.deepEqual(result, {
        absolutePath: fixture.input,
        existingPath: fixture.expected.existingPath,
        unresolvedSegments: fixture.expected.unresolvedSegments,
      }),
    });
  }
  return Object.freeze({
    ...staticMetadata,
    fixtureReceipts: cohort.receipts,
  });
}
