import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { analyzeSyncLockRootCampaign } from "./sync-lock-root-analysis.mjs";
import {
  SYNC_LOCK_ROOT_CAMPAIGN_SCHEMA,
  SYNC_LOCK_ROOT_CRABBOX_TIMING_SCHEMA,
  SYNC_LOCK_ROOT_HOSTED_CLOCK_POLICY,
  SYNC_LOCK_ROOT_REPOSITORY,
  SYNC_LOCK_ROOT_WORKFLOW_PATH,
} from "./sync-lock-root-contract.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    assert(name?.startsWith("--") && value !== undefined, "analyzer options require name/value pairs");
    const key = name.slice(2);
    assert.equal(options[key], undefined, `duplicate analyzer option: ${name}`);
    options[key] = value;
  }
  for (const name of [
    "root", "candidate-sha", "harness-sha", "campaign-id", "node-22-capture",
    "node-24-capture", "crabbox-version", "workflow-database-id", "workflow-file-sha256",
    "expected-actions-run-number", "campaign-initialized-at", "surfaces", "output",
  ]) {
    assert(options[name], `missing --${name}`);
  }
  const allowed = new Set([
    "root", "manifest", "candidate-sha", "harness-sha", "campaign-id", "node-22-capture",
    "node-24-capture", "crabbox-version", "workflow-database-id", "workflow-file-sha256",
    "expected-actions-run-number", "campaign-initialized-at", "surfaces", "run-id", "head-sha",
    "output",
  ]);
  for (const name of Object.keys(options)) assert(allowed.has(name), `unknown analyzer option: --${name}`);
  return options;
}

let output;
try {
  const options = parseArguments(process.argv);
  output = path.resolve(options.output);
  assert.equal(fs.existsSync(output), false, "analysis output already exists");
  const artifactManifest = options.manifest
    ? JSON.parse(fs.readFileSync(path.resolve(options.manifest), "utf8")) : null;
  const receipt = analyzeSyncLockRootCampaign({
    artifactRoot: path.resolve(options.root),
    artifactManifest,
    candidateSha: options["candidate-sha"],
    harnessSha: options["harness-sha"],
    campaign: {
      schema: SYNC_LOCK_ROOT_CAMPAIGN_SCHEMA,
      id: options["campaign-id"],
      actions: {
        repository: SYNC_LOCK_ROOT_REPOSITORY,
        workflowDatabaseId: options["workflow-database-id"],
        workflowPath: SYNC_LOCK_ROOT_WORKFLOW_PATH,
        harnessSha: options["harness-sha"],
        workflowFileSha256: options["workflow-file-sha256"],
        expectedActionsRunNumber: Number(options["expected-actions-run-number"]),
        runAttempt: 1,
        initializedAt: options["campaign-initialized-at"],
        clockPolicy: SYNC_LOCK_ROOT_HOSTED_CLOCK_POLICY,
      },
      captures: {
        "22": options["node-22-capture"],
        "24": options["node-24-capture"],
      },
      crabbox: {
        timingSchema: SYNC_LOCK_ROOT_CRABBOX_TIMING_SCHEMA,
        version: options["crabbox-version"],
      },
    },
    surfaces: options.surfaces.split(","),
    runId: options["run-id"] ?? null,
    headSha: options["head-sha"] ?? null,
  });
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  if (!receipt.passed) process.exitCode = 1;
} catch (error) {
  if (output && !fs.existsSync(output)) {
    const failed = {
      schema: "fs-safe-sync-lock-root-analysis-v2",
      passed: false,
      releaseClearance: false,
      failure: { kind: "validation" },
    };
    fs.writeFileSync(output, `${JSON.stringify(failed, null, 2)}\n`, { flag: "wx" });
  }
  process.stderr.write(`sync lockRoot analysis failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
