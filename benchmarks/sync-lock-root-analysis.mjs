import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SYNC_LOCK_ROOT_BASE_SHA,
  SYNC_LOCK_ROOT_FILTER,
  SYNC_LOCK_ROOT_ROWS,
  SYNC_LOCK_ROOT_SCHEMA,
  validateSyncLockRootCampaign,
} from "./sync-lock-root-contract.mjs";
import {
  createReportEvidence,
  measurementSequence,
  validateCompleteReportSet,
  validatePlanHash,
} from "./method-audit-plan.mjs";
import {
  analyzeSyncLockRootStudy,
  SYNC_LOCK_ROOT_GATES,
} from "./sync-lock-root-gates.mjs";
import {
  loadWsl2CaptureDirectories,
  validateCampaignCellSet,
  validateReportExecutionWindow,
  validateSyncLockRootArtifactManifest,
} from "./sync-lock-root-provenance.mjs";
export { analyzeSyncLockRootStudy, SYNC_LOCK_ROOT_GATES } from "./sync-lock-root-gates.mjs";
export { validateSyncLockRootArtifactManifest } from "./sync-lock-root-provenance.mjs";
const SHA1 = /^[0-9a-f]{40}$/u;
const ARTIFACT_NAME = new RegExp(
  "^sync-lock-root-(linux|macos|windows|wsl2)-node-(22|24)-(abba|baab)-" +
    "(source-comparison|same-source-rebuild|same-artifact)-([A-Za-z0-9._-]+)-1$",
  "u",
);
const ALL_SURFACES = Object.freeze(["linux", "macos", "windows", "wsl2"]);
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJson(file) {
  const bytes = fs.readFileSync(file);
  assert(bytes.length > 0 && bytes.length <= 64 * 1024 * 1024, `${file} size is invalid`);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}


function validateSurfaces(surfaces) {
  assert(Array.isArray(surfaces) && surfaces.length > 0, "at least one surface is required");
  assert.equal(new Set(surfaces).size, surfaces.length, "duplicate execution surface");
  for (const surface of surfaces) assert(ALL_SURFACES.includes(surface), `invalid surface ${surface}`);
  assert([
    "linux,macos,windows",
    "linux,macos,windows,wsl2",
  ].includes(surfaces.join(",")), "only the complete hosted or hosted-plus-WSL2 cohort is admissible");
  return surfaces;
}

function validatePlan(plan, expected) {
  validatePlanHash(plan);
  if (expected.surface !== "wsl2") {
    assert.equal(plan.run.attempt, 1, "measurement plan is not a first attempt");
  }
  assert.equal(plan.repository, "openclaw/fs-safe", "measurement repository mismatch");
  assert.equal(plan.harness.sha, expected.harnessSha, "harness SHA mismatch");
  assert.deepEqual(plan.syncLockRootCampaign, expected.campaign,
    "measurement plan campaign binding mismatch");
  assert.equal(plan.repository, expected.campaign.actions.repository,
    "measurement plan repository differs from the predeclared campaign");
  assert.equal(plan.harness.sha, expected.campaign.actions.harnessSha,
    "measurement plan harness differs from the predeclared campaign");
  assert.equal(plan.harness.workflowFileHash, expected.campaign.actions.workflowFileSha256,
    "measurement workflow bytes differ from the predeclared campaign");
  assert.equal(plan.run.attempt, expected.campaign.actions.runAttempt,
    "measurement attempt differs from the predeclared campaign");
  assert.equal(plan.harness.workflowPath,
    ".github/workflows/sync-lock-root-performance-proof.yml", "workflow binding mismatch");
  assert.equal(plan.sources.candidate.commit, expected.candidateSha, "candidate SHA mismatch");
  assert.equal(plan.settings.platform, expected.surface, "measurement surface setting mismatch");
  assert.equal(plan.settings.filter, SYNC_LOCK_ROOT_FILTER, "measurement filter mismatch");
  assert.equal(plan.settings.iterations, 100, "configured iterations mismatch");
  assert.equal(plan.settings.samples, 9, "configured samples mismatch");
  assert.equal(plan.settings.blocks, 5, "independent process-block count mismatch");
  assert.equal(plan.settings.nativeMode, "off", "native mode mismatch");
  assert.equal(plan.settings.order, expected.order, "measurement order mismatch");
  assert.equal(plan.settings.nodeVersion, expected.node, "Node plan mismatch");
  assert.equal(plan.settings.controlKind, expected.control, "control kind mismatch");
  assert.equal(plan.settings.control, expected.control === "same-artifact" ? "same-artifact" : "rebuild",
    "control input mismatch");
  assert.equal(plan.settings.timeoutMinutes, 120, "measurement timeout setting mismatch");
  if (expected.control === "source-comparison") {
    assert.equal(plan.sources.baseline.commit, SYNC_LOCK_ROOT_BASE_SHA, "baseline SHA mismatch");
  } else {
    assert.equal(plan.sources.baseline.commit, expected.candidateSha, "control source mismatch");
    assert.deepEqual(plan.sources.baseline, plan.sources.candidate, "control source identity mismatch");
  }
  const os = {
    linux: "ubuntu-latest", macos: "macos-15", windows: "windows-latest", wsl2: "crabbox-wsl2",
  }[expected.surface];
  assert.deepEqual(plan.matrix.include, [{ platform: expected.surface, os }],
    "measurement platform matrix mismatch");
  const sameArtifact = expected.control === "same-artifact";
  assert.deepEqual(plan.builds, sameArtifact ? [
    { id: "candidate-build", checkout: "candidate", sourceRole: "candidate" },
  ] : [
    { id: "candidate-build", checkout: "candidate", sourceRole: "candidate" },
    { id: "baseline-build", checkout: "baseline", sourceRole: "baseline" },
  ], "measurement build plan mismatch");
  const buildForRole = (role) => role === "candidate" || sameArtifact
    ? "candidate-build" : "baseline-build";
  const expectedReports = measurementSequence({
    order: expected.order, blocks: 5, hasBaseline: true,
  }).map((measurement) => ({
    ...measurement,
    mode: "off",
    buildId: buildForRole(measurement.role),
    file: `${measurement.label}-off.json`,
  }));
  assert.deepEqual(plan.reports, expectedReports, "ABBA/BAAB process plan mismatch");
  return plan;
}

