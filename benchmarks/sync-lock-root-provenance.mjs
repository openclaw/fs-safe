import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  SYNC_LOCK_ROOT_BASE_SHA,
  validateSyncLockRootCampaign,
} from "./sync-lock-root-contract.mjs";
import { WSL2_STATE_ROOT_POLICY } from "./sync-lock-root-campaign-state.mjs";
import {
  fileReceipt,
  remoteFileManifest,
} from "./sync-lock-root-capture-files.mjs";
import {
  createImmutableHarnessManifest,
  SYNC_LOCK_ROOT_CAPTURE_PATH,
  SYNC_LOCK_ROOT_LANE_PATH,
  SYNC_LOCK_ROOT_WORKFLOW_PATH,
  validateHarnessIntegrityManifest,
} from "./sync-lock-root-harness-integrity.mjs";
import { SYNC_LOCK_ROOT_TAR_LIMITS } from "./sync-lock-root-tar.mjs";
export {
  fileReceipt,
  remoteFileManifest,
  sha256,
} from "./sync-lock-root-capture-files.mjs";
export {
  createImmutableHarnessManifest,
  SYNC_LOCK_ROOT_CAPTURE_PATH,
  SYNC_LOCK_ROOT_LANE_PATH,
  SYNC_LOCK_ROOT_REQUIRED_HARNESS_PATHS,
} from "./sync-lock-root-harness-integrity.mjs";
export { validateSyncLockRootArtifactManifest } from "./sync-lock-root-hosted-provenance.mjs";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9._-]+$/u;
const ORDERS = Object.freeze(["abba", "baab"]);
const CONTROLS = Object.freeze(["source-comparison", "same-source-rebuild", "same-artifact"]);
const NODES = Object.freeze(["22", "24"]);
function instant(name, value) {
  assert.equal(typeof value, "string", `${name} timestamp is missing`);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u
    .exec(value);
  assert(match, `${name} timestamp is not RFC3339`);
  if (match[3] !== "Z") {
    const [hours, minutes] = match[3].slice(1).split(":").map(Number);
    assert(hours <= 23 && minutes <= 59, `${name} timestamp offset is invalid`);
  }
  const fraction = match[2] ? `.${match[2].padEnd(3, "0").slice(0, 3)}` : "";
  const observed = Date.parse(`${match[1]}${fraction}${match[3]}`);
  assert(Number.isFinite(observed), `${name} timestamp is invalid`);
  return observed;
}

function assertWindow(name, value, start, end) {
  const observed = instant(name, value);
  assert(observed >= instant(`${name} window start`, start) &&
    observed <= instant(`${name} window end`, end), `${name} falls outside its admitted window`);
}

function assertReceipt(name, actual, expected) {
  assert.deepEqual(actual, expected, `${name} receipt mismatch`);
}

function assertFields(name, value, fields) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), [...fields].sort(), `${name} field set mismatch`);
}

function assertFileReceipt(name, receipt) {
  assert.deepEqual(Object.keys(receipt ?? {}).sort(), ["sha256", "size"],
    `${name} file-receipt fields mismatch`);
  assert.match(receipt.sha256, SHA256, `${name} file-receipt hash is invalid`);
  assert(Number.isSafeInteger(receipt.size) && receipt.size > 0,
    `${name} file-receipt size is invalid`);
}

export function normalizeCrabboxTiming(timing) {
  const id = timing?.leaseId ?? timing?.id;
  if (timing?.leaseId !== undefined && timing?.id !== undefined) {
    assert.equal(timing.leaseId, timing.id, "Crabbox timing provider IDs disagree");
  }
  assert.equal(timing?.provider, "ssh", "WSL2 capture did not use the controlled SSH provider");
  assert.match(id ?? "", TOKEN, "Crabbox timing output has no actual provider id");
  assert(timing?.syncDelegated === undefined || typeof timing.syncDelegated === "boolean",
    "Crabbox timing syncDelegated has the wrong type");
  const syncDelegated = timing.syncDelegated ?? false;
  assert.equal(syncDelegated, false, "static WSL2 capture cannot be delegated");
  assert(Number.isSafeInteger(timing?.exitCode), "Crabbox timing exit code is invalid");
  for (const field of ["commandMs", "totalMs"]) {
    assert(Number.isFinite(timing?.[field]) && timing[field] >= 0,
      `Crabbox timing ${field} is invalid`);
  }
  assert(timing.totalMs >= timing.commandMs, "Crabbox total time is shorter than command time");
  return {
    provider: timing.provider,
    id,
    syncDelegated,
    exitCode: timing.exitCode,
    commandMs: timing.commandMs,
    totalMs: timing.totalMs,
  };
}

