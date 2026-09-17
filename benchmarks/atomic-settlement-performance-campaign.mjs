import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN,
  ATOMIC_SETTLEMENT_PERFORMANCE_DESCRIPTOR_SHA256,
  ATOMIC_SETTLEMENT_NAMES,
  validateAtomicSettlementPerformanceReport,
} from "./atomic-settlement.mjs";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const WORKFLOW = ".github/workflows/atomic-settlement-performance.yml";
export const ATOMIC_SETTLEMENT_PERFORMANCE_BINDING = Object.freeze({
  schema: "fs-safe-atomic-settlement-campaign-binding-v1",
  state: "awaiting-default-main-registration-stub",
  registrationWorkflowPath: ".github/workflows/atomic-settlement-performance.yml",
  registrationCommit: null,
  registrationWorkflowSha256: null,
  baselineCommit: "af017899d1f7045f3da2b4cc5a7583712a0f93be",
  candidateCommit: "ddea6b806b54a165115ec3052bc7df3c48a172b2",
});
const STUDIES = ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.studies;
const PLATFORMS = ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.platforms;
const NODES = ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.nodeVersions;
const ORDERS = ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.orders;
const MODES = ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.modes;
export const ATOMIC_SETTLEMENT_ARTIFACT_CLOCK_TOLERANCE_MS = 5_000;
const ROLE_SEQUENCES = Object.freeze({
  abba: Object.freeze(["baseline", "candidate", "candidate", "baseline"]),
  baab: Object.freeze(["candidate", "baseline", "baseline", "candidate"]),
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function atomicSettlementDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export const ATOMIC_SETTLEMENT_REGISTRATION_INPUTS_YAML = `    inputs:
      expected_harness_sha:
        description: Exact reviewed 40-hex H named by the protected immutable harness seal; H is not stored inside H
        required: true
        type: string
      harness_seal_ref:
        description: Exact protected lightweight refs/tags/atomic-settlement-performance-h-<H> seal created after H
        required: true
        type: string
      candidate_sha:
        description: Exact reviewed 40-hex candidate commit (C)
        required: true
        type: string
      baseline_sha:
        description: Exact reviewed 40-hex pre-fix baseline commit (B), distinct from C
        required: true
        type: string
      expected_run_number:
        description: Exact next workflow run number predeclared before dispatch
        required: true
        type: string
      expected_run_attempt:
        description: Exact first run attempt; must be 1 and reruns are inadmissible
        required: true
        type: string`;

export const ATOMIC_SETTLEMENT_REGISTRATION_STUB = `name: atomic settlement performance acceptance

on:
  workflow_dispatch:
${ATOMIC_SETTLEMENT_REGISTRATION_INPUTS_YAML}

permissions: {}

jobs:
  registration-only:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - name: Refuse execution from the registration stub
        shell: bash
        run: |
          echo "This default-branch workflow only registers workflow_dispatch. Dispatch the reviewed protected H seal." >&2
          exit 1
`;

export function validateAtomicSettlementRegistrationStub(bytes) {
  const normalized = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  assert.equal(typeof normalized, "string", "registration stub bytes are required");
  assert.equal(normalized.replaceAll("\r\n", "\n"), ATOMIC_SETTLEMENT_REGISTRATION_STUB,
    "default-main registration stub is not the exact reviewed fail-closed workflow");
  return normalized;
}

export function validateAtomicSettlementPerformanceRunApi(runApi, contract) {
  exactKeys(contract, [
    "repository", "runId", "runNumber", "runAttempt", "createdAt", "harnessCommit", "sealRef",
  ], "campaign run API contract");
  assert(runApi && typeof runApi === "object", "run API response is invalid");
  assert.equal(contract.repository, "openclaw/fs-safe", "run API repository contract changed");
  assert.match(contract.runId, /^[1-9][0-9]*$/u, "run API ID contract is invalid");
  assert(Number.isSafeInteger(contract.runNumber) && contract.runNumber > 0,
    "run API number contract is invalid");
  assert.equal(contract.runAttempt, 1, "run API attempt contract is invalid");
  assert(Number.isFinite(Date.parse(contract.createdAt)), "run API creation time is invalid");
  sha1(contract.harnessCommit, "run API harness commit");
  const seal = /^refs\/tags\/atomic-settlement-performance-h-([0-9a-f]{40})$/u
    .exec(contract.sealRef);
  assert(seal, "run API seal ref is invalid");
  assert.equal(seal[1], contract.harnessCommit, "run API seal ref does not bind H");
  assert.equal(String(runApi.id), contract.runId, "run API ID changed");
  assert.equal(Number(runApi.run_number), contract.runNumber, "run API number changed");
  assert.equal(Number(runApi.run_attempt), contract.runAttempt, "run API attempt changed");
  assert.equal(runApi.created_at, contract.createdAt, "run API creation time changed");
  assert.equal(runApi.event, "workflow_dispatch", "run API event changed");
  assert.equal(runApi.head_sha, contract.harnessCommit, "run API head SHA changed");
  const tag = contract.sealRef.slice("refs/tags/".length);
  assert.equal(runApi.head_branch, tag, "run API head ref changed");
  assert.equal(runApi.path, WORKFLOW, "run API workflow path changed");
  assert.equal(runApi.repository?.full_name, contract.repository, "run API repository changed");
  assert.equal(runApi.head_repository?.full_name, contract.repository,
    "run API head repository changed");
  return runApi;
}

function exactKeys(value, keys, context) {
  assert(value && typeof value === "object", `${context} is required`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${context} fields changed`);
}

export function validateAtomicSettlementArtifactUploadWindow(value, context = "artifact") {
  exactKeys(value, [
    "jobStartedAt", "jobCompletedAt", "uploadStartedAt", "uploadCompletedAt",
    "artifactCreatedAt", "artifactUpdatedAt",
  ], `${context} upload-window evidence`);
  const timestamps = Object.fromEntries(Object.entries(value).map(([name, timestamp]) => {
    assert.equal(typeof timestamp, "string", `${context} ${name} is invalid`);
    const parsed = Date.parse(timestamp);
    assert(Number.isFinite(parsed), `${context} ${name} is invalid`);
    return [name, parsed];
  }));
  assert(timestamps.jobStartedAt <= timestamps.uploadStartedAt &&
    timestamps.uploadStartedAt <= timestamps.uploadCompletedAt &&
    timestamps.uploadCompletedAt <= timestamps.jobCompletedAt,
  `${context} producer chronology is invalid`);
  assert(timestamps.jobStartedAt <= timestamps.artifactCreatedAt &&
    timestamps.artifactCreatedAt <= timestamps.artifactUpdatedAt &&
    timestamps.artifactUpdatedAt <= timestamps.jobCompletedAt,
  `${context} is outside its hard producer-job window`);
  assert(timestamps.uploadStartedAt - ATOMIC_SETTLEMENT_ARTIFACT_CLOCK_TOLERANCE_MS <=
      timestamps.artifactCreatedAt &&
    timestamps.artifactUpdatedAt <= timestamps.uploadCompletedAt +
      ATOMIC_SETTLEMENT_ARTIFACT_CLOCK_TOLERANCE_MS,
  `${context} is outside its tolerated producer-upload window`);
  return value;
}

function sha1(value, context) {
  assert.match(value ?? "", SHA1, `${context} is not a full commit or tree hash`);
  return value;
}

function sha256(value, context) {
  assert.match(value ?? "", SHA256, `${context} is not a SHA-256 digest`);
  return value;
}

export function assertAtomicSettlementPerformanceBinding(
  binding = ATOMIC_SETTLEMENT_PERFORMANCE_BINDING,
  { requireReady = true } = {},
) {
  exactKeys(binding, [
    "schema", "state", "registrationWorkflowPath", "registrationCommit",
    "registrationWorkflowSha256", "baselineCommit", "candidateCommit",
  ], "atomic settlement campaign binding");
  assert.equal(binding.schema, "fs-safe-atomic-settlement-campaign-binding-v1");
  assert.equal(binding.registrationWorkflowPath,
    ".github/workflows/atomic-settlement-performance.yml");
  sha1(binding.baselineCommit, "bound baseline commit");
  sha1(binding.candidateCommit, "bound candidate commit");
  assert.notEqual(binding.baselineCommit, binding.candidateCommit,
    "the bound source-comparison baseline and candidate must be distinct");
  if (binding.state === "awaiting-default-main-registration-stub") {
    assert.equal(binding.registrationCommit, null,
      "pending campaign must not guess a registration commit");
    assert.equal(binding.registrationWorkflowSha256, null,
      "pending campaign must not guess registration workflow bytes");
    assert.equal(requireReady, false,
      "atomic settlement campaign binding must be finalized after the registration stub lands");
    return binding;
  }
  assert.equal(binding.state, "reviewed-registration-baseline-and-candidate",
    "atomic settlement campaign binding state is invalid");
  sha1(binding.registrationCommit, "registration commit");
  sha256(binding.registrationWorkflowSha256, "registration workflow");
  assert.notEqual(binding.registrationCommit, binding.baselineCommit,
    "registration commit and source baseline must be distinct identities");
  assert.notEqual(binding.registrationCommit, binding.candidateCommit,
    "registration commit and candidate commit must be distinct identities");
  return binding;
}

export function createAtomicSettlementPerformanceManifest({
  baseline,
  binding = ATOMIC_SETTLEMENT_PERFORMANCE_BINDING,
  candidate,
  dispatch,
  harness,
  harnessSeal,
  mainTip,
  repository,
  run,
}) {
  assertAtomicSettlementPerformanceBinding(binding);
  const body = {
    schema: "fs-safe-atomic-settlement-campaign-manifest-v1",
    repository,
    run: {
      id: String(run.id),
      number: Number(run.number),
      attempt: Number(run.attempt),
      createdAt: run.createdAt,
    },
    campaign: ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN,
    descriptorSha256: ATOMIC_SETTLEMENT_PERFORMANCE_DESCRIPTOR_SHA256,
    binding,
    dispatch,
    harness,
    harnessSeal,
    mainTip,
    sources: { baseline, candidate },
  };
  return Object.freeze({ ...body, manifestSha256: atomicSettlementDigest(body) });
}

export function validateAtomicSettlementPerformanceManifest(
  manifest,
  expectedBinding = ATOMIC_SETTLEMENT_PERFORMANCE_BINDING,
) {
  assertAtomicSettlementPerformanceBinding(expectedBinding);
  exactKeys(manifest, [
    "schema", "repository", "run", "campaign", "descriptorSha256", "binding", "dispatch",
    "harness", "harnessSeal", "mainTip", "sources", "manifestSha256",
  ], "atomic settlement campaign manifest");
  assert.equal(manifest.schema, "fs-safe-atomic-settlement-campaign-manifest-v1");
  assert.equal(manifest.repository, "openclaw/fs-safe", "campaign repository changed");
  exactKeys(manifest.run, ["id", "number", "attempt", "createdAt"], "campaign run");
  assert.match(manifest.run.id, /^[1-9][0-9]*$/u, "campaign run ID is invalid");
  assert(Number.isSafeInteger(manifest.run.number) && manifest.run.number > 0,
    "campaign run number is invalid");
  assert.equal(manifest.run.attempt, 1, "only a first-attempt campaign is admissible");
  assert(Number.isFinite(Date.parse(manifest.run.createdAt)),
    "campaign run creation time is invalid");
  assert.deepEqual(manifest.campaign, ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN,
    "campaign dimensions or gates changed");
  assert.equal(manifest.descriptorSha256, ATOMIC_SETTLEMENT_PERFORMANCE_DESCRIPTOR_SHA256,
    "campaign row descriptors changed");
  assert.deepEqual(manifest.binding, expectedBinding,
    "campaign registration/review binding changed");
  exactKeys(manifest.dispatch, [
    "repository", "eventName", "ref", "refProtected", "refType", "workflowRef",
    "workflowSha", "eventSha", "expectedHarnessSha", "expectedRunNumber",
    "expectedRunAttempt",
  ], "campaign dispatch");
  assert.equal(manifest.dispatch.repository, "openclaw/fs-safe");
  assert.equal(manifest.dispatch.eventName, "workflow_dispatch");
  assert.equal(manifest.dispatch.refType, "tag", "campaign dispatch ref is not a tag");
  assert.equal(manifest.dispatch.refProtected, true,
    "campaign harness seal ref is not protected");
  exactKeys(manifest.harness, [
    "commit", "tree", "workflowSha256", "benchmarkSha256", "manifestSha256",
    "lockfileSha256", "fileInventory",
  ], "campaign harness");
  sha1(manifest.harness.commit, "harness commit");
  sha1(manifest.harness.tree, "harness tree");
  for (const field of ["workflowSha256", "benchmarkSha256", "manifestSha256", "lockfileSha256"]) {
    sha256(manifest.harness[field], `harness ${field}`);
  }
  assert(Array.isArray(manifest.harness.fileInventory) &&
    manifest.harness.fileInventory.length > 3,
  "campaign harness file inventory is incomplete");
  const inventoryPaths = new Set();
  for (const entry of manifest.harness.fileInventory) {
    exactKeys(entry, ["path", "sha256", "size"], "campaign harness file inventory entry");
    assert.match(entry.path, /^(?:\.github\/workflows\/atomic-settlement-performance\.yml|package\.json|pnpm-lock\.yaml|benchmarks\/[a-z0-9-]+\.mjs)$/u,
      "campaign harness inventory path is unsafe");
    assert.equal(inventoryPaths.has(entry.path), false,
      "campaign harness inventory contains a duplicate path");
    inventoryPaths.add(entry.path);
    sha256(entry.sha256, `campaign harness inventory hash for ${entry.path}`);
    assert(Number.isSafeInteger(entry.size) && entry.size > 0,
      `campaign harness inventory size is invalid for ${entry.path}`);
  }
  for (const required of [WORKFLOW, "package.json", "pnpm-lock.yaml",
    "benchmarks/runner.mjs", "benchmarks/method-audit-evidence.mjs",
    "benchmarks/method-audit-plan.mjs", "benchmarks/measured-distribution.mjs",
    "benchmarks/atomic-settlement.mjs",
    "benchmarks/atomic-settlement-performance-campaign.mjs",
    "benchmarks/atomic-settlement-performance-evidence.mjs",
    "benchmarks/exact-artifact-zip.mjs"]) {
    assert(inventoryPaths.has(required), `campaign harness inventory is missing ${required}`);
  }
  assert.notEqual(manifest.harness.workflowSha256, expectedBinding.registrationWorkflowSha256,
    "H must contain executable workflow bytes distinct from the registration stub");
  exactKeys(manifest.harnessSeal, ["repository", "ref", "commit", "observedAt"],
    "harness seal receipt");
  assert.equal(manifest.harnessSeal.repository, "https://github.com/openclaw/fs-safe.git");
  const seal = /^refs\/tags\/atomic-settlement-performance-h-([0-9a-f]{40})$/u
    .exec(manifest.harnessSeal.ref);
  assert(seal, "harness seal ref is invalid");
  assert.equal(seal[1], manifest.harness.commit, "harness seal name does not bind H");
  assert.equal(manifest.harnessSeal.commit, manifest.harness.commit,
    "harness seal does not resolve to H");
  assert(Number.isFinite(Date.parse(manifest.harnessSeal.observedAt)),
    "harness seal observation time is invalid");
  assert(Date.parse(manifest.run.createdAt) <= Date.parse(manifest.harnessSeal.observedAt),
    "harness seal was observed before the campaign run existed");
  assert.equal(manifest.dispatch.ref, manifest.harnessSeal.ref,
    "dispatch ref does not match the harness seal");
  assert.equal(manifest.dispatch.workflowRef,
    `openclaw/fs-safe/.github/workflows/atomic-settlement-performance.yml@${manifest.harnessSeal.ref}`,
    "dispatch workflow ref does not match the sealed workflow");
  sha1(manifest.dispatch.workflowSha, "dispatch workflow SHA");
  sha1(manifest.dispatch.eventSha, "dispatch event SHA");
  assert.equal(manifest.dispatch.workflowSha, manifest.harness.commit,
    "dispatch workflow SHA does not match H");
  assert.equal(manifest.dispatch.eventSha, manifest.harness.commit,
    "dispatch event SHA does not match H");
  assert.equal(manifest.dispatch.expectedHarnessSha, manifest.harness.commit,
    "predeclared H does not match the sealed harness");
  assert.equal(manifest.dispatch.expectedRunNumber, manifest.run.number,
    "predeclared run number does not match the campaign run");
  assert.equal(manifest.dispatch.expectedRunAttempt, manifest.run.attempt,
    "predeclared run attempt does not match the campaign run");
  exactKeys(manifest.mainTip, ["repository", "ref", "commit", "observedAt"], "main-tip receipt");
  assert.equal(manifest.mainTip.repository, "https://github.com/openclaw/fs-safe.git");
  assert.equal(manifest.mainTip.ref, "refs/heads/main");
  assert.equal(manifest.mainTip.commit, expectedBinding.registrationCommit,
    "main moved from the reviewed registration commit");
  assert(Number.isFinite(Date.parse(manifest.mainTip.observedAt)), "main-tip observation time is invalid");
  assert(Date.parse(manifest.run.createdAt) <= Date.parse(manifest.mainTip.observedAt),
    "main was observed before the campaign run existed");
  exactKeys(manifest.sources, ["baseline", "candidate"], "campaign sources");
  for (const role of ["baseline", "candidate"]) {
    exactKeys(manifest.sources[role], [
      "commit", "tree", "manifestSha256", "lockfileSha256",
    ], `${role} source`);
    sha1(manifest.sources[role].commit, `${role} commit`);
    sha1(manifest.sources[role].tree, `${role} tree`);
    sha256(manifest.sources[role].manifestSha256, `${role} manifest`);
    sha256(manifest.sources[role].lockfileSha256, `${role} lockfile`);
  }
  assert.notEqual(manifest.sources.baseline.commit, manifest.sources.candidate.commit,
    "the source-comparison baseline and candidate must be distinct");
  assert.equal(manifest.sources.baseline.commit, expectedBinding.baselineCommit,
    "B must be the exact reviewed pre-fix baseline commit");
  assert.equal(manifest.sources.candidate.commit, expectedBinding.candidateCommit,
    "C does not match the reviewed candidate binding");
  assert.notEqual(manifest.harness.commit, expectedBinding.registrationCommit,
    "H must replace the default-main registration stub");
  assert.notEqual(manifest.harness.commit, expectedBinding.baselineCommit,
    "H must be distinct from the source baseline");
  assert.notEqual(manifest.harness.commit, expectedBinding.candidateCommit,
    "H must be created after the in-tree C binding is fixed");
  const { manifestSha256, ...body } = manifest;
  assert.equal(manifestSha256, atomicSettlementDigest(body), "campaign manifest hash mismatch");
  return manifest;
}

export function expectedAtomicSettlementRawReports() {
  const expected = [];
  for (const study of STUDIES) {
    for (const platform of PLATFORMS) {
      for (const node of NODES) {
        for (const order of ORDERS) {
          for (let block = 1; block <= ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.blocks; block += 1) {
            for (let position = 1;
              position <= ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.positionsPerBlock;
              position += 1) {
              for (const mode of MODES) {
                expected.push({
                  study,
                  platform,
                  node,
                  order,
                  block,
                  position,
                  mode,
                  role: ROLE_SEQUENCES[order][position - 1],
                  reportId: [study, platform, node, order, `block-${block}`,
                    `position-${position}`, mode].join("/"),
                });
              }
            }
          }
        }
      }
    }
  }
  assert.equal(expected.length, ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.rawReportProcesses);
  return expected;
}

function expectedSource(manifest, study, role) {
  if (role === "candidate") return manifest.sources.candidate;
  return study === "source-comparison"
    ? manifest.sources.baseline : manifest.sources.candidate;
}

function expectedRunnerReportId(expected) {
  const roles = ROLE_SEQUENCES[expected.order];
  const occurrence = roles.slice(0, expected.position)
    .filter((role) => role === expected.role).length;
  return `block-${expected.block}-${expected.role}-${occurrence === 1 ? "a" : "b"}-${expected.mode}`;
}

function assertReceipt(value, context) {
  exactKeys(value, ["sha256", "size", "dev", "ino", "mtimeNs"], context);
  sha256(value.sha256, `${context} hash`);
  assert(Number.isSafeInteger(value.size) && value.size > 0, `${context} size is invalid`);
  for (const field of ["dev", "ino", "mtimeNs"]) {
    assert.match(value[field], /^[0-9]+$/u, `${context} ${field} is invalid`);
  }
}

function validateProvenance(capture, expected, manifest, identities) {
  exactKeys(capture, [
    "study", "platform", "node", "order", "block", "position", "mode", "role",
    "reportId", "artifact", "job", "raw", "manifestSha256", "planHash", "report",
  ], `capture ${expected.reportId}`);
  for (const field of [
    "study", "platform", "node", "order", "block", "position", "mode", "role", "reportId",
  ]) assert.equal(capture[field], expected[field], `${expected.reportId} ${field} mismatch`);
  assert.equal(capture.manifestSha256, manifest.manifestSha256,
    `${expected.reportId} campaign manifest binding mismatch`);
  sha256(capture.planHash, `${expected.reportId} plan hash`);
  exactKeys(capture.artifact, [
    "id", "name", "archiveDigest", "directoryHashSchema", "directorySha256", "size",
    "createdAt", "updatedAt",
  ],
    `${expected.reportId} artifact`);
  assert.match(String(capture.artifact.id), /^[1-9][0-9]*$/u, "artifact ID is invalid");
  assert.match(capture.artifact.name, /^[A-Za-z0-9._-]+$/u, "artifact name is unsafe");
  assert.equal(capture.artifact.name,
    `atomic-settlement-${expected.platform}-node-${expected.node}-${expected.order}-${expected.study}-${manifest.run.id}-1`,
  "artifact identity changed");
  assert.match(capture.artifact.archiveDigest, /^sha256:[0-9a-f]{64}$/u,
    "artifact API digest is invalid");
  assert.equal(capture.artifact.directoryHashSchema, "typed-path-size-content-v1",
    "downloaded artifact directory hash schema changed");
  sha256(capture.artifact.directorySha256, "downloaded artifact directory hash");
  assert(Number.isSafeInteger(capture.artifact.size) && capture.artifact.size > 0,
    "artifact API size is invalid");
  exactKeys(capture.job, [
    "id", "name", "displayName", "runId", "runAttempt", "startedAt", "completedAt",
    "upload",
  ],
    `${expected.reportId} job`);
  assert.match(String(capture.job.id), /^[1-9][0-9]*$/u, "job ID is invalid");
  assert.equal(capture.job.name, "measure", "job name changed");
  assert.equal(String(capture.job.runId), manifest.run.id, "job run ID changed");
  assert.equal(capture.job.runAttempt, manifest.run.attempt, "job attempt changed");
  assert.equal(capture.job.displayName,
    `Measure atomic settlement (${expected.platform}, ${expected.node}, ${expected.order}, ${expected.study})`,
    "job display identity changed");
  const startedAt = Date.parse(capture.job.startedAt);
  const completedAt = Date.parse(capture.job.completedAt);
  const measuredAt = Date.parse(capture.report.metadata?.date);
  exactKeys(capture.job.upload, ["name", "number", "startedAt", "completedAt"],
    `${expected.reportId} upload step`);
  assert.equal(capture.job.upload.name, "Upload exact first-attempt study artifact",
    `${expected.reportId} upload step identity changed`);
  assert(Number.isSafeInteger(capture.job.upload.number) && capture.job.upload.number > 0,
    `${expected.reportId} upload step number is invalid`);
  const uploadStartedAt = Date.parse(capture.job.upload.startedAt);
  const uploadCompletedAt = Date.parse(capture.job.upload.completedAt);
  assert([startedAt, completedAt, measuredAt, uploadStartedAt, uploadCompletedAt]
    .every(Number.isFinite),
  "capture chronology is invalid");
  assert(Date.parse(manifest.run.createdAt) <= startedAt,
    `${expected.reportId} job predates the admitted campaign run`);
  assert(startedAt <= measuredAt && measuredAt <= uploadStartedAt,
    `${expected.reportId} was not produced inside its admitted job`);
  validateAtomicSettlementArtifactUploadWindow({
    jobStartedAt: capture.job.startedAt,
    jobCompletedAt: capture.job.completedAt,
    uploadStartedAt: capture.job.upload.startedAt,
    uploadCompletedAt: capture.job.upload.completedAt,
    artifactCreatedAt: capture.artifact.createdAt,
    artifactUpdatedAt: capture.artifact.updatedAt,
  }, `${expected.reportId} artifact`);
  assertReceipt(capture.raw, `${expected.reportId} raw report`);
  const artifactKey = `${expected.study}/${expected.platform}/${expected.node}/${expected.order}`;
  const artifactIdentity = JSON.stringify({ artifact: capture.artifact, job: capture.job });
  if (identities.artifact.has(artifactKey)) {
    assert.equal(identities.artifact.get(artifactKey), artifactIdentity,
      `${artifactKey} mixed artifact or job identities`);
  } else {
    assert.equal([...identities.artifact.values()].includes(artifactIdentity), false,
      "one artifact or job was reused for multiple studies");
    identities.artifact.set(artifactKey, artifactIdentity);
  }
  const rawIdentity = `${capture.raw.dev}:${capture.raw.ino}`;
  assert.equal(identities.raw.has(rawIdentity), false, `raw file identity was reused: ${rawIdentity}`);
  identities.raw.add(rawIdentity);
  const report = capture.report;
  validateAtomicSettlementPerformanceReport(
    report,
    "settlement/success",
    ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.configuredIterations,
  );
  assert.equal(report.metadata.mode, expected.mode, `${expected.reportId} report mode changed`);
  assert.equal(report.metadata.samples, 9, `${expected.reportId} sample count setting changed`);
  assert.equal(report.metadata.node.startsWith(`v${expected.node}.`), true,
    `${expected.reportId} Node version changed`);
  const runtimePlatform = { linux: "linux", macos: "darwin", windows: "win32" }[expected.platform];
  assert.equal(report.metadata.platform, runtimePlatform,
    `${expected.reportId} platform changed`);
  const evidence = report.methodAuditEvidence;
  assert(evidence, `${expected.reportId} method-audit evidence is missing`);
  assert.equal(evidence.planHash, capture.planHash,
    `${expected.reportId} plan hash binding is invalid`);
  assert.equal(evidence.harness?.workflowRef, manifest.dispatch.workflowRef,
    `${expected.reportId} workflow ref changed`);
  assert.equal(evidence.harness?.workflowSha, manifest.harness.commit,
    `${expected.reportId} harness commit changed`);
  assert.equal(evidence.harness?.workflowTree, manifest.harness.tree,
    `${expected.reportId} harness tree changed`);
  assert.equal(evidence.harness?.workflowFile,
    ".github/workflows/atomic-settlement-performance.yml",
    `${expected.reportId} workflow path changed`);
  assert.equal(evidence.harness?.workflowFileHash, manifest.harness.workflowSha256,
    `${expected.reportId} workflow bytes changed`);
  assert.equal(evidence.harness?.benchmarkHash, manifest.harness.benchmarkSha256,
    `${expected.reportId} benchmark harness changed`);
  assert.equal(evidence.harness?.manifestBlobHash, manifest.harness.manifestSha256,
    `${expected.reportId} harness package manifest changed`);
  assert.equal(evidence.harness?.lockfileBlobHash, manifest.harness.lockfileSha256,
    `${expected.reportId} harness lockfile changed`);
  const source = expectedSource(manifest, expected.study, expected.role);
  assert.equal(evidence.source?.role, expected.role, `${expected.reportId} source role changed`);
  assert.equal(evidence.source?.commit, source.commit, `${expected.reportId} source commit changed`);
  assert.equal(evidence.source?.tree, source.tree, `${expected.reportId} source tree changed`);
  assert.equal(evidence.source?.manifestBlobHash, source.manifestSha256,
    `${expected.reportId} source manifest changed`);
  assert.equal(evidence.source?.lockfileBlobHash, source.lockfileSha256,
    `${expected.reportId} source lockfile changed`);
  assert.equal(evidence.measurement?.controlKind, expected.study,
    `${expected.reportId} study kind changed`);
  assert.equal(evidence.measurement?.reportId, expectedRunnerReportId(expected),
    `${expected.reportId} runner report identity changed`);
  assert.equal(evidence.measurement?.order, expected.order, `${expected.reportId} order changed`);
  assert.equal(evidence.measurement?.block, expected.block, `${expected.reportId} block changed`);
  assert.equal(evidence.measurement?.position, expected.position,
    `${expected.reportId} position changed`);
  assert.equal(evidence.measurement?.sequence, (expected.block - 1) * 4 + expected.position,
    `${expected.reportId} sequence changed`);
  assert.equal(evidence.measurement?.mode, expected.mode, `${expected.reportId} mode changed`);
  assert.equal(evidence.measurement?.iterations,
    ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.configuredIterations,
    `${expected.reportId} configured iterations changed`);
  assert.equal(evidence.measurement?.samples,
    ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.samples,
    `${expected.reportId} samples changed`);
  assert.equal(evidence.measurement?.warmup,
    ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.warmup,
    `${expected.reportId} warmups changed`);
  assert.equal(evidence.measurement?.filter, "settlement/success",
    `${expected.reportId} filter changed`);
  const expectedBuildId = expected.role === "candidate" || expected.study === "same-artifact"
    ? "candidate-build" : "baseline-build";
  assert.equal(evidence.measurement?.buildId, expectedBuildId,
    `${expected.reportId} build identity changed`);
  assert.equal(evidence.measurement?.artifactPathId,
    `${expectedBuildId === "candidate-build" ? "candidate" : "baseline"}/dist`,
    `${expected.reportId} measured a mixed or unexpected dist`);
  assert(evidence.installation?.distTreeHash, `${expected.reportId} dist receipt is missing`);
  assert(evidence.installation?.dependencySnapshot,
    `${expected.reportId} dependency receipt is missing`);
  assert(Array.isArray(evidence.installation?.nativeArtifacts),
    `${expected.reportId} native artifact receipt is missing`);
  if (report.metadata.nativeHash !== null) {
    assert(evidence.installation.nativeArtifacts.some(({ sha256: hash }) =>
      hash === report.metadata.nativeHash), `${expected.reportId} native artifact was not selected`);
  }
  assert.equal(evidence.installation?.loadedNativeHash, report.metadata.nativeHash,
    `${expected.reportId} native receipt changed`);
  assert.equal(evidence.installation?.identityStableThroughStudy, true,
    `${expected.reportId} installation was not stable`);
  assert.equal(String(evidence.runtime?.githubRunId), manifest.run.id,
    `${expected.reportId} runtime run ID changed`);
  assert.equal(String(evidence.runtime?.githubRunAttempt), String(manifest.run.attempt),
    `${expected.reportId} runtime attempt changed`);
  assert.equal(evidence.runtime?.githubJob, capture.job.name,
    `${expected.reportId} runtime job changed`);
  assert.equal(evidence.runtime?.platformSelection, expected.platform,
    `${expected.reportId} runtime platform selection changed`);
  const runtimeIdentity = JSON.stringify(evidence.runtime);
  if (identities.runtime.has(artifactKey)) {
    assert.equal(identities.runtime.get(artifactKey), runtimeIdentity,
      `${artifactKey} mixed runtime identities`);
  } else {
    identities.runtime.set(artifactKey, runtimeIdentity);
  }
  return report;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  assert(sorted.length > 0, "cannot calculate an empty median");
  return (sorted[Math.floor((sorted.length - 1) / 2)] +
    sorted[Math.floor(sorted.length / 2)]) / 2;
}

export function atomicSettlementPerformanceGate(
  candidate,
  baseline,
  study,
  absoluteLimit,
  relativeLimit,
) {
  const directional = candidate - baseline;
  const absoluteUs = study === "source-comparison" ? directional : Math.abs(directional);
  const relativePercent = baseline === 0
    ? (absoluteUs > 0 ? Number.POSITIVE_INFINITY : 0)
    : absoluteUs * 100 / baseline;
  return {
    baseline,
    candidate,
    absoluteUs,
    relativePercent,
    failed: absoluteUs > absoluteLimit || relativePercent > relativeLimit,
  };
}

function resultSamples(capture, rowName) {
  const result = capture.report.results.find(({ name }) => name === rowName);
  assert(result, `${capture.reportId} is missing ${rowName}`);
  assert.equal(result.skipped, undefined, `${capture.reportId} skipped ${rowName}`);
  assert.equal(result.samplesUs.length, ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.samples,
    `${capture.reportId} sample count changed`);
  assert(result.samplesUs.every((sample) => Number.isFinite(sample) && sample >= 0),
    `${capture.reportId} has an invalid sample average`);
  return result.samplesUs;
}

function comparison(captures, rowName, study, scope, expectedSamples) {
  const samples = (role) => captures.filter((capture) => capture.role === role)
    .flatMap((capture) => resultSamples(capture, rowName));
  const candidate = samples("candidate");
  const baseline = samples("baseline");
  assert.equal(candidate.length, baseline.length, `${scope} role sample counts differ`);
  assert.equal(candidate.length, expectedSamples, `${scope} sample-average set is incomplete`);
  const medianGate = atomicSettlementPerformanceGate(
    median(candidate), median(baseline), study,
    ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.gates.median.absoluteUs,
    ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.gates.median.relativePercent,
  );
  const maximumGate = atomicSettlementPerformanceGate(
    Math.max(...candidate), Math.max(...baseline), study,
    ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.gates.maximumSampleAverage.absoluteUs,
    ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.gates.maximumSampleAverage.relativePercent,
  );
  return { median: medianGate, maximumSampleAverage: maximumGate,
    failed: medianGate.failed || maximumGate.failed };
}

function analyze(captures) {
  const cells = [];
  const combinedOrders = [];
  for (const study of STUDIES) {
    for (const platform of PLATFORMS) {
      for (const node of NODES) {
        for (const mode of MODES) {
          for (const rowName of ATOMIC_SETTLEMENT_NAMES) {
            const environment = captures.filter((capture) => capture.study === study &&
              capture.platform === platform && capture.node === node && capture.mode === mode);
            for (const order of ORDERS) {
              const ordered = environment.filter((capture) => capture.order === order);
              const blocks = Array.from(
                { length: ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.blocks },
                (_, index) => index + 1,
              ).map((block) => comparison(
                ordered.filter((capture) => capture.block === block), rowName, study,
                `${study}/${platform}/${node}/${mode}/${order}/${rowName}/block-${block}`,
                18,
              ));
              const pooled = comparison(ordered, rowName, study,
                `${study}/${platform}/${node}/${mode}/${order}/${rowName}/pooled`,
                18 * ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.blocks);
              cells.push({ study, platform, node, mode, rowName, order, blocks, pooled,
                failed: blocks.some(({ failed }) => failed) || pooled.failed });
            }
            const combined = comparison(environment, rowName, study,
              `${study}/${platform}/${node}/${mode}/${rowName}/both-orders`,
              36 * ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.blocks);
            combinedOrders.push({ study, platform, node, mode, rowName, combined,
              failed: combined.failed });
          }
        }
      }
    }
  }
  assert.equal(cells.length, ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.cells.ordered,
    "campaign comparison-cell count changed");
  assert.equal(combinedOrders.length,
    ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.cells.combinedOrders,
    "combined-order gate count changed");
  return { cells, combinedOrders };
}

export function validateAtomicSettlementPerformanceCampaign(
  { manifest, captures },
  expectedBinding = ATOMIC_SETTLEMENT_PERFORMANCE_BINDING,
) {
  validateAtomicSettlementPerformanceManifest(manifest, expectedBinding);
  const expected = expectedAtomicSettlementRawReports();
  assert.equal(captures.length, expected.length,
    "campaign is incomplete or contains replacement reports");
  const byId = new Map(captures.map((capture) => [capture.reportId, capture]));
  assert.equal(byId.size, expected.length, "campaign has duplicate report identities");
  const identities = { artifact: new Map(), raw: new Set(), runtime: new Map() };
  const validated = expected.map((entry) => {
    const capture = byId.get(entry.reportId);
    assert(capture, `campaign is missing ${entry.reportId}`);
    validateProvenance(capture, entry, manifest, identities);
    return capture;
  });
  assert.deepEqual([...byId.keys()].sort(), expected.map(({ reportId }) => reportId).sort(),
    "campaign contains an unexpected report");
  const { cells, combinedOrders } = analyze(validated);
  assert.equal(identities.artifact.size, ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.matrixJobs,
    "campaign artifact/job set changed");
  const allGates = [...cells, ...combinedOrders];
  const controlFailures = allGates.filter(({ study, failed }) =>
    study !== "source-comparison" && failed);
  const sourceFailures = allGates.filter(({ study, failed }) =>
    study === "source-comparison" && failed);
  return {
    schema: "fs-safe-atomic-settlement-performance-analysis-v1",
    manifestSha256: manifest.manifestSha256,
    rawReportProcesses: validated.length,
    comparisonCells: cells.length,
    cells,
    combinedOrders,
    controlFailures: controlFailures.length,
    sourceFailures: sourceFailures.length,
    accepted: controlFailures.length === 0 && sourceFailures.length === 0,
    replacementPolicy: ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.replacementPolicy,
  };
}
