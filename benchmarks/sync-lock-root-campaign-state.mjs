import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SYNC_LOCK_ROOT_BASE_SHA,
  SYNC_LOCK_ROOT_CAMPAIGN_SCHEMA,
  SYNC_LOCK_ROOT_CRABBOX_TIMING_SCHEMA,
  SYNC_LOCK_ROOT_HOSTED_CLOCK_POLICY,
  SYNC_LOCK_ROOT_REPOSITORY,
  SYNC_LOCK_ROOT_WORKFLOW_PATH,
  validateSyncLockRootCampaign,
} from "./sync-lock-root-contract.mjs";

export const WSL2_STATE_ROOT_DIRECTORY = "artifacts-sync-lock-root-state-v1";
export const WSL2_STATE_ROOT_POLICY = `repository/${WSL2_STATE_ROOT_DIRECTORY}`;
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function exactFields(name, value, fields) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), [...fields].sort(), `${name} field set mismatch`);
}

function timestamp(name, value) {
  assert.equal(typeof value, "string", `${name} timestamp is missing`);
  assert.match(value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u,
    `${name} timestamp is not RFC3339`);
  const observed = Date.parse(value);
  assert(Number.isFinite(observed), `${name} timestamp is invalid`);
  return observed;
}

function assertReceipt(name, receipt) {
  exactFields(name, receipt, ["sha256", "size"]);
  assert.match(receipt.sha256, SHA256, `${name} hash is invalid`);
  assert(Number.isSafeInteger(receipt.size) && receipt.size > 0, `${name} size is invalid`);
}

export function stateFileReceipt(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n,
    `campaign-state receipt is not a private regular file: ${file}`);
  if (process.platform !== "win32") {
    assert.equal(Number(stat.mode & 0o777n), 0o600, `campaign-state file mode is not 0600: ${file}`);
  }
  const bytes = fs.readFileSync(file);
  assert(bytes.length > 0, `campaign-state file is empty: ${file}`);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

function assertPrivateDirectory(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink(),
    `campaign-state directory is not real: ${directory}`);
  const canonical = fs.realpathSync.native(directory);
  const expected = path.resolve(directory);
  assert.equal(process.platform === "win32" ? canonical.toLowerCase() : canonical,
    process.platform === "win32" ? expected.toLowerCase() : expected,
    `campaign-state directory is aliased: ${directory}`);
  if (process.platform !== "win32") {
    assert.equal(Number(stat.mode & 0o777n), 0o700,
      `campaign-state directory mode is not 0700: ${directory}`);
  }
}

function statePaths(repositoryRoot, campaignId) {
  assert.match(campaignId, UUID_V4, "campaign-state campaign ID is invalid");
  const root = path.join(fs.realpathSync.native(repositoryRoot), WSL2_STATE_ROOT_DIRECTORY);
  const directory = path.join(root, campaignId);
  return {
    root,
    directory,
    campaign: path.join(directory, "campaign-state.json"),
    consumption: (node) => path.join(directory, `node-${node}-consumption.json`),
    result: (node) => path.join(directory, `node-${node}-result.json`),
  };
}

function exactCampaign(options) {
  return validateSyncLockRootCampaign({
    schema: SYNC_LOCK_ROOT_CAMPAIGN_SCHEMA,
    id: options.campaignId,
    actions: {
      repository: SYNC_LOCK_ROOT_REPOSITORY,
      workflowDatabaseId: options.workflowDatabaseId,
      workflowPath: SYNC_LOCK_ROOT_WORKFLOW_PATH,
      harnessSha: options.harnessSha,
      workflowFileSha256: options.workflowFileSha256,
      expectedActionsRunNumber: Number(options.expectedActionsRunNumber),
      runAttempt: 1,
      initializedAt: options.campaignInitializedAt,
      clockPolicy: SYNC_LOCK_ROOT_HOSTED_CLOCK_POLICY,
    },
    captures: { "22": options.node22Capture, "24": options.node24Capture },
    crabbox: {
      timingSchema: SYNC_LOCK_ROOT_CRABBOX_TIMING_SCHEMA,
      version: options.crabboxVersion,
    },
  });
}

function validateSourceOptions(options) {
  assert.match(options.candidateSha, SHA1, "campaign-state candidate SHA is invalid");
  assert.match(options.harnessSha, SHA1, "campaign-state harness SHA is invalid");
  assert.notEqual(options.candidateSha, SYNC_LOCK_ROOT_BASE_SHA,
    "campaign-state candidate equals the baseline");
  return exactCampaign(options);
}