export function validateReportExecutionWindow(report, admission) {
  assert(admission, "report has no admitted execution window");
  if (admission.kind === "github-actions") {
    assertWindow("worker report", report.metadata?.date,
      admission.job.startedAt, admission.job.upload.startedAt);
    assert.deepEqual(report.methodAuditEvidence?.runtime?.jobApi, {
      id: String(admission.job.id),
      name: admission.job.name,
      startedAt: admission.job.startedAt,
    }, "worker report API job identity mismatch");
    return;
  }
  assert.equal(report.methodAuditEvidence?.runtime?.jobApi, null,
    "WSL2 report contains a hosted job identity");
  assertWindow("WSL2 worker report", report.metadata?.date,
    admission.remote.startedAt, admission.remote.finishedAt);
  assert.deepEqual(report.methodAuditEvidence?.runtime?.wsl2, {
    captureToken: admission.remote.captureToken,
    filesystemDevice: admission.remote.host.filesystemDevice,
    filesystemType: admission.remote.host.filesystemType,
    hostIdentityHash: admission.remote.host.identityHash,
    kernelRelease: admission.remote.host.kernelRelease,
    versionReceiptHash: admission.remote.host.versionReceiptHash,
    tempRoot: admission.remote.host.tempRoot,
  }, "WSL2 worker host receipt mismatch");
}

function integrityFile(manifest, relative) {
  const file = manifest.files.find(({ path: candidate }) => candidate === relative);
  assert(file, `harness integrity omits ${relative}`);
  return file;
}

