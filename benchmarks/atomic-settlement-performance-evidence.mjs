import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertAtomicSettlementPerformanceBinding,
  createAtomicSettlementPerformanceManifest,
  expectedAtomicSettlementRawReports,
  validateAtomicSettlementArtifactUploadWindow,
  validateAtomicSettlementRegistrationStub,
  validateAtomicSettlementPerformanceCampaign,
  validateAtomicSettlementPerformanceManifest,
  validateAtomicSettlementPerformanceRunApi,
} from "./atomic-settlement-performance-campaign.mjs";
import {
  validateCompleteReportSet,
  validatePlanHash,
} from "./method-audit-plan.mjs";
import {
  assertCapturedFlatDirectoryHash,
  assertExactZipExtraction,
} from "./exact-artifact-zip.mjs";

const WORKFLOW = ".github/workflows/atomic-settlement-performance.yml";
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEAL_REF = /^refs\/tags\/atomic-settlement-performance-h-([0-9a-f]{40})$/u;
const ARTIFACT = /^atomic-settlement-(linux|macos|windows)-node-(22|24)-(abba|baab)-(source-comparison|same-source-rebuild|same-artifact)-([1-9][0-9]*)-1$/u;
const MAIN_REPOSITORY = "https://github.com/openclaw/fs-safe.git";
const MAIN_REF = "refs/heads/main";
const DIRECTORY_HASH_SCHEMA = "typed-path-size-content-v1";

function fail(message) { throw new Error(message); }

function args(argv) {
  const command = argv[2];
  if (!command || !["prepare", "verify", "analyze", "finalize"].includes(command)) {
    fail("expected prepare, verify, analyze, or finalize");
  }
  const options = {};
  for (let index = 3; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail("options must be --name value pairs");
    const name = flag.slice(2);
    if (name in options) fail(`duplicate option ${flag}`);
    options[name] = value;
  }
  return { command, options };
}

function exactOptions(options, expected) {
  assert.deepEqual(Object.keys(options).sort(), [...expected].sort(),
    `expected options: ${expected.map((name) => `--${name}`).join(", ")}`);
}

function exactKeys(value, expected, context) {
  assert(value && typeof value === "object", `${context} is required`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(),
    `${context} fields changed`);
}

function assertReceipt(value, context) {
  exactKeys(value, ["sha256", "size", "dev", "ino", "mtimeNs"], context);
  assert.match(value.sha256, SHA256, `${context} hash is invalid`);
  assert(Number.isSafeInteger(value.size) && value.size > 0, `${context} size is invalid`);
  for (const field of ["dev", "ino", "mtimeNs"]) {
    assert.match(value[field], /^[0-9]+$/u, `${context} ${field} is invalid`);
  }
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function fileHash(file) { return sha256(fs.readFileSync(file)); }

function positiveDecimal(value, context) {
  assert.match(value ?? "", /^[1-9][0-9]*$/u, `${context} is invalid`);
  const number = Number(value);
  assert(Number.isSafeInteger(number), `${context} is invalid`);
  return number;
}

function git(root, parameters, { buffer = false } = {}) {
  const result = spawnSync("git", ["--no-replace-objects", "-C", root, ...parameters], {
    encoding: buffer ? undefined : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) fail(`git ${parameters[0]} failed: ${result.stderr?.toString().trim()}`);
  return buffer ? result.stdout : result.stdout.trim();
}

function tracked(root, commit, file) {
  return git(root, ["show", `${commit}:${file}`], { buffer: true });
}

function source(root, commit) {
  const resolved = git(root, ["rev-parse", "--verify", `${commit}^{commit}`]);
  assert.equal(resolved, commit, `${commit} did not resolve exactly`);
  return {
    commit,
    tree: git(root, ["rev-parse", `${commit}^{tree}`]),
    manifestSha256: sha256(tracked(root, commit, "package.json")),
    lockfileSha256: sha256(tracked(root, commit, "pnpm-lock.yaml")),
  };
}

function observeMainTip(root, binding) {
  const output = git(root, ["ls-remote", "--exit-code", MAIN_REPOSITORY, MAIN_REF]);
  const match = /^([0-9a-f]{40})\trefs\/heads\/main$/u.exec(output);
  assert(match, "authoritative main-tip response is invalid");
  assert.equal(match[1], binding.registrationCommit,
    "main moved from the reviewed registration commit");
  return {
    repository: MAIN_REPOSITORY,
    ref: MAIN_REF,
    commit: match[1],
    observedAt: new Date().toISOString(),
  };
}

function observeHarnessSeal(root, sealRef, harnessCommit) {
  const seal = SEAL_REF.exec(sealRef);
  assert(seal, "harness seal ref is invalid");
  assert.match(harnessCommit ?? "", SHA1, "expected H is not a full commit hash");
  assert.equal(seal[1], harnessCommit, "harness seal name does not bind H");
  const output = git(root, ["ls-remote", "--exit-code", MAIN_REPOSITORY, sealRef]);
  const match = /^([0-9a-f]{40})\t(refs\/tags\/[^\n]+)$/u.exec(output);
  assert(match, "authoritative harness-seal response is invalid");
  assert.equal(match[2], sealRef, "authoritative harness-seal ref changed");
  assert.equal(match[1], harnessCommit, "authoritative harness seal does not resolve to H");
  return {
    repository: MAIN_REPOSITORY,
    ref: sealRef,
    commit: match[1],
    observedAt: new Date().toISOString(),
  };
}

function verifyRegistrationHistory(root, binding, harnessCommit) {
  git(root, ["merge-base", "--is-ancestor", binding.registrationCommit, harnessCommit]);
  git(root, ["merge-base", "--is-ancestor", binding.baselineCommit,
    binding.candidateCommit]);
  git(root, ["merge-base", "--is-ancestor", binding.candidateCommit, harnessCommit]);
  const registrationBytes = tracked(
    root,
    binding.registrationCommit,
    binding.registrationWorkflowPath,
  );
  validateAtomicSettlementRegistrationStub(registrationBytes);
  assert.equal(sha256(registrationBytes),
    binding.registrationWorkflowSha256,
    "default-main registration workflow bytes do not match the reviewed stub");
}

function verifyRemoteBindings(root, manifest) {
  const binding = assertAtomicSettlementPerformanceBinding();
  verifyRegistrationHistory(root, binding, manifest.harness.commit);
  const seal = observeHarnessSeal(root, manifest.harnessSeal.ref, manifest.harness.commit);
  assert.equal(seal.repository, manifest.harnessSeal.repository,
    "harness seal repository changed");
  assert.equal(seal.ref, manifest.harnessSeal.ref, "harness seal ref changed");
  assert.equal(seal.commit, manifest.harnessSeal.commit, "harness seal moved before acceptance");
  const current = observeMainTip(root, binding);
  assert.equal(current.repository, manifest.mainTip.repository, "main repository changed");
  assert.equal(current.ref, manifest.mainTip.ref, "main ref changed");
  assert.equal(current.commit, manifest.mainTip.commit, "main moved before campaign acceptance");
}

function benchmarkHash(root) {
  const hash = createHash("sha256");
  const directory = path.join(root, "benchmarks");
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".mjs")).sort()) {
    hash.update(name).update(fs.readFileSync(path.join(directory, name)));
  }
  for (const name of ["package.json", "pnpm-lock.yaml"]) {
    hash.update(fs.readFileSync(path.join(root, name)));
  }
  return hash.digest("hex");
}

