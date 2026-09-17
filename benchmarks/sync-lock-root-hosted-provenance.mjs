import assert from "node:assert/strict";
import { validateSyncLockRootCampaign } from "./sync-lock-root-contract.mjs";

const ARTIFACT_NAME = new RegExp(
  "^sync-lock-root-(linux|macos|windows)-node-(22|24)-(abba|baab)-" +
    "(source-comparison|same-source-rebuild|same-artifact)-([A-Za-z0-9._-]+)-1$",
  "u",
);

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

function artifactIdentity(name, runId) {
  const match = ARTIFACT_NAME.exec(name);
  assert(match, `invalid hosted artifact name: ${name}`);
  assert.equal(match[5], String(runId), `hosted artifact run suffix mismatch: ${name}`);
  return { jobName: `${match[1]} / Node ${match[2]} / ${match[3]} / ${match[4]}` };
}

export function validateSyncLockRootArtifactManifest(manifest, expectedNames, run, campaign) {
  validateSyncLockRootCampaign(campaign);
  assert.equal(manifest?.schema, "fs-safe-sync-lock-root-artifacts-v3",
    "artifact API manifest schema mismatch");
  assert.deepEqual(Object.keys(manifest.run ?? {}).sort(), [
    "attempt", "campaign", "createdAt", "headSha", "id", "repository", "runNumber",
    "workflowDatabaseId", "workflowFileSha256", "workflowPath",
  ], "artifact API run field set mismatch");
  assert.equal(String(manifest.run.id), String(run.id), "artifact manifest run ID mismatch");
  assert.equal(String(manifest.run.attempt), "1", "artifact manifest is not a first attempt");
  assert.equal(manifest.run.headSha, run.headSha, "artifact manifest head SHA mismatch");
  assert.equal(manifest.run.headSha, campaign.actions.harnessSha,
    "artifact run head is not the predeclared harness");
  assert.deepEqual(manifest.run.campaign, campaign, "artifact campaign binding mismatch");
  assert.equal(manifest.run.repository, campaign.actions.repository,
    "artifact repository binding mismatch");
  assert.equal(String(manifest.run.workflowDatabaseId), campaign.actions.workflowDatabaseId,
    "artifact workflow database ID mismatch");
  assert.equal(manifest.run.workflowPath, campaign.actions.workflowPath,
    "artifact workflow path mismatch");
  assert.equal(manifest.run.runNumber, campaign.actions.expectedActionsRunNumber,
    "artifact Actions run number mismatch");
  assert.equal(manifest.run.workflowFileSha256, campaign.actions.workflowFileSha256,
    "artifact workflow byte hash mismatch");
  assert(instant("campaign initialization", campaign.actions.initializedAt) <=
    instant("Actions run creation", manifest.run.createdAt),
  "campaign state was initialized after the Actions run began");
  const expectedJobs = expectedNames.map((name) => artifactIdentity(name, run.id).jobName);
  const jobs = manifest.jobs ?? [];
  assert.deepEqual(jobs.map(({ name }) => name).sort(), [...expectedJobs].sort(),
    "artifact manifest job names mismatch");
  assert.equal(new Set(jobs.map(({ id }) => id)).size, jobs.length, "job IDs overlap");
  for (const job of jobs) {
    assert(Number.isSafeInteger(job.id) && job.id > 0, "job ID is invalid");
    assert.equal(job.status, "completed", "producer job is incomplete");
    assert.equal(job.conclusion, "success", "producer job failed");
    assert.equal(String(job.runId), String(run.id), "job belongs to another run");
    assert.equal(String(job.runAttempt), "1", "job is not from the first attempt");
    assert.equal(job.headSha, run.headSha, "job belongs to another head");
    assertWindow("job completion", job.completedAt, job.startedAt, job.completedAt);
    const upload = job.upload;
    assert.equal(upload?.name, "Upload exact first-attempt study artifact",
      "producer upload step name mismatch");
    assert(Number.isSafeInteger(upload?.number) && upload.number > 0,
      "producer upload step number is invalid");
    assert.equal(upload?.status, "completed", "producer upload step is incomplete");
    assert.equal(upload?.conclusion, "success", "producer upload step failed");
    assertWindow("upload start", upload.startedAt, job.startedAt, job.completedAt);
    assertWindow("upload completion", upload.completedAt, upload.startedAt, job.completedAt);
  }
  const artifacts = manifest.artifacts ?? [];
  assert.equal(artifacts.length, expectedNames.length, "artifact API set is incomplete");
  assert.deepEqual(artifacts.map(({ name }) => name).sort(), [...expectedNames].sort(),
    "artifact API names mismatch");
  const admissions = new Map();
  for (const artifact of artifacts) {
    assert(Number.isSafeInteger(artifact.id) && artifact.id > 0, "artifact ID is invalid");
    assert.match(artifact.digest, /^sha256:[0-9a-f]{64}$/u, "artifact digest is invalid");
    assert(Number.isSafeInteger(artifact.size) && artifact.size > 0, "artifact size is invalid");
    assert.equal(artifact.expired, false, "artifact is expired");
    assert.equal(String(artifact.runId), String(run.id), "artifact belongs to another run");
    assert.equal(artifact.headSha, run.headSha, "artifact belongs to another head");
    const job = jobs.find(({ id }) => id === artifact.producerJobId);
    assert(job, "artifact producer API job ID is not admitted");
    assert.equal(job.name, artifactIdentity(artifact.name, run.id).jobName,
      "artifact producer job tuple mismatch");
    assertWindow("artifact creation", artifact.createdAt, job.upload.startedAt, job.upload.completedAt);
    assertWindow("artifact update", artifact.updatedAt, artifact.createdAt, job.upload.completedAt);
    admissions.set(artifact.name, { kind: "github-actions", artifact, job });
  }
  assert.equal(new Set(artifacts.map(({ id }) => id)).size, artifacts.length,
    "artifact IDs overlap");
  return { admissions, artifacts, jobs, run: manifest.run };
}