function validateOuterCapture(capture, campaign, candidateSha, harnessSha, harnessIntegrity) {
  const { outer, timing, clock, remote, state } = capture;
  assert.equal(outer?.schema, "fs-safe-sync-lock-root-crabbox-outer-v1",
    "WSL2 outer capture schema mismatch");
  assert.equal(outer.accepted, true, "WSL2 outer capture did not complete successfully");
  assert.deepEqual(outer.campaign, campaign, "WSL2 outer campaign binding mismatch");
  assert(NODES.includes(outer.node), "WSL2 outer Node major is invalid");
  assert.equal(outer.captureToken, campaign.captures[outer.node],
    "WSL2 outer capture token mismatch");
  assert.equal(outer.candidateSha, candidateSha, "WSL2 outer candidate SHA mismatch");
  assert.equal(outer.baselineSha, SYNC_LOCK_ROOT_BASE_SHA, "WSL2 outer baseline SHA mismatch");
  assert.equal(outer.harnessSha, harnessSha, "WSL2 outer harness SHA mismatch");
  assert.equal(outer.crabboxVersion, campaign.crabbox.version,
    "WSL2 captured Crabbox version mismatch");
  assert.equal(outer.timingSchema, campaign.crabbox.timingSchema,
    "WSL2 Crabbox TimingReport schema binding mismatch");
  assert.deepEqual(outer.harnessIntegrity, harnessIntegrity,
    "WSL2 retained harness-integrity manifest mismatch");
  assert.deepEqual(outer.archiveValidation, capture.archiveValidation,
    "WSL2 archive-validation receipt mismatch");
  assert.equal(capture.archiveValidation?.schema, "fs-safe-sync-lock-root-tar-validation-v1",
    "WSL2 archive-validation schema mismatch");
  assertFields("WSL2 archive validation", capture.archiveValidation, [
    "schema", "accepted", "archive", "entries", "totalFileBytes", "limits",
  ]);
  assert.equal(capture.archiveValidation?.accepted, true, "WSL2 archive was not admitted");
  assert.deepEqual(capture.archiveValidation.archive, outer.files?.archive,
    "WSL2 archive validation did not bind the captured archive");
  assert.deepEqual(capture.archiveValidation.limits, SYNC_LOCK_ROOT_TAR_LIMITS,
    "WSL2 archive validation limits mismatch");
  assert(Number.isSafeInteger(capture.archiveValidation.entries) &&
    capture.archiveValidation.entries > 0 &&
    capture.archiveValidation.entries <= SYNC_LOCK_ROOT_TAR_LIMITS.entries,
  "WSL2 archive validation entry count is invalid");
  assert(Number.isSafeInteger(capture.archiveValidation.totalFileBytes) &&
    capture.archiveValidation.totalFileBytes > 0 &&
    capture.archiveValidation.totalFileBytes <= SYNC_LOCK_ROOT_TAR_LIMITS.totalFileBytes,
  "WSL2 archive validation byte count is invalid");
  assert.equal(outer.captureScriptSha256,
    integrityFile(harnessIntegrity, SYNC_LOCK_ROOT_CAPTURE_PATH).sha256,
    "WSL2 outer capture script hash mismatch");
  assert.deepEqual(outer.clock, clock, "WSL2 outer clock receipt mismatch");
  assert.equal(clock.schema, "fs-safe-sync-lock-root-capture-clock-v1",
    "WSL2 outer clock schema mismatch");
  assertFields("WSL2 outer clock", clock, [
    "schema", "campaign", "node", "captureToken", "startedAt", "finishedAt",
    "wrapperExitCode", "validationExitCode", "extractionExitCode",
  ]);
  assert.deepEqual(clock.campaign, campaign, "WSL2 outer clock campaign mismatch");
  assert.equal(clock.node, outer.node, "WSL2 outer clock Node mismatch");
  assert.equal(clock.captureToken, outer.captureToken, "WSL2 outer clock token mismatch");
  assert.equal(clock.wrapperExitCode, 0, "outer Crabbox invocation failed");
  assert.equal(clock.validationExitCode, 0, "outer archive validation failed");
  assert.equal(clock.extractionExitCode, 0, "outer archive extraction failed");
  assertWindow("outer completion", clock.finishedAt, clock.startedAt, clock.finishedAt);
  const normalizedTiming = normalizeCrabboxTiming(timing);
  assert.deepEqual(outer.crabbox, normalizedTiming, "outer Crabbox timing normalization mismatch");
  assert.equal(normalizedTiming.exitCode, clock.wrapperExitCode,
    "outer and Crabbox exit status disagree");
  assert(instant("outer completion", clock.finishedAt) -
    instant("outer start", clock.startedAt) >= normalizedTiming.totalMs,
  "outer clock is shorter than Crabbox's measured duration");
  assert.equal(remote.schema, "fs-safe-sync-lock-root-crabbox-remote-v2",
    "WSL2 remote receipt schema mismatch");
  assertFields("WSL2 remote receipt", remote, [
    "schema", "campaign", "candidateSha", "baselineSha", "harnessSha", "node",
    "captureToken", "startedAt", "finishedAt", "host", "laneScriptSha256", "artifacts",
  ]);
  assert.deepEqual(remote.campaign, campaign, "WSL2 remote campaign binding mismatch");
  for (const field of ["candidateSha", "baselineSha", "harnessSha", "node", "captureToken"]) {
    assert.equal(remote[field], outer[field], `WSL2 remote ${field} mismatch`);
  }
  // Remote and wrapper clocks can belong to different machines. Validate each
  // clock's ordering independently; do not invent cross-host clock agreement.
  assertWindow("remote completion", remote.finishedAt, remote.startedAt, remote.finishedAt);
  assert.match(remote.host?.identityHash ?? "", SHA256, "WSL2 host identity is invalid");
  assert.match(remote.host?.versionReceiptHash ?? "", SHA256, "WSL2 version receipt is invalid");
  assert.match(remote.host?.kernelRelease ?? "", /microsoft.*wsl2/iu,
    "native WSL2 kernel receipt is invalid");
  assert.match(remote.host?.filesystemDevice ?? "", /^[0-9]+$/u,
    "WSL2 filesystem device receipt is invalid");
  assert.equal(typeof remote.host?.filesystemType, "string", "WSL2 filesystem type is missing");
  assert(remote.host.filesystemType.length > 0 && remote.host.filesystemType.length <= 64 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(remote.host.filesystemType),
  "WSL2 filesystem type receipt is invalid");
  const tempRoot = remote.host?.tempRoot;
  assert.deepEqual(Object.keys(tempRoot ?? {}).sort(), [
    "device", "environment", "filesystemType", "path", "realPath", "statfsType",
  ], "WSL2 pinned temp-root receipt fields mismatch");
  assert.equal(typeof tempRoot.path, "string", "WSL2 pinned temp-root path is invalid");
  assert(tempRoot.path.startsWith("/") && tempRoot.path.length <= 4_096 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(tempRoot.path),
  "WSL2 pinned temp-root path is not an absolute WSL path");
  assert.equal(tempRoot.path, tempRoot.realPath, "WSL2 pinned temp root is not canonical");
  assert.deepEqual(tempRoot.environment, {
    TMPDIR: tempRoot.path, TMP: tempRoot.path, TEMP: tempRoot.path,
  }, "WSL2 pinned temp environment mismatch");
  assert.equal(tempRoot.device, remote.host.filesystemDevice,
    "WSL2 pinned temp root changed filesystem device");
  assert.equal(tempRoot.filesystemType, remote.host.filesystemType,
    "WSL2 pinned temp root changed filesystem type");
  assert.match(tempRoot.statfsType ?? "", /^-?[0-9]+$/u,
    "WSL2 pinned temp statfs type is invalid");
  assert.deepEqual(outer.tempRoot, tempRoot, "WSL2 outer temp-root receipt mismatch");
  assert.equal(remote.laneScriptSha256,
    integrityFile(harnessIntegrity, SYNC_LOCK_ROOT_LANE_PATH).sha256,
    "WSL2 lane script hash mismatch");
  const expectedArtifacts = ORDERS.flatMap((order) => CONTROLS.map((control) =>
    `sync-lock-root-wsl2-node-${outer.node}-${order}-${control}-${outer.captureToken}-1`));
  assert.deepEqual(remote.artifacts, expectedArtifacts, "WSL2 remote artifact set mismatch");
  assert.equal(state?.campaign?.schema, "fs-safe-sync-lock-root-campaign-state-v1",
    "WSL2 campaign-state schema mismatch");
  assertFields("WSL2 campaign state", state.campaign, [
    "schema", "stateRootPolicy", "campaign", "candidateSha", "baselineSha", "harnessSha",
    "createdAt",
  ]);
  assert.equal(state.campaign.stateRootPolicy, WSL2_STATE_ROOT_POLICY,
    "WSL2 campaign-state root policy mismatch");
  assert.deepEqual(state.campaign.campaign, campaign, "WSL2 campaign-state binding mismatch");
  for (const field of ["candidateSha", "baselineSha", "harnessSha"]) {
    assert.equal(state.campaign[field], outer[field], `WSL2 campaign-state ${field} mismatch`);
  }
  assertWindow("campaign-state creation", state.campaign.createdAt,
    state.campaign.createdAt, state.campaign.createdAt);
  assert.equal(state.consumption?.schema, "fs-safe-sync-lock-root-capture-consumption-v1",
    "WSL2 capture-consumption schema mismatch");
  assertFields("WSL2 capture consumption", state.consumption, [
    "schema", "stateRootPolicy", "campaign", "candidateSha", "baselineSha", "harnessSha",
    "node", "captureToken", "startedAt", "outputRootHash", "campaignState",
    "priorNode22Result",
  ]);
  assert.equal(state.consumption.stateRootPolicy, WSL2_STATE_ROOT_POLICY,
    "WSL2 capture-consumption state-root mismatch");
  for (const field of ["campaign", "candidateSha", "baselineSha", "harnessSha", "node", "captureToken"]) {
    assert.deepEqual(state.consumption[field], field === "campaign" ? campaign : outer[field],
      `WSL2 capture-consumption ${field} mismatch`);
  }
  assert.match(state.consumption.outputRootHash ?? "", SHA256,
    "WSL2 capture output-root hash is invalid");
  assertWindow("capture consumption", state.consumption.startedAt,
    state.campaign.createdAt, clock.startedAt);
  assertReceipt("capture-consumption campaign-state", state.consumption.campaignState,
    outer.state?.campaign);
  assert.equal(state.result?.schema, "fs-safe-sync-lock-root-capture-state-v1",
    "WSL2 capture-state result schema mismatch");
  assertFields("WSL2 capture result", state.result, [
    "schema", "stateRootPolicy", "campaign", "node", "captureToken", "accepted",
    "campaignState", "consumption", "outerReceipt", "finishedAt",
  ]);
  assert.equal(state.result.stateRootPolicy, WSL2_STATE_ROOT_POLICY,
    "WSL2 capture-state result state-root mismatch");
  assert.equal(state.result.accepted, true, "WSL2 consumed capture did not finish successfully");
  for (const field of ["campaign", "node", "captureToken"]) {
    assert.deepEqual(state.result[field], field === "campaign" ? campaign : outer[field],
      `WSL2 capture-state result ${field} mismatch`);
  }
  assertReceipt("capture-state campaign", state.result.campaignState, outer.state?.campaign);
  assertReceipt("capture-state consumption", state.result.consumption, outer.state?.consumption);
  assertFileReceipt("capture-state outer receipt", state.result.outerReceipt);
  assertWindow("capture-state completion", state.result.finishedAt,
    clock.finishedAt, state.result.finishedAt);
  return { ...capture, actual: normalizedTiming };
}