function validateReport(report, reportPlan, study, processTokens) {
  const evidence = report.methodAuditEvidence;
  assert.equal(evidence?.planHash, study.plan.planHash, "report plan binding mismatch");
  assert.equal(evidence.measurement?.reportId, reportPlan.file.slice(0, -5),
    "report identity mismatch");
  assert.equal(evidence.measurement?.controlKind, study.control, "report control mismatch");
  assert.equal(evidence.measurement?.order, study.order, "report order mismatch");
  assert.equal(evidence.measurement?.block, reportPlan.block, "report block mismatch");
  assert.equal(evidence.measurement?.position, reportPlan.position, "report position mismatch");
  if (study.surface !== "wsl2") {
    assert.equal(evidence.runtime?.githubRunAttempt, "1", "report is not from a first attempt");
  }
  assert.equal(String(evidence.runtime?.githubRunId), String(study.plan.run.id),
    "report run ID mismatch");
  assert.equal(evidence.runtime?.platformSelection, study.surface, "report surface mismatch");
  assert.equal(report.metadata?.node.startsWith(`v${study.node}.`), true, "report Node mismatch");
  for (const field of ["node", "platform", "arch", "cpu"]) {
    assert.equal(evidence.runtime?.[field], report.metadata?.[field],
      `report runtime ${field} receipt mismatch`);
  }
  assert.equal(evidence.installation?.identityStableThroughStudy, true,
    "installation identity did not remain stable");
  assert(evidence.harness?.dependencySnapshot, "harness dependency receipt is missing");
  assert(evidence.installation?.dependencySnapshot, "measured dependency receipt is missing");
  const proof = report.metadata?.syncLockRootProof;
  assert.equal(proof?.schema, SYNC_LOCK_ROOT_SCHEMA, "worker receipt is missing");
  assert.equal(proof.sourceCommit, evidence.source.commit, "worker source binding mismatch");
  assert.equal(processTokens.has(proof.processToken), false, "worker process token was reused");
  processTokens.add(proof.processToken);
  if (study.surface === "wsl2") {
    assert.equal(evidence.runtime.executionSurface, "wsl2-crabbox", "WSL2 surface is not Crabbox");
    assert.deepEqual(evidence.runtime.wsl2, {
      captureToken: study.admission.remote.captureToken,
      filesystemDevice: study.admission.remote.host.filesystemDevice,
      filesystemType: study.admission.remote.host.filesystemType,
      hostIdentityHash: study.admission.remote.host.identityHash,
      kernelRelease: study.admission.remote.host.kernelRelease,
      versionReceiptHash: study.admission.remote.host.versionReceiptHash,
      tempRoot: study.admission.remote.host.tempRoot,
    }, "WSL2 runtime host receipt mismatch");
    assert.deepEqual(proof.tempRoot, study.admission.remote.host.tempRoot,
      "WSL2 worker temp-root receipt mismatch");
  } else {
    assert.equal(evidence.runtime.executionSurface, "github-actions",
      "hosted report execution surface mismatch");
    assert.equal(evidence.runtime.wsl2, null, "hosted report contains WSL2 metadata");
    assert.equal(proof.tempRoot, null, "hosted report contains a WSL2 temp-root receipt");
  }
  const expectedJob = study.surface === "wsl2"
    ? `wsl2-node-${study.node}-${study.order}-${study.control}` : "measure";
  assert.equal(evidence.runtime.githubJob, expectedJob, "report job identity mismatch");
  const expectedEvidence = createReportEvidence(
    study.plan,
    reportPlan,
    report,
    study.provenance.before,
    evidence.runtime,
    {
      identityStableThroughStudy: true,
      runnerOutputReceipt: study.provenance.runnerOutputReceipts?.[reportPlan.file],
    },
  );
  assert.deepEqual(evidence, expectedEvidence, "report evidence receipt mismatch");
  validateReportExecutionWindow(report, study.admission);
  assert.deepEqual(report.results.map(({ name }) => name),
    SYNC_LOCK_ROOT_ROWS.map(({ name }) => name), "report row set mismatch");
  return report;
}