function validateCampaignStateRecord(state, expectedCampaign = null) {
  exactFields("campaign state", state, [
    "schema", "stateRootPolicy", "campaign", "candidateSha", "baselineSha", "harnessSha",
    "createdAt",
  ]);
  assert.equal(state.schema, "fs-safe-sync-lock-root-campaign-state-v1");
  assert.equal(state.stateRootPolicy, WSL2_STATE_ROOT_POLICY);
  validateSyncLockRootCampaign(state.campaign);
  if (expectedCampaign) assert.deepEqual(state.campaign, expectedCampaign);
  assert.match(state.candidateSha, SHA1, "campaign-state candidate SHA is invalid");
  assert.notEqual(state.candidateSha, SYNC_LOCK_ROOT_BASE_SHA,
    "campaign-state candidate equals the baseline");
  assert.equal(state.baselineSha, SYNC_LOCK_ROOT_BASE_SHA);
  assert.match(state.harnessSha, SHA1, "campaign-state harness SHA is invalid");
  assert.equal(state.harnessSha, state.campaign.actions.harnessSha,
    "campaign-state harness differs from its hosted binding");
  timestamp("campaign-state creation", state.createdAt);
  assert.equal(state.createdAt, state.campaign.actions.initializedAt,
    "campaign-state creation time differs from its hosted binding");
  return state;
}

function validateConsumptionRecord(consumption, state, node, campaignReceipt) {
  exactFields("capture consumption", consumption, [
    "schema", "stateRootPolicy", "campaign", "candidateSha", "baselineSha", "harnessSha",
    "node", "captureToken", "startedAt", "outputRootHash", "campaignState",
    "priorNode22Result",
  ]);
  assert.equal(consumption.schema, "fs-safe-sync-lock-root-capture-consumption-v1");
  assert.equal(consumption.stateRootPolicy, WSL2_STATE_ROOT_POLICY);
  assert.deepEqual(consumption.campaign, state.campaign);
  for (const field of ["candidateSha", "baselineSha", "harnessSha"]) {
    assert.equal(consumption[field], state[field], `capture consumption ${field} mismatch`);
  }
  assert.equal(consumption.node, node);
  assert.equal(consumption.captureToken, state.campaign.captures[node]);
  timestamp("capture consumption", consumption.startedAt);
  assert.match(consumption.outputRootHash, SHA256, "capture output-root hash is invalid");
  assert.deepEqual(consumption.campaignState, campaignReceipt,
    "capture consumption campaign-state receipt mismatch");
  if (node === "22") assert.equal(consumption.priorNode22Result, null);
  else assertReceipt("capture prior Node 22 result", consumption.priorNode22Result);
  return consumption;
}

function validateResultRecord(result, state, node, campaignReceipt, consumptionReceipt) {
  exactFields("capture result", result, [
    "schema", "stateRootPolicy", "campaign", "node", "captureToken", "accepted",
    "campaignState", "consumption", "outerReceipt", "finishedAt",
  ]);
  assert.equal(result.schema, "fs-safe-sync-lock-root-capture-state-v1");
  assert.equal(result.stateRootPolicy, WSL2_STATE_ROOT_POLICY);
  assert.deepEqual(result.campaign, state.campaign);
  assert.equal(result.node, node);
  assert.equal(result.captureToken, state.campaign.captures[node]);
  assert.equal(typeof result.accepted, "boolean");
  assert.deepEqual(result.campaignState, campaignReceipt);
  assert.deepEqual(result.consumption, consumptionReceipt);
  if (result.outerReceipt === null) assert.equal(result.accepted, false);
  else assertReceipt("capture result outer receipt", result.outerReceipt);
  timestamp("capture result completion", result.finishedAt);
  return result;
}