function harnessFileInventory(root, commit) {
  const benchmarkNames = git(root, ["ls-tree", "--name-only", `${commit}:benchmarks`])
    .split(/\r?\n/u).filter((name) => name.endsWith(".mjs")).sort();
  const paths = [
    WORKFLOW,
    "package.json",
    "pnpm-lock.yaml",
    ...benchmarkNames.map((name) => `benchmarks/${name}`),
  ];
  return paths.map((file) => {
    const bytes = tracked(root, commit, file);
    return { path: file, sha256: sha256(bytes), size: bytes.length };
  });
}

function prepare(options) {
  exactOptions(options, [
    "harness-root", "harness", "harness-seal-ref", "candidate", "baseline",
    "expected-run-number", "expected-run-attempt", "run-id", "run-number", "run-attempt",
    "dispatch-repository", "dispatch-event", "dispatch-ref", "dispatch-ref-protected",
    "dispatch-ref-type", "dispatch-workflow-ref", "dispatch-workflow-sha",
    "dispatch-event-sha", "run-api", "output",
  ]);
  const root = path.resolve(options["harness-root"]);
  const binding = assertAtomicSettlementPerformanceBinding();
  const head = git(root, ["rev-parse", "HEAD"]);
  assert.equal(head, options.harness, "harness checkout does not match H");
  assert.equal(options.candidate, binding.candidateCommit,
    "C does not match the reviewed candidate binding");
  assert.equal(options.baseline, binding.baselineCommit,
    "B must be the exact reviewed pre-fix baseline commit");
  const runNumber = positiveDecimal(options["run-number"], "campaign run number");
  const expectedRunNumber = positiveDecimal(options["expected-run-number"],
    "predeclared campaign run number");
  const runAttempt = positiveDecimal(options["run-attempt"], "campaign run attempt");
  const expectedRunAttempt = positiveDecimal(options["expected-run-attempt"],
    "predeclared campaign run attempt");
  assert.equal(runNumber, expectedRunNumber, "campaign run number was not predeclared exactly");
  assert.equal(expectedRunAttempt, 1, "campaign must predeclare run attempt 1");
  assert.equal(runAttempt, expectedRunAttempt, "campaign run attempt was not predeclared exactly");
  assert.equal(options["dispatch-repository"], "openclaw/fs-safe",
    "campaign dispatch repository changed");
  assert.equal(options["dispatch-event"], "workflow_dispatch",
    "campaign dispatch event changed");
  assert.equal(options["dispatch-ref-protected"], "true",
    "campaign harness seal ref is not protected");
  assert.equal(options["dispatch-ref-type"], "tag", "campaign dispatch ref is not a tag");
  assert.equal(options["dispatch-ref"], options["harness-seal-ref"],
    "campaign dispatch ref does not match the predeclared harness seal");
  assert.equal(options["dispatch-workflow-ref"],
    `openclaw/fs-safe/${WORKFLOW}@${options["harness-seal-ref"]}`,
    "campaign workflow ref does not match the sealed workflow");
  assert.equal(options["dispatch-workflow-sha"], options.harness,
    "campaign workflow SHA does not match H");
  assert.equal(options["dispatch-event-sha"], options.harness,
    "campaign event SHA does not match H");
  verifyRegistrationHistory(root, binding, options.harness);
  const harnessSeal = observeHarnessSeal(root, options["harness-seal-ref"], options.harness);
  const admittedRunApi = readJson(path.resolve(options["run-api"]));
  validateAtomicSettlementPerformanceRunApi(admittedRunApi, {
    repository: "openclaw/fs-safe", runId: options["run-id"], runNumber, runAttempt,
    createdAt: admittedRunApi.created_at, harnessCommit: options.harness,
    sealRef: harnessSeal.ref,
  });
  const harnessSource = source(root, options.harness);
  const manifest = createAtomicSettlementPerformanceManifest({
    repository: "openclaw/fs-safe",
    run: {
      id: options["run-id"], number: runNumber, attempt: runAttempt,
      createdAt: admittedRunApi.created_at,
    },
    dispatch: {
      repository: options["dispatch-repository"],
      eventName: options["dispatch-event"],
      ref: options["dispatch-ref"],
      refProtected: options["dispatch-ref-protected"] === "true",
      refType: options["dispatch-ref-type"],
      workflowRef: options["dispatch-workflow-ref"],
      workflowSha: options["dispatch-workflow-sha"],
      eventSha: options["dispatch-event-sha"],
      expectedHarnessSha: options.harness,
      expectedRunNumber,
      expectedRunAttempt,
    },
    harness: {
      commit: harnessSource.commit,
      tree: harnessSource.tree,
      workflowSha256: sha256(tracked(root, options.harness, WORKFLOW)),
      benchmarkSha256: benchmarkHash(root),
      manifestSha256: harnessSource.manifestSha256,
      lockfileSha256: harnessSource.lockfileSha256,
      fileInventory: harnessFileInventory(root, options.harness),
    },
    harnessSeal,
    binding,
    mainTip: observeMainTip(root, binding),
    candidate: source(root, options.candidate),
    baseline: source(root, options.baseline),
  });
  validateAtomicSettlementPerformanceManifest(manifest);
  fs.writeFileSync(path.resolve(options.output), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `manifest_sha256=${fileHash(path.resolve(options.output))}\n`);
  }
}

function loadManifest(file, expectedHash) {
  assert.match(expectedHash, SHA256, "expected manifest file hash is invalid");
  assert.equal(fileHash(file), expectedHash, "campaign manifest file hash changed");
  return validateAtomicSettlementPerformanceManifest(JSON.parse(fs.readFileSync(file, "utf8")));
}