export function validateWsl2CaptureCohort(
  captures, campaign, candidateSha, harnessSha,
  harnessIntegrity = createImmutableHarnessManifest(path.resolve(import.meta.dirname, ".."), harnessSha),
) {
  validateSyncLockRootCampaign(campaign);
  validateHarnessIntegrityManifest(harnessIntegrity);
  assert.equal(harnessIntegrity.harnessSha, harnessSha,
    "harness-integrity commit differs from the WSL2 campaign");
  assert.match(candidateSha, SHA1, "WSL2 candidate SHA is invalid");
  assert.match(harnessSha, SHA1, "WSL2 harness SHA is invalid");
  assert.equal(campaign.actions.harnessSha, harnessSha,
    "WSL2 campaign hosted harness binding mismatch");
  assert.equal(integrityFile(harnessIntegrity, SYNC_LOCK_ROOT_WORKFLOW_PATH).sha256,
    campaign.actions.workflowFileSha256,
  "WSL2 campaign workflow bytes differ from the immutable harness");
  assert.deepEqual(captures.map(({ outer }) => outer.node), ["22", "24"],
    "WSL2 capture set or order mismatch");
  const validated = captures.map((capture) =>
    validateOuterCapture(capture, campaign, candidateSha, harnessSha, harnessIntegrity));
  const [node22, node24] = validated;
  assert(instant("Node 22 outer completion", node22.clock.finishedAt) <=
    instant("Node 24 outer start", node24.clock.startedAt),
  "WSL2 captures overlap or were selectively reordered");
  assert.equal(node22.state.consumption.priorNode22Result, null,
    "Node 22 capture unexpectedly has a prior-capture receipt");
  assertReceipt("shared fixed campaign state",
    node24.outer.state.campaign, node22.outer.state.campaign);
  assert.deepEqual(node24.state.campaign, node22.state.campaign,
    "WSL2 fixed campaign-state record changed between captures");
  assertReceipt("Node 24 prior Node 22 result",
    node24.state.consumption.priorNode22Result, node22.state.resultFileReceipt);
  assert(instant("Node 22 state completion", node22.state.result.finishedAt) <=
    instant("Node 24 consumption", node24.state.consumption.startedAt),
  "Node 24 was consumed before successful Node 22 admission");
  assert.equal(node22.state.consumption.outputRootHash,
    node24.state.consumption.outputRootHash, "WSL2 capture output root changed");
  for (const field of ["provider", "id", "syncDelegated"]) {
    assert.equal(node22.actual[field], node24.actual[field], `WSL2 Crabbox ${field} changed`);
  }
  for (const field of [
    "identityHash", "filesystemDevice", "filesystemType", "kernelRelease", "versionReceiptHash",
  ]) {
    assert.equal(node22.remote.host[field], node24.remote.host[field],
      `WSL2 controlled host ${field} changed`);
  }
  for (const field of ["device", "filesystemType", "statfsType"]) {
    assert.equal(node22.remote.host.tempRoot[field], node24.remote.host.tempRoot[field],
      `WSL2 pinned temp-root ${field} changed`);
  }
  return validated;
}