function readCampaignState(paths, options) {
  assertPrivateDirectory(paths.root);
  assertPrivateDirectory(paths.directory);
  stateFileReceipt(paths.campaign);
  const expectedCampaign = validateSourceOptions(options);
  const state = validateCampaignStateRecord(
    JSON.parse(fs.readFileSync(paths.campaign, "utf8")), expectedCampaign,
  );
  assert.equal(state.candidateSha, options.candidateSha);
  assert.equal(state.baselineSha, SYNC_LOCK_ROOT_BASE_SHA);
  assert.equal(state.harnessSha, options.harnessSha);
  return { expectedCampaign, state };
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export function initializeWsl2CampaignState(options) {
  assert.equal(options.campaignInitializedAt, options.now,
    "campaign hosted identity was not initialized with the state record");
  const campaign = validateSourceOptions(options);
  timestamp("campaign-state creation", options.now);
  const paths = statePaths(options.repositoryRoot, campaign.id);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.root, 0o700);
  assertPrivateDirectory(paths.root);
  fs.mkdirSync(paths.directory, { mode: 0o700 });
  assertPrivateDirectory(paths.directory);
  writePrivateJson(paths.campaign, {
    schema: "fs-safe-sync-lock-root-campaign-state-v1",
    stateRootPolicy: WSL2_STATE_ROOT_POLICY,
    campaign,
    candidateSha: options.candidateSha,
    baselineSha: SYNC_LOCK_ROOT_BASE_SHA,
    harnessSha: options.harnessSha,
    createdAt: options.now,
  });
  return paths;
}

export function consumeWsl2CampaignCapture(options) {
  assert(options.node === "22" || options.node === "24", "capture-state Node is invalid");
  const paths = statePaths(options.repositoryRoot, options.campaignId);
  const { expectedCampaign, state } = readCampaignState(paths, options);
  const token = expectedCampaign.captures[options.node];
  const consumptionFile = paths.consumption(options.node);
  const campaignReceipt = stateFileReceipt(paths.campaign);
  const consumptionTime = timestamp("capture consumption", options.now);
  assert(consumptionTime >= timestamp("campaign-state creation", state.createdAt),
    "capture consumption predates campaign initialization");
  assert.equal(fs.existsSync(paths.result(options.node)), false,
    "campaign capture already has a terminal state");
  let priorNode22Result = null;
  if (options.node === "24") {
    const priorFile = paths.result("22");
    const priorConsumptionFile = paths.consumption("22");
    const priorConsumptionReceipt = stateFileReceipt(priorConsumptionFile);
    validateConsumptionRecord(JSON.parse(fs.readFileSync(priorConsumptionFile, "utf8")),
      state, "22", campaignReceipt);
    const priorReceipt = stateFileReceipt(priorFile);
    const prior = validateResultRecord(JSON.parse(fs.readFileSync(priorFile, "utf8")),
      state, "22", campaignReceipt, priorConsumptionReceipt);
    assert.equal(prior.accepted, true, "Node 22 was not successfully admitted");
    assert.notEqual(prior.outerReceipt, null, "Node 22 has no admitted outer receipt");
    assert(consumptionTime >= timestamp("Node 22 completion", prior.finishedAt),
      "Node 24 consumption predates Node 22 admission");
    priorNode22Result = priorReceipt;
  }
  assertPrivateDirectory(options.outputRoot);
  const outputRoot = fs.realpathSync.native(options.outputRoot);
  writePrivateJson(consumptionFile, {
    schema: "fs-safe-sync-lock-root-capture-consumption-v1",
    stateRootPolicy: WSL2_STATE_ROOT_POLICY,
    campaign: expectedCampaign,
    candidateSha: state.candidateSha,
    baselineSha: state.baselineSha,
    harnessSha: state.harnessSha,
    node: options.node,
    captureToken: token,
    startedAt: options.now,
    outputRootHash: createHash("sha256").update(outputRoot).digest("hex"),
    campaignState: campaignReceipt,
    priorNode22Result,
  });
  return { paths, consumptionFile };
}