function verifyHarness(root, manifest) {
  assert.equal(git(root, ["rev-parse", "HEAD"]), manifest.harness.commit,
    "harness checkout commit changed");
  assert.equal(git(root, ["rev-parse", "HEAD^{tree}"]), manifest.harness.tree,
    "harness checkout tree changed");
  assert.equal(fileHash(path.join(root, WORKFLOW)), manifest.harness.workflowSha256,
    "workflow bytes changed");
  assert.equal(benchmarkHash(root), manifest.harness.benchmarkSha256,
    "benchmark harness bytes changed");
  assert.equal(fileHash(path.join(root, "package.json")), manifest.harness.manifestSha256,
    "harness package manifest changed");
  assert.equal(fileHash(path.join(root, "pnpm-lock.yaml")), manifest.harness.lockfileSha256,
    "harness lockfile changed");
  assert.deepEqual(harnessFileInventory(root, manifest.harness.commit),
    manifest.harness.fileInventory, "tracked harness file inventory changed");
  for (const entry of manifest.harness.fileInventory) {
    assert.equal(fileHash(path.join(root, entry.path)), entry.sha256,
      `checked-out harness file changed: ${entry.path}`);
  }
  assert.equal(git(root, ["status", "--porcelain=v1", "--untracked-files=no"]), "",
    "harness checkout has tracked changes");
}

function verify(options) {
  exactOptions(options, ["manifest", "manifest-file-hash", "harness-root"]);
  const manifest = loadManifest(path.resolve(options.manifest), options["manifest-file-hash"]);
  const root = path.resolve(options["harness-root"]);
  verifyHarness(root, manifest);
  verifyRemoteBindings(root, manifest);
}

function receipt(file) {
  const handle = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    assert(before.isFile() && before.size > 0n && before.size <= 256n * 1024n * 1024n,
      `${file} is not a bounded evidence file`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (read === 0) fail(`short read: ${file}`);
      offset += read;
    }
    const after = fs.fstatSync(handle, { bigint: true });
    assert.equal(before.dev, after.dev, `${file} device changed`);
    assert.equal(before.ino, after.ino, `${file} inode changed`);
    assert.equal(before.size, after.size, `${file} size changed`);
    assert.equal(before.mtimeNs, after.mtimeNs, `${file} mtime changed`);
    const pathname = fs.lstatSync(file, { bigint: true });
    assert(pathname.isFile() && pathname.nlink === 1n,
      `${file} pathname identity is unsafe`);
    assert.equal(pathname.dev, after.dev, `${file} pathname device changed`);
    assert.equal(pathname.ino, after.ino, `${file} pathname inode changed`);
    return {
      bytes,
      receipt: {
        sha256: sha256(bytes),
        size: bytes.length,
        dev: String(after.dev),
        ino: String(after.ino),
        mtimeNs: String(after.mtimeNs),
      },
    };
  } finally {
    fs.closeSync(handle);
  }
}

function directoryHash(root) {
  const hash = createHash("sha256");
  const walk = (directory, relativeDirectory = "") => {
    const names = fs.readdirSync(directory).sort();
    for (const name of names) {
      const file = path.join(directory, name);
      const relative = path.join(relativeDirectory, name).split(path.sep).join("/");
      const stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), `artifact contains a link: ${relative}`);
      if (stat.isDirectory()) {
        hash.update("directory\0").update(relative).update("\0");
        walk(file, relative);
      }
      else {
        assert(stat.isFile(), `artifact contains an unsupported entry: ${relative}`);
        assert.equal(BigInt(stat.nlink), 1n, `artifact contains a hardlinked file: ${relative}`);
        const captured = receipt(file);
        hash.update("file\0").update(relative).update("\0")
          .update(String(captured.bytes.length)).update("\0").update(captured.bytes);
      }
    }
    assert.deepEqual(fs.readdirSync(directory).sort(), names,
      `artifact directory changed while hashing: ${relativeDirectory || "."}`);
  };
  walk(root);
  return hash.digest("hex");
}

function readJson(file) {
  return JSON.parse(receipt(file).bytes.toString("utf8"));
}

function readJsonWithReceipt(file) {
  const captured = receipt(file);
  return {
    value: JSON.parse(captured.bytes.toString("utf8")),
    receipt: captured.receipt,
  };
}

function artifactApiRecord(api, name, manifest) {
  const matches = api.artifacts.filter((artifact) => artifact.name === name);
  assert.equal(matches.length, 1, `artifact API identity mismatch: ${name}`);
  const artifact = matches[0];
  assert.equal(artifact.expired, false, `${name} expired before validation`);
  assert(Number.isSafeInteger(artifact.id) && artifact.id > 0,
    `${name} artifact ID is invalid`);
  assert(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0,
    `${name} artifact size is invalid`);
  assert.match(artifact.digest ?? "", /^sha256:[0-9a-f]{64}$/u,
    `${name} artifact digest is invalid`);
  assert(Number.isFinite(Date.parse(artifact.created_at)) &&
    Number.isFinite(Date.parse(artifact.updated_at)), `${name} artifact timestamps are invalid`);
  assert.equal(String(artifact.workflow_run?.id), manifest.run.id, `${name} run ID changed`);
  assert.equal(artifact.workflow_run?.head_sha, manifest.harness.commit, `${name} head SHA changed`);
  return artifact;
}

function jobApiRecord(api, displayName, manifest, uploadStepName) {
  const matches = api.jobs.filter((job) => job.name === displayName);
  assert.equal(matches.length, 1, `job API identity mismatch: ${displayName}`);
  const job = matches[0];
  assert.equal(job.status, "completed", `${displayName} did not complete`);
  assert.equal(job.conclusion, "success", `${displayName} did not succeed`);
  assert(Number.isSafeInteger(job.id) && job.id > 0, `${displayName} job ID is invalid`);
  assert.equal(String(job.run_id), manifest.run.id, `${displayName} run ID changed`);
  assert.equal(Number(job.run_attempt), manifest.run.attempt, `${displayName} attempt changed`);
  assert.equal(job.head_sha, manifest.harness.commit, `${displayName} head SHA changed`);
  assert(Number.isFinite(Date.parse(job.started_at)) &&
    Number.isFinite(Date.parse(job.completed_at)), `${displayName} job timestamps are invalid`);
  const matchesUpload = (job.steps ?? []).filter(({ name }) => name === uploadStepName);
  assert.equal(matchesUpload.length, 1, `${displayName} upload step identity is ambiguous`);
  const upload = matchesUpload[0];
  assert.equal(upload.status, "completed", `${displayName} upload step did not complete`);
  assert.equal(upload.conclusion, "success", `${displayName} upload step did not succeed`);
  assert(Number.isSafeInteger(upload.number) && upload.number > 0,
    `${displayName} upload step number is invalid`);
  assert(Number.isFinite(Date.parse(upload.started_at)) &&
    Number.isFinite(Date.parse(upload.completed_at)),
  `${displayName} upload step timestamps are invalid`);
  return { ...job, admittedUpload: upload };
}