function loadStudy(directory, tuple, expected, admission, processTokens) {
  const match = ARTIFACT_NAME.exec(path.basename(directory));
  assert(match, `invalid study artifact name: ${path.basename(directory)}`);
  const [, surface, node, order, control, runId] = match;
  assert.equal(`${surface}|${node}|${order}|${control}`, tuple, "artifact tuple mismatch");
  const planRead = readJson(path.join(directory, "proof-plan.json"));
  const provenanceRead = readJson(path.join(directory, "study-provenance.json"));
  const plan = validatePlan(planRead.value, { ...expected, surface, node, order, control });
  assert.equal(String(plan.run.id), runId, "artifact name run ID mismatch");
  const provenance = provenanceRead.value;
  assert.equal(provenance.schemaVersion, 1, "study provenance schema mismatch");
  assert.deepEqual(provenance.plan, plan, "study provenance plan mismatch");
  assert.equal(provenance.platform, surface, "study provenance surface mismatch");
  assert.deepEqual(provenance.artifactIdentity, {
    name: path.basename(directory),
    runId: String(plan.run.id),
    runAttempt: String(plan.run.attempt),
    surface,
    node,
    order,
    control,
  }, "study artifact identity receipt mismatch");
  assert.equal(digest(planRead.bytes), provenance.proofPlanFileSha256,
    "copied proof plan hash mismatch");
  const reportFiles = plan.reports.map(({ file }) => file);
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    ...reportFiles, "proof-plan.json", "study-provenance.json",
  ].sort(), "study artifact file set mismatch");
  assert.deepEqual(Object.keys(provenance.reports ?? {}).sort(), [...reportFiles].sort(),
    "study report-hash set mismatch");
  assert.deepEqual(Object.keys(provenance.runnerOutputReceipts ?? {}).sort(), [...reportFiles].sort(),
    "study runner-receipt set mismatch");
  const study = { admission, control, directory, node, order, plan, provenance, reports: [], surface };
  const tokenCountBefore = processTokens.size;
  const reportsByFile = new Map();
  for (const reportPlan of plan.reports) {
    const file = path.join(directory, reportPlan.file);
    const reportRead = readJson(file);
    assert.equal(digest(reportRead.bytes), provenance.reports[reportPlan.file],
      `${reportPlan.file} artifact hash mismatch`);
    const report = validateReport(reportRead.value, reportPlan, study, processTokens);
    study.reports.push({ plan: reportPlan, report });
    reportsByFile.set(reportPlan.file, report);
  }
  validateCompleteReportSet(plan, reportsByFile, provenance.before, provenance.after);
  assert.equal(processTokens.size - tokenCountBefore, 20,
    "study did not use 20 independent worker processes");
  return study;
}

