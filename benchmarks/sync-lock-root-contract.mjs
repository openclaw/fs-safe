import assert from "node:assert/strict";

export const SYNC_LOCK_ROOT_FILTER = "syncLockRoot/";
export const SYNC_LOCK_ROOT_BASE_SHA = "af017899d1f7045f3da2b4cc5a7583712a0f93be";
export const SYNC_LOCK_ROOT_SCHEMA = "fs-safe-sync-lock-root-benchmark-v1";
export const SYNC_LOCK_ROOT_CAMPAIGN_SCHEMA = "fs-safe-sync-lock-root-campaign-v3";
export const SYNC_LOCK_ROOT_CRABBOX_TIMING_SCHEMA =
  "crabbox-go-TimingReport-syncDelegated-omitempty-v1";
export const SYNC_LOCK_ROOT_REPOSITORY = "openclaw/fs-safe";
export const SYNC_LOCK_ROOT_WORKFLOW_PATH =
  ".github/workflows/sync-lock-root-performance-proof.yml";
export const SYNC_LOCK_ROOT_HOSTED_CLOCK_POLICY =
  "campaign-initialized-no-later-than-actions-run-v1";
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function campaignTimestamp(value) {
  assert.match(value ?? "",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u,
  "sync lockRoot campaign initialization timestamp is invalid");
  assert(Number.isFinite(Date.parse(value)),
    "sync lockRoot campaign initialization timestamp is invalid");
}

export function validateSyncLockRootCampaign(campaign) {
  assert.deepEqual(Object.keys(campaign ?? {}).sort(), [
    "actions", "captures", "crabbox", "id", "schema",
  ],
    "sync lockRoot campaign field set mismatch");
  assert.equal(campaign.schema, SYNC_LOCK_ROOT_CAMPAIGN_SCHEMA,
    "sync lockRoot campaign schema mismatch");
  assert.match(campaign.id, UUID_V4, "sync lockRoot campaign ID is invalid");
  assert.deepEqual(Object.keys(campaign.captures ?? {}).sort(), ["22", "24"],
    "sync lockRoot capture-token set mismatch");
  assert.match(campaign.captures["22"], UUID_V4, "Node 22 capture token is invalid");
  assert.match(campaign.captures["24"], UUID_V4, "Node 24 capture token is invalid");
  assert.notEqual(campaign.captures["22"], campaign.captures["24"],
    "WSL2 capture tokens overlap");
  assert.notEqual(campaign.id, campaign.captures["22"], "campaign ID overlaps a capture token");
  assert.notEqual(campaign.id, campaign.captures["24"], "campaign ID overlaps a capture token");
  assert.deepEqual(Object.keys(campaign.actions ?? {}).sort(), [
    "clockPolicy", "expectedActionsRunNumber", "harnessSha", "initializedAt", "repository",
    "runAttempt", "workflowDatabaseId", "workflowFileSha256", "workflowPath",
  ], "sync lockRoot hosted Actions binding field set mismatch");
  assert.equal(campaign.actions.repository, SYNC_LOCK_ROOT_REPOSITORY,
    "sync lockRoot hosted repository binding mismatch");
  assert.match(campaign.actions.workflowDatabaseId ?? "", /^[1-9][0-9]*$/u,
    "sync lockRoot workflow database ID is invalid");
  assert.equal(campaign.actions.workflowPath, SYNC_LOCK_ROOT_WORKFLOW_PATH,
    "sync lockRoot workflow path binding mismatch");
  assert.match(campaign.actions.harnessSha ?? "", SHA1,
    "sync lockRoot hosted harness SHA is invalid");
  assert.match(campaign.actions.workflowFileSha256 ?? "", SHA256,
    "sync lockRoot workflow byte hash is invalid");
  assert(Number.isSafeInteger(campaign.actions.expectedActionsRunNumber) &&
    campaign.actions.expectedActionsRunNumber > 0,
  "sync lockRoot expected Actions run number is invalid");
  assert.equal(campaign.actions.runAttempt, 1,
    "sync lockRoot campaign permits only the first Actions attempt");
  campaignTimestamp(campaign.actions.initializedAt);
  assert.equal(campaign.actions.clockPolicy, SYNC_LOCK_ROOT_HOSTED_CLOCK_POLICY,
    "sync lockRoot hosted clock policy mismatch");
  assert.deepEqual(Object.keys(campaign.crabbox ?? {}).sort(), ["timingSchema", "version"],
    "sync lockRoot Crabbox binding field set mismatch");
  assert.equal(campaign.crabbox.timingSchema, SYNC_LOCK_ROOT_CRABBOX_TIMING_SCHEMA,
    "sync lockRoot Crabbox TimingReport schema mismatch");
  assert.equal(typeof campaign.crabbox.version, "string", "Crabbox version binding is missing");
  assert(campaign.crabbox.version.length > 0 && campaign.crabbox.version.length <= 128 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(campaign.crabbox.version),
  "Crabbox version binding is invalid");
  return campaign;
}

function row(name, details, divisor = 1) {
  return Object.freeze({
    name: `${SYNC_LOCK_ROOT_FILTER}${name}`,
    details: Object.freeze({ schemaVersion: 1, ...details }),
    divisor,
  });
}