function assertArtifactUploadBinding(artifact, job, context) {
  validateAtomicSettlementArtifactUploadWindow({
    jobStartedAt: job.started_at,
    jobCompletedAt: job.completed_at,
    uploadStartedAt: job.admittedUpload.started_at,
    uploadCompletedAt: job.admittedUpload.completed_at,
    artifactCreatedAt: artifact.created_at,
    artifactUpdatedAt: artifact.updated_at,
  }, context);
}

function assertSameReceiptContent(expected, actual, context) {
  assertReceipt(expected, `${context} recorded receipt`);
  assert.equal(actual.receipt.sha256, expected.sha256, `${context} hash changed`);
  assert.equal(actual.receipt.size, expected.size, `${context} size changed`);
}

function expectedMeasurementArtifactNames(manifest) {
  return [...new Set(expectedAtomicSettlementRawReports().map((entry) =>
    `atomic-settlement-${entry.platform}-node-${entry.node}-${entry.order}-${entry.study}-${manifest.run.id}-1`))]
    .sort();
}

function validateAnalysisSummary(analysis, manifest) {
  exactKeys(analysis, [
    "schema", "manifestSha256", "rawReportProcesses", "comparisonCells", "cells",
    "combinedOrders", "controlFailures", "sourceFailures", "accepted",
    "replacementPolicy", "actions",
  ], "aggregate analysis");
  assert.equal(analysis.schema, "fs-safe-atomic-settlement-performance-analysis-v1");
  assert.equal(analysis.manifestSha256, manifest.manifestSha256,
    "aggregate analysis manifest binding changed");
  assert.equal(analysis.rawReportProcesses, 1440, "aggregate raw-report count changed");
  assert.equal(analysis.comparisonCells, 216, "aggregate comparison-cell count changed");
  assert(Array.isArray(analysis.cells) && analysis.cells.length === 216,
    "aggregate comparison cells are incomplete");
  assert(Array.isArray(analysis.combinedOrders) && analysis.combinedOrders.length === 108,
    "aggregate combined-order cells are incomplete");
  assert.equal(analysis.cells.some(({ failed }) => failed), false,
    "aggregate analysis contains a failed ordered cell");
  assert.equal(analysis.combinedOrders.some(({ failed }) => failed), false,
    "aggregate analysis contains a failed combined-order cell");
  assert.equal(analysis.controlFailures, 0, "aggregate controls failed");
  assert.equal(analysis.sourceFailures, 0, "aggregate source comparison failed");
  assert.equal(analysis.accepted, true, "aggregate analysis did not accept the campaign");
  assert.equal(analysis.replacementPolicy,
    "A failed, incomplete, or rerun campaign may be replaced only in full.",
  "aggregate replacement policy changed");
  return analysis;
}

function planContract(plan, tuple, manifest, manifestFileHash) {
  validatePlanHash(plan);
  const [platform, node, order, study] = tuple;
  assert.equal(plan.repository, manifest.repository);
  assert.equal(plan.campaignManifestSha256, manifestFileHash,
    "study plan campaign-manifest binding changed");
  assert.equal(String(plan.run.id), manifest.run.id);
  assert.equal(plan.run.attempt, manifest.run.attempt);
  assert.equal(plan.harness.sha, manifest.harness.commit);
  assert.equal(plan.harness.tree, manifest.harness.tree);
  assert.equal(plan.harness.workflowRef, manifest.dispatch.workflowRef,
    "study plan workflow/ref binding changed");
  assert.equal(plan.harness.workflowPath, WORKFLOW);
  assert.equal(plan.harness.workflowFileHash, manifest.harness.workflowSha256);
  assert.equal(plan.harness.benchmarkHash, manifest.harness.benchmarkSha256);
  assert.equal(plan.settings.platform, platform);
  assert.equal(plan.settings.nodeVersion, node);
  assert.equal(plan.settings.order, order);
  assert.equal(plan.settings.controlKind, study);
  assert.equal(plan.settings.filter, "settlement/success");
  assert.equal(plan.settings.iterations, 200);
  assert.equal(plan.settings.samples, 9);
  assert.equal(plan.settings.blocks, 5);
  assert.equal(plan.settings.nativeMode, "both");
  assert.equal(plan.settings.timeoutMinutes, 120);
  assert.equal(plan.sources.candidate.commit, manifest.sources.candidate.commit);
  assert.equal(plan.sources.candidate.tree, manifest.sources.candidate.tree);
  assert.equal(plan.sources.candidate.manifestHash, manifest.sources.candidate.manifestSha256);
  assert.equal(plan.sources.candidate.lockfileHash, manifest.sources.candidate.lockfileSha256);
  const baseline = study === "source-comparison" ? manifest.sources.baseline : manifest.sources.candidate;
  assert.equal(plan.sources.baseline.commit, baseline.commit);
  assert.equal(plan.sources.baseline.tree, baseline.tree);
  assert.equal(plan.sources.baseline.manifestHash, baseline.manifestSha256);
  assert.equal(plan.sources.baseline.lockfileHash, baseline.lockfileSha256);
  assert.equal(plan.reports.length, 40, "study process count changed");
  return plan;
}