export function validateCampaignCellSet(actual, surfaces) {
  const expected = surfaces.flatMap((surface) => NODES.flatMap((node) =>
    ORDERS.flatMap((order) => CONTROLS.map((control) =>
      `${surface}|${node}|${order}|${control}`))));
  assert.deepEqual([...actual].sort(), expected.sort(),
    "campaign study matrix is incomplete or contains an extra study");
  return expected;
}

export function assertCaptureFileReceipts(captureDirectory, outer) {
  const expected = {
    archive: fileReceipt(path.join(captureDirectory, "archive.tar.gz")),
    archiveValidation: fileReceipt(path.join(captureDirectory, "archive-validation.json")),
    clock: fileReceipt(path.join(captureDirectory, "capture-clock.json")),
    crabboxVersion: fileReceipt(path.join(captureDirectory, "crabbox-version.txt")),
    timing: fileReceipt(path.join(captureDirectory, "crabbox-timing.json")),
    wrapperLog: fileReceipt(path.join(captureDirectory, "wrapper.stderr")),
  };
  assertReceipt("outer capture files", outer.files, expected);
  assertReceipt("outer campaign-state file", outer.state?.campaign,
    fileReceipt(path.join(captureDirectory, "campaign-state.json")));
  assertReceipt("outer capture-consumption file", outer.state?.consumption,
    fileReceipt(path.join(captureDirectory, "capture-consumption.json")));
  assert.deepEqual(outer.remoteFiles, remoteFileManifest(path.join(captureDirectory, "remote")),
    "outer remote-content manifest mismatch");
}