export const SYNC_LOCK_ROOT_ROWS = Object.freeze([
  row("raw/create-release/default-flat", {
    authority: "raw", lifecycle: "create-release", layout: "flat",
    policySize: 0, sidecar: "default", timingClass: "fsync-inclusive",
  }, 10),
  row("root/create-release/default-flat-policy-0", {
    authority: "root", lifecycle: "create-release", layout: "flat",
    policySize: 0, sidecar: "default", timingClass: "fsync-inclusive",
  }, 10),
  row("root/create-release/explicit-flat-policy-0", {
    authority: "root", lifecycle: "create-release", layout: "flat",
    policySize: 0, sidecar: "explicit", timingClass: "fsync-inclusive",
  }, 10),
  row("root/create-release/explicit-deep-existing-policy-0", {
    authority: "root", lifecycle: "create-release", layout: "deep-existing-16",
    policySize: 0, sidecar: "explicit", timingClass: "fsync-inclusive",
  }, 10),
  row("root/create-release/explicit-deep-missing-policy-0", {
    authority: "root", lifecycle: "create-release", layout: "deep-missing-16",
    policySize: 0, sidecar: "explicit", timingClass: "fsync-inclusive",
  }, 10),
  row("root/create-release/explicit-flat-policy-10", {
    authority: "root", lifecycle: "create-release", layout: "flat",
    policySize: 10, sidecar: "explicit", timingClass: "fsync-inclusive",
  }, 10),
  row("root/create-release/explicit-flat-policy-100", {
    authority: "root", lifecycle: "create-release", layout: "flat",
    policySize: 100, sidecar: "explicit", timingClass: "fsync-inclusive",
  }, 10),
  row("root/create-release/noop-mutation-assertion", {
    authority: "root", lifecycle: "create-release", layout: "flat",
    mutationAssertion: "noop", policySize: 0, sidecar: "explicit",
    timingClass: "fsync-inclusive",
  }, 10),
  row("root/stale-reclaim/explicit-flat", {
    authority: "root", lifecycle: "stale-reclaim", layout: "flat",
    policySize: 0, sidecar: "explicit", timingClass: "fsync-inclusive",
  }, 10),
  row("root/release-final/compromise-monitor", {
    authority: "root", lifecycle: "release-final", layout: "flat",
    monitor: "armed", policySize: 0, sidecar: "default", timingClass: "metadata-only",
  }),
  row("root/verify/default-parser", {
    authority: "root", lifecycle: "verify", layout: "flat",
    parser: "default", policySize: 0, sidecar: "default", timingClass: "metadata-only",
  }),
  row("root/verify/custom-parser", {
    authority: "root", lifecycle: "verify", layout: "flat",
    parser: "custom", policySize: 0, sidecar: "default", timingClass: "metadata-only",
  }),
  row("root/reentrant/acquire-same-owner", {
    authority: "root", lifecycle: "reentrant-acquire", layout: "flat",
    policySize: 0, sidecar: "default", timingClass: "metadata-only",
  }),
  row("root/reentrant/release-nonfinal", {
    authority: "root", lifecycle: "release-nonfinal", layout: "flat",
    policySize: 0, sidecar: "default", timingClass: "metadata-only",
  }),
  row("root/release-final/default-flat", {
    authority: "root", lifecycle: "release-final", layout: "flat",
    policySize: 0, sidecar: "default", timingClass: "metadata-only",
  }),
  row("root/verify/compromised-bytes", {
    authority: "root", lifecycle: "verify-compromised", layout: "flat",
    parser: "default", policySize: 0, sidecar: "default", timingClass: "metadata-only",
  }),
]);

const ROW_BY_NAME = new Map(SYNC_LOCK_ROOT_ROWS.map((entry) => [entry.name, entry]));