function analyze(options) {
  exactOptions(options, [
    "manifest", "manifest-file-hash", "harness-root", "artifact-root", "run-api",
    "artifacts-api", "jobs-api", "output",
  ]);
  const manifest = loadManifest(path.resolve(options.manifest), options["manifest-file-hash"]);
  const harnessRoot = path.resolve(options["harness-root"]);
  verifyHarness(harnessRoot, manifest);
  verifyRemoteBindings(harnessRoot, manifest);
  const runApiCapture = readJsonWithReceipt(path.resolve(options["run-api"]));
  const runApi = validateAtomicSettlementPerformanceRunApi(runApiCapture.value, {
    repository: manifest.repository, runId: manifest.run.id,
    runNumber: manifest.run.number, runAttempt: manifest.run.attempt,
    createdAt: manifest.run.createdAt, harnessCommit: manifest.harness.commit,
    sealRef: manifest.harnessSeal.ref,
  });
  const root = path.resolve(options["artifact-root"]);
  const artifactsApiCapture = readJsonWithReceipt(path.resolve(options["artifacts-api"]));
  const jobsApiCapture = readJsonWithReceipt(path.resolve(options["jobs-api"]));
  const artifactsApi = artifactsApiCapture.value;
  const jobsApi = jobsApiCapture.value;
  assert(Array.isArray(artifactsApi.artifacts), "artifact API response is invalid");
  assert(Array.isArray(jobsApi.jobs), "job API response is invalid");
  assert.equal(artifactsApi.total_count, artifactsApi.artifacts.length,
    "artifact API response is incomplete");
  assert.equal(jobsApi.total_count, jobsApi.jobs.length,
    "job API response is incomplete");
  const manifestArtifactName = `atomic-settlement-campaign-${manifest.run.id}-1`;
  const manifestArtifact = artifactApiRecord(artifactsApi, manifestArtifactName, manifest);
  const prepareJob = jobApiRecord(jobsApi, "Prepare immutable atomic settlement campaign",
    manifest, "Upload immutable campaign manifest");
  assertArtifactUploadBinding(manifestArtifact, prepareJob, "campaign manifest artifact");
  assert(Date.parse(manifest.run.createdAt) <= Date.parse(prepareJob.started_at),
    "campaign prepare job predates its admitted run");
  const entries = fs.readdirSync(root, { withFileTypes: true });
  assert.equal(entries.length, 36, "measurement artifact set is incomplete or unexpected");
  assert(entries.every((entry) => entry.isDirectory() && ARTIFACT.test(entry.name)),
    "measurement download contains an unexpected entry");
  const captures = [];
  const measurementProvenance = [];
  for (const entry of entries) {
    const match = ARTIFACT.exec(entry.name);
    assert(match, `unsafe artifact name: ${entry.name}`);
    const [, platform, node, order, study, runId] = match;
    assert.equal(runId, manifest.run.id, `${entry.name} run ID changed`);
    const directory = path.join(root, entry.name);
    const apiArtifact = artifactApiRecord(artifactsApi, entry.name, manifest);
    const displayName = `Measure atomic settlement (${platform}, ${node}, ${order}, ${study})`;
    const apiJob = jobApiRecord(jobsApi, displayName, manifest,
      "Upload exact first-attempt study artifact");
    assertArtifactUploadBinding(apiArtifact, apiJob, entry.name);
    const campaignFile = path.join(directory, "campaign-manifest.json");
    assert.equal(fileHash(campaignFile), options["manifest-file-hash"],
      `${entry.name} campaign manifest copy changed`);
    const plan = planContract(readJson(path.join(directory, "proof-plan.json")),
      [platform, node, order, study], manifest, options["manifest-file-hash"]);
    const provenance = readJson(path.join(directory, "study-provenance.json"));
    assert.deepEqual(provenance.plan, plan, `${entry.name} plan/provenance mismatch`);
    assert.equal(provenance.before?.planHash, plan.planHash, `${entry.name} before snapshot changed`);
    assert.equal(provenance.after?.planHash, plan.planHash, `${entry.name} after snapshot changed`);
    for (const field of ["harness", "checkouts", "builds"]) {
      assert.deepEqual(provenance.after?.[field], provenance.before?.[field],
        `${entry.name} ${field} identity changed during measurement`);
    }
    const reportNames = plan.reports.map(({ file }) => file);
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      "campaign-manifest.json", "proof-plan.json", "study-provenance.json", ...reportNames,
    ].sort(), `${entry.name} artifact file set changed`);
    const downloadedDirectorySha256 = directoryHash(directory);
    const artifact = {
      id: String(apiArtifact.id),
      name: entry.name,
      archiveDigest: apiArtifact.digest,
      directoryHashSchema: DIRECTORY_HASH_SCHEMA,
      directorySha256: downloadedDirectorySha256,
      size: apiArtifact.size_in_bytes,
      createdAt: apiArtifact.created_at,
      updatedAt: apiArtifact.updated_at,
    };
    const job = {
      id: String(apiJob.id),
      name: "measure",
      displayName,
      runId: String(apiJob.run_id),
      runAttempt: Number(apiJob.run_attempt),
      startedAt: apiJob.started_at,
      completedAt: apiJob.completed_at,
      upload: {
        name: apiJob.admittedUpload.name,
        number: apiJob.admittedUpload.number,
        startedAt: apiJob.admittedUpload.started_at,
        completedAt: apiJob.admittedUpload.completed_at,
      },
    };
    const reportsForPlan = new Map();
    for (const reportPlan of plan.reports) {
      const file = path.join(directory, reportPlan.file);
      const raw = receipt(file);
      assert.equal(provenance.reports?.[reportPlan.file], raw.receipt.sha256,
        `${entry.name}/${reportPlan.file} provenance hash changed`);
      const parsedReport = JSON.parse(raw.bytes.toString("utf8"));
      reportsForPlan.set(reportPlan.file, parsedReport);
      assert.deepEqual(parsedReport.methodAuditEvidence?.measurement?.runnerOutputReceipt,
        provenance.runnerOutputReceipts?.[reportPlan.file],
        `${entry.name}/${reportPlan.file} runner receipt changed`);
      captures.push({
        study,
        platform,
        node,
        order,
        block: reportPlan.block,
        position: reportPlan.position,
        mode: reportPlan.mode,
        role: reportPlan.role,
        reportId: [study, platform, node, order, `block-${reportPlan.block}`,
          `position-${reportPlan.position}`, reportPlan.mode].join("/"),
        artifact,
        job,
        raw: raw.receipt,
        manifestSha256: manifest.manifestSha256,
        planHash: plan.planHash,
        report: parsedReport,
      });
    }
    validateCompleteReportSet(plan, reportsForPlan, provenance.before, provenance.after);
    assert.equal(directoryHash(directory), downloadedDirectorySha256,
      `${entry.name} changed during aggregate validation`);
    measurementProvenance.push({ artifact, job, planHash: plan.planHash });
  }
  assert.equal(artifactsApi.artifacts.length, 37,
    "run contains a missing, unexpected, or replacement artifact");
  assert.equal(new Set(artifactsApi.artifacts.map(({ id }) => String(id))).size, 37,
    "run contains duplicate artifact IDs");
  assert.equal(jobsApi.jobs.filter(({ name }) => name.startsWith("Measure atomic settlement (")).length,
    36, "run contains a missing, duplicate, or replacement measurement job");
  assert.equal(jobsApi.jobs.length, 38,
    "run contains a missing, unexpected, or replacement job");
  assert.equal(new Set(jobsApi.jobs.map(({ id }) => String(id))).size, 38,
    "run contains duplicate job IDs");
  const aggregateJobs = jobsApi.jobs.filter(({ name }) =>
    name === "Aggregate complete atomic settlement campaign");
  assert.equal(aggregateJobs.length, 1, "aggregate job identity changed");
  assert.equal(String(aggregateJobs[0].run_id), manifest.run.id, "aggregate run ID changed");
  assert.equal(Number(aggregateJobs[0].run_attempt), 1, "aggregate job was rerun");
  assert.equal(aggregateJobs[0].head_sha, manifest.harness.commit,
    "aggregate head SHA changed");
  assert.equal(aggregateJobs[0].status, "in_progress",
    "aggregate job was not the live first-attempt analyzer");
  assert.equal(aggregateJobs[0].conclusion, null,
    "aggregate job concluded before its analysis was captured");
  assert(Date.parse(manifest.run.createdAt) <= Date.parse(aggregateJobs[0].started_at),
    "aggregate job predates its admitted run");
  const result = {
    ...validateAtomicSettlementPerformanceCampaign({ manifest, captures }),
    actions: {
      run: {
        id: String(runApi.id),
        number: Number(runApi.run_number),
        attempt: Number(runApi.run_attempt),
        headSha: runApi.head_sha,
        headBranch: runApi.head_branch,
        path: runApi.path,
        createdAt: runApi.created_at,
        updatedAt: runApi.updated_at,
      },
      apiReceipts: {
        run: runApiCapture.receipt,
        artifacts: artifactsApiCapture.receipt,
        jobs: jobsApiCapture.receipt,
      },
      manifestArtifact: {
        id: String(manifestArtifact.id),
        name: manifestArtifact.name,
        archiveDigest: manifestArtifact.digest,
        size: manifestArtifact.size_in_bytes,
        createdAt: manifestArtifact.created_at,
        updatedAt: manifestArtifact.updated_at,
        producerJobId: String(prepareJob.id),
      },
      measurements: measurementProvenance,
      aggregateJob: {
        id: String(aggregateJobs[0].id),
        name: aggregateJobs[0].name,
        status: aggregateJobs[0].status,
        runId: String(aggregateJobs[0].run_id),
        runAttempt: Number(aggregateJobs[0].run_attempt),
        headSha: aggregateJobs[0].head_sha,
        startedAt: aggregateJobs[0].started_at,
      },
      finalization: "The running aggregate job and its artifact require external post-run verification.",
    },
  };
  fs.writeFileSync(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  if (!result.accepted) fail("atomic settlement performance gates rejected the campaign");
}