export function analyzeSyncLockRootCampaign({
  artifactRoot, artifactManifest = null, campaign, candidateSha, harnessSha, surfaces,
  runId = null, headSha = null,
}) {
  validateSurfaces(surfaces);
  validateSyncLockRootCampaign(campaign);
  assert.match(candidateSha, SHA1, "candidate SHA is invalid");
  assert.match(harnessSha, SHA1, "harness SHA is invalid");
  const entries = fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("sync-lock-root-"));
  const studiesByTuple = new Map();
  const admissions = new Map();
  const addStudy = (name, directory, admission) => {
    const match = ARTIFACT_NAME.exec(name);
    assert(match, `unexpected proof artifact directory: ${name}`);
    const tuple = `${match[1]}|${match[2]}|${match[3]}|${match[4]}`;
    assert.equal(studiesByTuple.has(tuple), false, `duplicate study tuple: ${tuple}`);
    studiesByTuple.set(tuple, { admission, directory, name });
  };
  for (const entry of entries) addStudy(entry.name, path.join(artifactRoot, entry.name), null);
  const wsl2Captures = loadWsl2CaptureDirectories(
    artifactRoot, surfaces.includes("wsl2"), campaign, candidateSha, harnessSha,
  );
  for (const capture of wsl2Captures) {
    for (const [name, directory] of Object.entries(capture.studies)) {
      addStudy(name, directory, { kind: "wsl2", outer: capture.outer, remote: capture.remote });
    }
  }
  const expected = validateCampaignCellSet(studiesByTuple.keys(), surfaces);
  const actionNames = entries.map(({ name }) => name);
  let artifacts = [];
  let jobs = [];
  let actionsRun = null;
  if (actionNames.length > 0) {
    assert(artifactManifest, "Actions artifact API manifest is required");
    assert(runId && headSha, "Actions run identity is required");
    assert.equal(headSha, harnessSha, "Actions run head is not the reviewed harness");
    const hosted = validateSyncLockRootArtifactManifest(artifactManifest, actionNames, {
      id: runId, attempt: 1, headSha,
    }, campaign);
    artifacts = hosted.artifacts;
    jobs = hosted.jobs;
    actionsRun = hosted.run;
    for (const [name, admission] of hosted.admissions) admissions.set(name, admission);
  }
  const processTokens = new Set();
  const studies = expected.map((tuple) => {
    const selected = studiesByTuple.get(tuple);
    const admission = selected.admission ?? admissions.get(selected.name);
    return loadStudy(selected.directory, tuple, {
      campaign, candidateSha, harnessSha,
    }, admission, processTokens);
  });
  const comparisons = studies.map(analyzeSyncLockRootStudy);
  const sourceFailures = comparisons.filter(({ control, failed }) =>
    control === "source-comparison" && failed);
  const controlFailures = comparisons.filter(({ control, failed }) =>
    control !== "source-comparison" && failed);
  const complete = ALL_SURFACES.every((surface) => surfaces.includes(surface));
  return {
    schema: "fs-safe-sync-lock-root-analysis-v2",
    campaign,
    candidateSha,
    baselineSha: SYNC_LOCK_ROOT_BASE_SHA,
    harnessSha,
    surfaces: [...surfaces],
    gates: SYNC_LOCK_ROOT_GATES,
    comparisonCount: comparisons.length,
    comparisons,
    sourceFailures: sourceFailures.map(({ surface, node, order }) => ({ surface, node, order })),
    controlFailures: controlFailures.map(({ surface, node, order, control }) =>
      ({ surface, node, order, control })),
    jobs,
    artifacts,
    actionsRun,
    wsl2Captures: wsl2Captures.map(({ archiveValidation, outer, remote, state }) =>
      ({ archiveValidation, outer, remote, state })),
    complete,
    releaseClearance: complete && sourceFailures.length === 0 && controlFailures.length === 0,
    passed: sourceFailures.length === 0 && controlFailures.length === 0,
    receiptHash: digest(stableJson({
      campaign, candidateSha, baselineSha: SYNC_LOCK_ROOT_BASE_SHA, harnessSha, surfaces,
      gates: SYNC_LOCK_ROOT_GATES, comparisons, jobs, artifacts, actionsRun,
      wsl2Captures: wsl2Captures.map(({ archiveValidation, outer, remote, state }) =>
        ({ archiveValidation, outer, remote, state })),
    })),
  };
}