export function validateSyncLockRootBenchmarkReport(report, filter, configuredIterations) {
  if (filter !== SYNC_LOCK_ROOT_FILTER) {
    assert.equal(report.metadata?.syncLockRootProof ?? null, null,
      "non-lockRoot report contains focused proof metadata");
    return;
  }
  const proof = report.metadata?.syncLockRootProof;
  assert.equal(proof?.schema, SYNC_LOCK_ROOT_SCHEMA, "sync lockRoot proof metadata is missing");
  assert(Number.isSafeInteger(proof.processId) && proof.processId > 0, "invalid worker process ID");
  assert.match(proof.processToken,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    "invalid worker process token");
  assert.equal(proof.sourceCommit, report.metadata.measuredDistribution?.sourceCommit,
    "worker source binding mismatch");
  assert.equal(proof.configuredIterations, configuredIterations, "worker iteration binding mismatch");
  assert.equal(proof.configuredSamples, report.metadata.samples, "worker sample binding mismatch");
  assert.equal(proof.configuredWarmup, 3, "worker warmup binding mismatch");
  if (proof.tempRoot !== null) {
    assert.deepEqual(Object.keys(proof.tempRoot ?? {}).sort(), [
      "device", "environment", "filesystemType", "path", "realPath", "statfsType",
    ], "worker temp-root receipt field set mismatch");
    assert.equal(typeof proof.tempRoot.path, "string", "worker temp-root path is invalid");
    assert(proof.tempRoot.path.startsWith("/") && proof.tempRoot.path.length <= 4_096 &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(proof.tempRoot.path),
    "worker temp-root path is not an absolute WSL path");
    assert.equal(proof.tempRoot.path, proof.tempRoot.realPath,
      "worker temp-root path is not canonical");
    assert.deepEqual(proof.tempRoot.environment, {
      TMPDIR: proof.tempRoot.path, TMP: proof.tempRoot.path, TEMP: proof.tempRoot.path,
    }, "worker temp-root environment drifted");
    assert.match(proof.tempRoot.device, /^[0-9]+$/u, "worker temp device is invalid");
    assert.match(proof.tempRoot.statfsType, /^-?[0-9]+$/u,
      "worker temp filesystem type is invalid");
    assert.equal(typeof proof.tempRoot.filesystemType, "string",
      "worker temp filesystem name is invalid");
    assert(proof.tempRoot.filesystemType.length > 0 && proof.tempRoot.filesystemType.length <= 64,
      "worker temp filesystem name is invalid");
    assert.equal(String(report.metadata?.workspaceFilesystem?.type), proof.tempRoot.statfsType,
      "worker workspace filesystem differs from the pinned temp root");
  }
  const results = report.results ?? [];
  assert.deepEqual(results.map(({ name }) => name), SYNC_LOCK_ROOT_ROWS.map(({ name }) => name),
    "sync lockRoot benchmark row set or order mismatch");
  const rowNames = SYNC_LOCK_ROOT_ROWS.map(({ name }) => name).sort();
  assert.deepEqual(Object.keys(proof.fixtureReceipts ?? {}).sort(), rowNames,
    "sync lockRoot fixture receipt set mismatch");
  assert.deepEqual(Object.keys(proof.observations ?? {}).sort(), rowNames,
    "sync lockRoot observation set mismatch");
  for (const result of results) {
    const spec = ROW_BY_NAME.get(result.name);
    assert(spec, `unknown sync lockRoot benchmark row: ${result.name}`);
    assert.equal(result.skipped, undefined, `${result.name} must not be skipped`);
    assert.deepEqual(result.workloadDetails, spec.details, `${result.name} workload receipt mismatch`);
    const expectedIterations = Math.max(1, Math.floor(configuredIterations / spec.divisor));
    assert.equal(result.iterations, expectedIterations, `${result.name} effective iterations mismatch`);
    const observation = proof.observations[result.name];
    const expectedInvocations = proof.configuredWarmup + 1 +
      expectedIterations * proof.configuredSamples;
    assert.equal(observation?.invocations, expectedInvocations, `${result.name} invocation count mismatch`);
    const fixture = proof.fixtureReceipts[result.name];
    assert.equal(fixture?.fdObserved, true, `${result.name} did not prove descriptor ownership`);
    assert.equal(fixture?.sidecar, spec.details.sidecar, `${result.name} sidecar receipt mismatch`);
    assert.equal(fixture?.layout, spec.details.layout, `${result.name} layout receipt mismatch`);
    assert.equal(fixture?.depth, spec.details.layout === "flat" ? 0 : 16,
      `${result.name} target-depth receipt mismatch`);
    assert.equal(fixture?.policySize, spec.details.policySize,
      `${result.name} policy-size receipt mismatch`);
    assert.equal(typeof fixture?.lockPathRelative, "string", `${result.name} sidecar path is missing`);
    assert.equal(fixture.lockPathRelative.endsWith(spec.details.sidecar === "default"
      ? "state.json.lock" : "sidecar.lock"), true, `${result.name} sidecar path receipt mismatch`);
    const expectedParentCreated = spec.details.layout === "deep-missing-16"
      ? proof.sourceCommit === SYNC_LOCK_ROOT_BASE_SHA : null;
    assert.equal(fixture?.missingParentCreated, expectedParentCreated,
      `${result.name} missing-parent receipt mismatch`);
    assert.equal(fixture?.timerObserved, spec.details.monitor === "armed",
      `${result.name} timer receipt mismatch`);
    assert.equal(fixture?.rootCanonical, spec.details.authority === "root" ? true : null,
      `${result.name} Root canonicalization receipt mismatch`);
    const expectedDomain = spec.details.authority === "raw" || proof.sourceCommit === SYNC_LOCK_ROOT_BASE_SHA
      ? "raw" : "root";
    assert.equal(fixture?.domain, expectedDomain, `${result.name} held-domain receipt mismatch`);
    if (spec.details.mutationAssertion === "noop") {
      const observed = fixture.mutationAssertions > 0 && observation.mutationAssertions > 0;
      assert.equal(observed, proof.sourceCommit !== SYNC_LOCK_ROOT_BASE_SHA,
        `${result.name} mutation-authority receipt mismatch`);
    } else {
      assert.equal(observation?.mutationAssertions, 0, `${result.name} unexpected mutation callback`);
    }
  }
}