function readJson(file) {
  const bytes = fs.readFileSync(file);
  assert(bytes.length > 0 && bytes.length <= 64 * 1024 * 1024, `${file} size is invalid`);
  return JSON.parse(bytes.toString("utf8"));
}

export function loadWsl2CaptureDirectories(artifactRoot, required, campaign, candidateSha, harnessSha) {
  const names = fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("wsl2-capture-node-"))
    .map(({ name }) => name).sort();
  if (!required) {
    assert.deepEqual(names, [], "non-WSL2 cohort contains an outer capture directory");
    return [];
  }
  assert.deepEqual(names, ["wsl2-capture-node-22", "wsl2-capture-node-24"],
    "WSL2 outer capture directory set is incomplete");
  const captures = names.map((name) => {
    const directory = path.join(artifactRoot, name);
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      "archive-validation.json", "archive.tar.gz", "campaign-state.json",
      "capture-clock.json", "capture-consumption.json", "capture-state-receipt.json",
      "crabbox-timing.json", "crabbox-version.txt", "outer-receipt.json", "remote",
      "wrapper.stderr",
    ], "WSL2 outer capture file set mismatch");
    const outer = readJson(path.join(directory, "outer-receipt.json"));
    const clock = readJson(path.join(directory, "capture-clock.json"));
    const timing = readJson(path.join(directory, "crabbox-timing.json"));
    const archiveValidation = readJson(path.join(directory, "archive-validation.json"));
    assertCaptureFileReceipts(directory, outer);
    assert.equal(fs.readFileSync(path.join(directory, "crabbox-version.txt"), "utf8"),
      `${campaign.crabbox.version}\n`, "captured Crabbox version file mismatch");
    const state = {
      campaign: readJson(path.join(directory, "campaign-state.json")),
      consumption: readJson(path.join(directory, "capture-consumption.json")),
      result: readJson(path.join(directory, "capture-state-receipt.json")),
      resultFileReceipt: fileReceipt(path.join(directory, "capture-state-receipt.json")),
    };
    assertReceipt("capture-state outer receipt", state.result.outerReceipt,
      fileReceipt(path.join(directory, "outer-receipt.json")));
    const remoteRoot = path.join(directory, "remote");
    const node = name.endsWith("22") ? "22" : "24";
    const remoteReceiptName = `wsl2-remote-receipt-node-${node}.json`;
    const remote = readJson(path.join(remoteRoot, remoteReceiptName));
    assert.deepEqual(fs.readdirSync(remoteRoot).sort(), [
      ...remote.artifacts, remoteReceiptName,
    ].sort(), "WSL2 extracted remote file set mismatch");
    const studies = Object.fromEntries(remote.artifacts.map((artifact) => [
      artifact, path.join(remoteRoot, artifact),
    ]));
    return { archiveValidation, clock, directory, outer, remote, state, studies, timing };
  });
  return validateWsl2CaptureCohort(captures, campaign, candidateSha, harnessSha);
}