function finalize(options) {
  exactOptions(options, [
    "manifest", "manifest-file-hash", "harness-root", "analysis-root",
    "analysis-archive", "analysis-artifact-id", "run-api", "artifacts-api", "jobs-api",
    "output",
  ]);
  const manifestFile = path.resolve(options.manifest);
  const manifest = loadManifest(manifestFile, options["manifest-file-hash"]);
  const harnessRoot = path.resolve(options["harness-root"]);
  verifyHarness(harnessRoot, manifest);
  verifyRemoteBindings(harnessRoot, manifest);

  const analysisRoot = path.resolve(options["analysis-root"]);
  const output = path.resolve(options.output);
  assert.notEqual(output, analysisRoot, "final seal cannot replace the aggregate evidence directory");
  assert.equal(output.startsWith(`${analysisRoot}${path.sep}`), false,
    "final seal must be outside the sealed aggregate evidence directory");
  const expectedAnalysisFiles = [
    "analysis.json", "artifacts-api.json", "campaign-manifest.json", "jobs-api.json",
    "run-api.json",
  ];
  assert.deepEqual(fs.readdirSync(analysisRoot).sort(), expectedAnalysisFiles,
    "aggregate evidence file set is incomplete or unexpected");

  const finalRunCapture = readJsonWithReceipt(path.resolve(options["run-api"]));
  const finalArtifactsCapture = readJsonWithReceipt(path.resolve(options["artifacts-api"]));
  const finalJobsCapture = readJsonWithReceipt(path.resolve(options["jobs-api"]));
  const finalRun = validateAtomicSettlementPerformanceRunApi(finalRunCapture.value, {
    repository: manifest.repository,
    runId: manifest.run.id,
    runNumber: manifest.run.number,
    runAttempt: manifest.run.attempt,
    createdAt: manifest.run.createdAt,
    harnessCommit: manifest.harness.commit,
    sealRef: manifest.harnessSeal.ref,
  });
  assert.equal(finalRun.status, "completed", "campaign run has not completed");
  assert.equal(finalRun.conclusion, "success", "campaign run did not succeed");
  assert(Number.isFinite(Date.parse(finalRun.run_started_at)) &&
    Number.isFinite(Date.parse(finalRun.updated_at)), "final run timestamps are invalid");
  assert(Date.parse(finalRun.created_at) <= Date.parse(finalRun.run_started_at) &&
    Date.parse(finalRun.run_started_at) <= Date.parse(finalRun.updated_at),
  "final run chronology is invalid");

  const finalArtifactsApi = finalArtifactsCapture.value;
  const finalJobsApi = finalJobsCapture.value;
  assert(Array.isArray(finalArtifactsApi.artifacts), "final artifact API response is invalid");
  assert(Array.isArray(finalJobsApi.jobs), "final job API response is invalid");
  assert.equal(finalArtifactsApi.total_count, finalArtifactsApi.artifacts.length,
    "final artifact API response is incomplete");
  assert.equal(finalJobsApi.total_count, finalJobsApi.jobs.length,
    "final job API response is incomplete");
  const manifestArtifactName = `atomic-settlement-campaign-${manifest.run.id}-1`;
  const analysisArtifactName = `atomic-settlement-analysis-${manifest.run.id}-1`;
  const measurementNames = expectedMeasurementArtifactNames(manifest);
  const expectedArtifactNames = [manifestArtifactName, ...measurementNames,
    analysisArtifactName].sort();
  assert.deepEqual(finalArtifactsApi.artifacts.map(({ name }) => name).sort(),
    expectedArtifactNames, "final campaign artifact set is incomplete or unexpected");
  assert.equal(new Set(finalArtifactsApi.artifacts.map(({ id }) => String(id))).size, 38,
    "final campaign contains duplicate artifact IDs");
  assert.equal(finalArtifactsApi.artifacts.length, 38,
    "final campaign contains a missing or replacement artifact");
  assert.equal(finalJobsApi.jobs.length, 38,
    "final campaign contains a missing, unexpected, or replacement job");
  assert.equal(new Set(finalJobsApi.jobs.map(({ id }) => String(id))).size, 38,
    "final campaign contains duplicate job IDs");

  assert.match(options["analysis-artifact-id"], /^[1-9][0-9]*$/u,
    "externally selected analysis artifact ID is invalid");
  const analysisArtifact = artifactApiRecord(finalArtifactsApi, analysisArtifactName, manifest);
  assert.equal(String(analysisArtifact.id), options["analysis-artifact-id"],
    "downloaded analysis artifact ID was not the externally selected API identity");
  const analysisArchiveCapture = receipt(path.resolve(options["analysis-archive"]));
  assert.equal(analysisArchiveCapture.receipt.size, analysisArtifact.size_in_bytes,
    "retained analysis archive size differs from the selected API artifact");
  assert.equal(`sha256:${analysisArchiveCapture.receipt.sha256}`, analysisArtifact.digest,
    "retained analysis archive digest differs from the selected API artifact");
  const extractedFiles = new Map();
  for (const name of expectedAnalysisFiles) {
    const captured = receipt(path.join(analysisRoot, name));
    extractedFiles.set(name, captured);
  }
  const extractedBytes = new Map(
    [...extractedFiles].map(([name, captured]) => [name, captured.bytes]),
  );
  assertExactZipExtraction(analysisArchiveCapture.bytes, expectedAnalysisFiles, extractedBytes);
  const capturedJson = (name) => {
    const captured = extractedFiles.get(name);
    return { value: JSON.parse(captured.bytes.toString("utf8")), receipt: captured.receipt };
  };
  const analysisDirectorySha256 = assertCapturedFlatDirectoryHash(
    extractedBytes,
    directoryHash(analysisRoot),
    "aggregate evidence",
  );
  const embeddedManifest = capturedJson("campaign-manifest.json");
  assert.equal(embeddedManifest.receipt.sha256, options["manifest-file-hash"],
    "aggregate manifest copy changed");
  assert.deepEqual(validateAtomicSettlementPerformanceManifest(embeddedManifest.value), manifest,
    "aggregate manifest content changed");
  const analysisCapture = capturedJson("analysis.json");
  const analysis = validateAnalysisSummary(analysisCapture.value, manifest);
  exactKeys(analysis.actions, [
    "run", "apiReceipts", "manifestArtifact", "measurements", "aggregateJob",
    "finalization",
  ], "aggregate Actions evidence");
  assert.equal(analysis.actions.finalization,
    "The running aggregate job and its artifact require external post-run verification.",
  "aggregate finalization boundary changed");

  const embeddedRunApi = capturedJson("run-api.json");
  const embeddedArtifactsApi = capturedJson("artifacts-api.json");
  const embeddedJobsApi = capturedJson("jobs-api.json");
  exactKeys(analysis.actions.apiReceipts, ["run", "artifacts", "jobs"],
    "aggregate API receipts");
  assertSameReceiptContent(analysis.actions.apiReceipts.run, embeddedRunApi,
    "aggregate run API snapshot");
  assertSameReceiptContent(analysis.actions.apiReceipts.artifacts, embeddedArtifactsApi,
    "aggregate artifact API snapshot");
  assertSameReceiptContent(analysis.actions.apiReceipts.jobs, embeddedJobsApi,
    "aggregate job API snapshot");
  const embeddedRun = validateAtomicSettlementPerformanceRunApi(embeddedRunApi.value, {
    repository: manifest.repository,
    runId: manifest.run.id,
    runNumber: manifest.run.number,
    runAttempt: manifest.run.attempt,
    createdAt: manifest.run.createdAt,
    harnessCommit: manifest.harness.commit,
    sealRef: manifest.harnessSeal.ref,
  });
  exactKeys(analysis.actions.run, [
    "id", "number", "attempt", "headSha", "headBranch", "path", "createdAt", "updatedAt",
  ], "aggregate run evidence");
  assert.deepEqual(analysis.actions.run, {
    id: String(embeddedRun.id),
    number: Number(embeddedRun.run_number),
    attempt: Number(embeddedRun.run_attempt),
    headSha: embeddedRun.head_sha,
    headBranch: embeddedRun.head_branch,
    path: embeddedRun.path,
    createdAt: embeddedRun.created_at,
    updatedAt: embeddedRun.updated_at,
  }, "aggregate run API evidence changed");

  const manifestArtifact = artifactApiRecord(finalArtifactsApi, manifestArtifactName, manifest);
  const prepareJob = jobApiRecord(finalJobsApi, "Prepare immutable atomic settlement campaign",
    manifest, "Upload immutable campaign manifest");
  assertArtifactUploadBinding(manifestArtifact, prepareJob, "campaign manifest artifact");
  exactKeys(analysis.actions.manifestArtifact, [
    "id", "name", "archiveDigest", "size", "createdAt", "updatedAt", "producerJobId",
  ], "aggregate manifest artifact evidence");
  assert.deepEqual(analysis.actions.manifestArtifact, {
    id: String(manifestArtifact.id),
    name: manifestArtifact.name,
    archiveDigest: manifestArtifact.digest,
    size: manifestArtifact.size_in_bytes,
    createdAt: manifestArtifact.created_at,
    updatedAt: manifestArtifact.updated_at,
    producerJobId: String(prepareJob.id),
  }, "manifest artifact identity changed after aggregation");

  assert(Array.isArray(analysis.actions.measurements) &&
    analysis.actions.measurements.length === 36,
  "aggregate measurement provenance is incomplete");
  const analyzedMeasurements = new Map();
  for (const entry of analysis.actions.measurements) {
    exactKeys(entry, ["artifact", "job", "planHash"], "aggregate measurement evidence");
    exactKeys(entry.artifact, [
      "id", "name", "archiveDigest", "directoryHashSchema", "directorySha256", "size",
      "createdAt", "updatedAt",
    ], "aggregate measurement artifact evidence");
    assert.equal(entry.artifact.directoryHashSchema, DIRECTORY_HASH_SCHEMA,
      "aggregate measurement directory hash schema changed");
    assert.match(entry.artifact.directorySha256, SHA256,
      "aggregate measurement directory hash is invalid");
    exactKeys(entry.job, [
      "id", "name", "displayName", "runId", "runAttempt", "startedAt", "completedAt",
      "upload",
    ], "aggregate measurement job evidence");
    exactKeys(entry.job.upload, ["name", "number", "startedAt", "completedAt"],
      "aggregate measurement upload evidence");
    assert.match(entry.planHash, SHA256, "aggregate measurement plan hash is invalid");
    assert.equal(analyzedMeasurements.has(entry.artifact?.name), false,
      "aggregate measurement provenance contains a duplicate artifact");
    analyzedMeasurements.set(entry.artifact.name, entry);
  }
  assert.deepEqual([...analyzedMeasurements.keys()].sort(), measurementNames,
    "aggregate measurement provenance names changed");
  for (const name of measurementNames) {
    const entry = analyzedMeasurements.get(name);
    const match = ARTIFACT.exec(name);
    assert(match, `final measurement artifact name is invalid: ${name}`);
    const [, platform, node, order, study] = match;
    const artifact = artifactApiRecord(finalArtifactsApi, name, manifest);
    const displayName = `Measure atomic settlement (${platform}, ${node}, ${order}, ${study})`;
    const job = jobApiRecord(finalJobsApi, displayName, manifest,
      "Upload exact first-attempt study artifact");
    assertArtifactUploadBinding(artifact, job, name);
    assert.equal(entry.artifact.id, String(artifact.id), `${name} artifact ID changed`);
    assert.equal(entry.artifact.archiveDigest, artifact.digest, `${name} archive digest changed`);
    assert.equal(entry.artifact.size, artifact.size_in_bytes, `${name} artifact size changed`);
    assert.equal(entry.artifact.createdAt, artifact.created_at,
      `${name} artifact creation time changed`);
    assert.equal(entry.artifact.updatedAt, artifact.updated_at,
      `${name} artifact update time changed`);
    assert.equal(entry.job.id, String(job.id), `${name} producer job ID changed`);
    assert.equal(entry.job.displayName, job.name, `${name} producer job name changed`);
    assert.equal(entry.job.runId, String(job.run_id), `${name} producer run ID changed`);
    assert.equal(entry.job.runAttempt, Number(job.run_attempt),
      `${name} producer attempt changed`);
    assert.equal(entry.job.startedAt, job.started_at, `${name} producer start time changed`);
    assert.equal(entry.job.completedAt, job.completed_at, `${name} producer end time changed`);
    assert.deepEqual(entry.job.upload, {
      name: job.admittedUpload.name,
      number: job.admittedUpload.number,
      startedAt: job.admittedUpload.started_at,
      completedAt: job.admittedUpload.completed_at,
    }, `${name} producer upload window changed`);
  }

  const aggregateJob = jobApiRecord(finalJobsApi,
    "Aggregate complete atomic settlement campaign", manifest, "Upload aggregate decision");
  exactKeys(analysis.actions.aggregateJob, [
    "id", "name", "status", "runId", "runAttempt", "headSha", "startedAt",
  ], "live aggregate job evidence");
  assert.equal(analysis.actions.aggregateJob.id, String(aggregateJob.id),
    "aggregate job ID changed after analysis");
  assert.equal(analysis.actions.aggregateJob.status, "in_progress",
    "analysis was not made by the live aggregate job");
  assert.equal(analysis.actions.aggregateJob.runId, String(aggregateJob.run_id),
    "aggregate run ID changed after analysis");
  assert.equal(analysis.actions.aggregateJob.runAttempt, Number(aggregateJob.run_attempt),
    "aggregate attempt changed after analysis");
  assert.equal(analysis.actions.aggregateJob.headSha, aggregateJob.head_sha,
    "aggregate head SHA changed after analysis");
  assert.equal(analysis.actions.aggregateJob.startedAt, aggregateJob.started_at,
    "aggregate start time changed after analysis");
  assertArtifactUploadBinding(analysisArtifact, aggregateJob, "analysis artifact");
  assert(Date.parse(aggregateJob.completed_at) <= Date.parse(finalRun.updated_at),
    "campaign run completed before its aggregate job");
  assert.equal(directoryHash(analysisRoot), analysisDirectorySha256,
    "aggregate evidence changed during finalization");

  const seal = {
    schema: "fs-safe-atomic-settlement-performance-final-seal-v1",
    accepted: true,
    manifestSha256: manifest.manifestSha256,
    manifestFileSha256: options["manifest-file-hash"],
    analysis: {
      artifactId: String(analysisArtifact.id),
      artifactName: analysisArtifact.name,
      archiveDigest: analysisArtifact.digest,
      archiveSize: analysisArtifact.size_in_bytes,
      archiveReceipt: analysisArchiveCapture.receipt,
      archiveFormat: "zip32-store-or-deflate-v1",
      createdAt: analysisArtifact.created_at,
      updatedAt: analysisArtifact.updated_at,
      directoryHashSchema: DIRECTORY_HASH_SCHEMA,
      directorySha256: analysisDirectorySha256,
      reportReceipt: analysisCapture.receipt,
      producerJobId: String(aggregateJob.id),
      producerUpload: {
        name: aggregateJob.admittedUpload.name,
        number: aggregateJob.admittedUpload.number,
        startedAt: aggregateJob.admittedUpload.started_at,
        completedAt: aggregateJob.admittedUpload.completed_at,
      },
    },
    completedRun: {
      id: String(finalRun.id),
      number: Number(finalRun.run_number),
      attempt: Number(finalRun.run_attempt),
      status: finalRun.status,
      conclusion: finalRun.conclusion,
      headSha: finalRun.head_sha,
      headBranch: finalRun.head_branch,
      path: finalRun.path,
      createdAt: finalRun.created_at,
      startedAt: finalRun.run_started_at,
      updatedAt: finalRun.updated_at,
    },
    finalApiReceipts: {
      run: finalRunCapture.receipt,
      artifacts: finalArtifactsCapture.receipt,
      jobs: finalJobsCapture.receipt,
    },
    finalizedAt: new Date().toISOString(),
  };
  fs.writeFileSync(output, `${JSON.stringify(seal, null, 2)}\n`, { flag: "wx" });
}

let parsed;
try {
  parsed = args(process.argv);
  if (parsed.command === "prepare") prepare(parsed.options);
  else if (parsed.command === "verify") verify(parsed.options);
  else if (parsed.command === "analyze") analyze(parsed.options);
  else finalize(parsed.options);
} catch (error) {
  if (parsed?.command === "analyze" && parsed.options.output) {
    const output = path.resolve(parsed.options.output);
    if (!fs.existsSync(output)) {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify({
        schema: "fs-safe-atomic-settlement-performance-analysis-error-v1",
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
      }, null, 2)}\n`, { flag: "wx" });
    }
  }
  process.stderr.write(`atomic settlement performance evidence error: ${
    error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
