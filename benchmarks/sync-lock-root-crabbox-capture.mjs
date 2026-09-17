import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileReceipt, remoteFileManifest } from "./sync-lock-root-capture-files.mjs";
import { normalizeCrabboxTiming } from "./sync-lock-root-provenance.mjs";
import { validateSyncLockRootCampaign } from "./sync-lock-root-contract.mjs";
import { validateImmutableHarness } from "./sync-lock-root-harness-integrity.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    assert(name?.startsWith("--") && value !== undefined,
      "capture finalizer options require name/value pairs");
    const key = name.slice(2);
    assert.equal(options[key], undefined, `duplicate capture finalizer option: ${name}`);
    options[key] = value;
  }
  const expected = [
    "clock", "timing", "wrapper-log", "archive", "archive-validation", "crabbox-version",
    "campaign-state", "consumption", "remote", "output", "repository-root", "harness-sha",
    "executed-capture",
  ];
  assert.deepEqual(Object.keys(options).sort(), expected.sort(), "capture finalizer option set mismatch");
  const result = Object.fromEntries(Object.entries(options).map(([key, value]) => [
    key, key === "harness-sha" ? value : path.resolve(value),
  ]));
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function exactClock(clock) {
  assert.deepEqual(Object.keys(clock ?? {}).sort(), [
    "campaign", "captureToken", "extractionExitCode", "finishedAt", "node",
    "schema", "startedAt", "validationExitCode", "wrapperExitCode",
  ], "outer clock field set mismatch");
  assert.equal(clock.schema, "fs-safe-sync-lock-root-capture-clock-v1",
    "outer clock schema mismatch");
  validateSyncLockRootCampaign(clock.campaign);
  assert(["22", "24"].includes(clock.node), "outer clock Node major is invalid");
  assert.equal(clock.captureToken, clock.campaign.captures[clock.node],
    "outer clock capture token mismatch");
  assert(Number.isSafeInteger(clock.wrapperExitCode), "outer wrapper exit code is invalid");
  assert(Number.isSafeInteger(clock.validationExitCode), "outer validation exit code is invalid");
  assert(Number.isSafeInteger(clock.extractionExitCode), "outer extraction exit code is invalid");
  return clock;
}

function fileReceipts(options) {
  return {
    archive: fileReceipt(options.archive),
    archiveValidation: fileReceipt(options["archive-validation"]),
    clock: fileReceipt(options.clock),
    crabboxVersion: fileReceipt(options["crabbox-version"]),
    timing: fileReceipt(options.timing),
    wrapperLog: fileReceipt(options["wrapper-log"]),
  };
}

let output;
try {
  const options = parseArguments(process.argv);
  output = options.output;
  assert.equal(fs.existsSync(output), false, "outer capture receipt already exists");
  const harnessIntegrity = validateImmutableHarness(
    options["repository-root"], options["harness-sha"], options["executed-capture"],
  );
  const clock = exactClock(readJson(options.clock));
  const files = fileReceipts(options);
  const state = {
    campaign: fileReceipt(options["campaign-state"]),
    consumption: fileReceipt(options.consumption),
  };
  const remoteFiles = remoteFileManifest(options.remote);
  let receipt;
  try {
    assert.equal(clock.wrapperExitCode, 0, "outer Crabbox invocation failed");
    assert.equal(clock.validationExitCode, 0, "outer archive validation failed");
    assert.equal(clock.extractionExitCode, 0, "outer archive extraction failed");
    const archiveValidation = readJson(options["archive-validation"]);
    assert.equal(archiveValidation?.accepted, true, "outer archive was not admitted");
    assert.deepEqual(archiveValidation.archive, files.archive,
      "archive validation did not bind the captured archive");
    const crabboxVersion = fs.readFileSync(options["crabbox-version"], "utf8").replace(/\n$/u, "");
    assert.equal(crabboxVersion, clock.campaign.crabbox.version,
      "captured Crabbox version differs from the campaign binding");
    const crabbox = normalizeCrabboxTiming(readJson(options.timing));
    assert.equal(crabbox.exitCode, clock.wrapperExitCode, "Crabbox and shell exit status disagree");
    const remoteReceiptPath = path.join(options.remote, `wsl2-remote-receipt-node-${clock.node}.json`);
    const remote = readJson(remoteReceiptPath);
    receipt = {
      schema: "fs-safe-sync-lock-root-crabbox-outer-v1",
      accepted: true,
      campaign: clock.campaign,
      node: clock.node,
      captureToken: clock.captureToken,
      candidateSha: remote.candidateSha,
      baselineSha: remote.baselineSha,
      harnessSha: remote.harnessSha,
      crabboxVersion,
      timingSchema: clock.campaign.crabbox.timingSchema,
      archiveValidation,
      clock,
      crabbox,
      files,
      state,
      tempRoot: remote.host?.tempRoot,
      remoteFiles,
      captureScriptSha256: harnessIntegrity.executedCapture.sha256,
      harnessIntegrity,
    };
  } catch {
    receipt = {
      schema: "fs-safe-sync-lock-root-crabbox-outer-v1",
      accepted: false,
      campaign: clock.campaign,
      node: clock.node,
      captureToken: clock.captureToken,
      clock,
      files,
      state,
      remoteFiles,
      harnessIntegrity,
      failure: { kind: "capture" },
    };
  }
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (!receipt.accepted) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `sync lockRoot outer capture finalization failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