export function completeWsl2CampaignCapture(options) {
  assert(options.node === "22" || options.node === "24", "capture-state Node is invalid");
  assert(Number.isSafeInteger(options.finalizerStatus) && options.finalizerStatus >= 0 &&
    options.finalizerStatus <= 255, "capture-state finalizer status is invalid");
  const completionTime = timestamp("capture result completion", options.now);
  const paths = statePaths(options.repositoryRoot, options.campaignId);
  assertPrivateDirectory(paths.root);
  assertPrivateDirectory(paths.directory);
  const campaignReceipt = stateFileReceipt(paths.campaign);
  const state = validateCampaignStateRecord(JSON.parse(fs.readFileSync(paths.campaign, "utf8")));
  assert.equal(state.campaign.id, options.campaignId);
  const consumptionFile = paths.consumption(options.node);
  const consumptionReceipt = stateFileReceipt(consumptionFile);
  const consumption = validateConsumptionRecord(
    JSON.parse(fs.readFileSync(consumptionFile, "utf8")),
    state, options.node, campaignReceipt,
  );
  assert(completionTime >= timestamp("capture consumption", consumption.startedAt),
    "capture completion predates token consumption");
  let outer = null;
  let outerReceipt = null;
  if (fs.existsSync(options.outerFile)) {
    outer = JSON.parse(fs.readFileSync(options.outerFile, "utf8"));
    outerReceipt = stateFileReceipt(options.outerFile);
    assert.equal(outer.schema, "fs-safe-sync-lock-root-crabbox-outer-v1",
      "outer receipt schema mismatch");
    assert.equal(typeof outer.accepted, "boolean", "outer receipt status is invalid");
    assert.deepEqual(outer.campaign, state.campaign, "outer receipt campaign mismatch");
    assert.equal(outer.node, options.node, "outer receipt Node mismatch");
    assert.equal(outer.captureToken, consumption.captureToken, "outer receipt token mismatch");
    assert.deepEqual(outer.state, {
      campaign: campaignReceipt,
      consumption: consumptionReceipt,
    }, "outer receipt state binding mismatch");
    if (outer.accepted) {
      assert.equal(outer.candidateSha, state.candidateSha, "outer receipt candidate mismatch");
      assert.equal(outer.baselineSha, state.baselineSha, "outer receipt baseline mismatch");
      assert.equal(outer.harnessSha, state.harnessSha, "outer receipt harness mismatch");
    }
  }
  const resultFile = paths.result(options.node);
  writePrivateJson(resultFile, {
    schema: "fs-safe-sync-lock-root-capture-state-v1",
    stateRootPolicy: WSL2_STATE_ROOT_POLICY,
    campaign: state.campaign,
    node: options.node,
    captureToken: consumption.captureToken,
    accepted: options.finalizerStatus === 0 && outer?.accepted === true,
    campaignState: campaignReceipt,
    consumption: consumptionReceipt,
    outerReceipt,
    finishedAt: options.now,
  });
  return { paths, resultFile };
}

function parseArguments(argv) {
  const command = argv[2];
  const options = {};
  for (let index = 3; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    assert(name?.startsWith("--") && value !== undefined, "campaign-state options require pairs");
    assert.equal(options[name.slice(2)], undefined, `duplicate campaign-state option: ${name}`);
    options[name.slice(2)] = value;
  }
  return { command, options };
}

function sourceOptions(values) {
  return {
    repositoryRoot: process.cwd(),
    candidateSha: values.candidate,
    harnessSha: values.harness,
    campaignId: values["campaign-id"],
    node22Capture: values["node-22-capture"],
    node24Capture: values["node-24-capture"],
    crabboxVersion: values["crabbox-version"],
    workflowDatabaseId: values["workflow-database-id"],
    workflowFileSha256: values["workflow-file-sha256"],
    expectedActionsRunNumber: values["expected-actions-run-number"],
    campaignInitializedAt: values["campaign-initialized-at"],
  };
}

function main() {
  try {
    const { command, options } = parseArguments(process.argv);
    if (command === "initialize") {
      assert.deepEqual(Object.keys(options).sort(), [
        "campaign-id", "candidate", "crabbox-version", "expected-actions-run-number", "harness",
        "node-22-capture", "node-24-capture", "now", "workflow-database-id",
        "workflow-file-sha256",
      ], "initialize option set mismatch");
      initializeWsl2CampaignState({
        ...sourceOptions({ ...options, "campaign-initialized-at": options.now }), now: options.now,
      });
    } else if (command === "consume") {
      assert.deepEqual(Object.keys(options).sort(), [
        "campaign-id", "campaign-initialized-at", "candidate", "crabbox-version",
        "expected-actions-run-number", "harness", "node", "node-22-capture", "node-24-capture",
        "now", "output-root", "workflow-database-id", "workflow-file-sha256",
      ], "consume option set mismatch");
      consumeWsl2CampaignCapture({
        ...sourceOptions(options), node: options.node,
        outputRoot: options["output-root"], now: options.now,
      });
    } else if (command === "complete") {
      assert.deepEqual(Object.keys(options).sort(), [
        "campaign-id", "finalizer-status", "node", "now", "outer",
      ], "complete option set mismatch");
      assert.match(options["finalizer-status"], /^\d+$/u, "finalizer status is invalid");
      completeWsl2CampaignCapture({
        repositoryRoot: process.cwd(), campaignId: options["campaign-id"],
        node: options.node, outerFile: path.resolve(options.outer), now: options.now,
        finalizerStatus: Number(options["finalizer-status"]),
      });
    } else {
      assert.fail("expected initialize, consume, or complete campaign-state command");
    }
  } catch (error) {
    process.stderr.write(`sync lockRoot campaign state failed: ${
      error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
