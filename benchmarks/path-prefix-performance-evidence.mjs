import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertPathPrefixSourceBinding,
  assertPathPrefixSourceLifecycle,
  collectPathPrefixSourceBinding,
} from "./path-prefix-source-binding.mjs";
import {
  assertStableSnapshots,
  normalizeSha,
  validatePlanHash,
  validateRawReport,
} from "./method-audit-plan.mjs";
import {
  PATH_PREFIX_CAMPAIGN_NAMES,
  validatePathPrefixCampaignReport,
} from "./path-prefix-campaign.mjs";
import {
  PATH_PREFIX_ANALYSIS_SCHEMA,
  PATH_PREFIX_BLOCKS,
  PATH_PREFIX_COMPARISON_FAMILIES,
  PATH_PREFIX_FILTER,
  PATH_PREFIX_ITERATION_MARKER,
  PATH_PREFIX_JOB_SCHEMA,
  PATH_PREFIX_PERFORMANCE_VERSION,
  PATH_PREFIX_SAMPLES,
  analyzePathPrefixPerformanceCampaign,
  assertPathPrefixEvidenceInventory,
  assertPathPrefixManifestFileHash,
  assertPathPrefixWorkflowResults,
  bindPathPrefixResultReceipts,
  createPathPrefixPerformanceManifest,
  expectedPathPrefixFamilySources,
  expectedPathPrefixReports,
  validatePathPrefixJobReceipt,
  validatePathPrefixPerformanceManifest,
} from "./path-prefix-performance-contract.mjs";

const START_SCHEMA = "fs-safe-path-prefix-performance-start-v1";
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const FAMILY_CONTROL = Object.freeze({
  "source-comparison": { control: "rebuild", controlKind: "source-comparison" },
  "same-source-rebuild": { control: "rebuild", controlKind: "same-source-rebuild" },
  "same-artifact": { control: "same-artifact", controlKind: "same-artifact" },
});

function failureRecord(error) {
  return { name: error?.name ?? "Error", code: error?.code ?? null, message: error?.message ?? String(error) };
}

function exactObjectKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} field inventory mismatch`);
}

function parseArguments(argv) {
  const command = argv[2];
  assert(["prepare", "start-job", "source-check", "seal-job", "aggregate"].includes(command),
    "expected prepare, start-job, source-check, seal-job, or aggregate command");
  const options = {};
  for (let index = 3; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(key?.startsWith("--") && value !== undefined,
      "path-prefix evidence options must be --name value pairs");
    const name = key.slice(2);
    assert(options[name] === undefined, `duplicate path-prefix evidence option: ${key}`);
    options[name] = value;
  }
  const required = {
    prepare: ["harness-root", "output"],
    "start-job": ["campaign", "expected-campaign-file-hash", "job-id", "output"],
    "source-check": ["campaign", "expected-campaign-file-hash", "binding-id", "phase", "checkout-root", "output"],
    "seal-job": ["campaign", "expected-campaign-file-hash", "job-root", "output", "start"],
    aggregate: ["campaign", "expected-campaign-file-hash", "evidence-root", "prepare-result", "study-result", "output"],
  }[command];
  assert.deepEqual(Object.keys(options).sort(), [...required].sort(),
    `${command} option inventory mismatch`);
  return { command, options };
}

function absolute(value, label) {
  assert.equal(typeof value, "string", `${label} is missing`);
  assert(path.isAbsolute(value), `${label} must be absolute`);
  return path.resolve(value);
}

function pathKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function assertInside(root, target, label, { allowRoot = false } = {}) {
  const relative = path.relative(root, target);
  assert((allowRoot && relative === "") ||
    (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)),
  `${label} escapes its root`);
  return relative;
}

function realDirectory(value, label) {
  const resolved = absolute(value, label);
  const realpath = fs.realpathSync.native(resolved);
  assert.equal(pathKey(realpath), pathKey(resolved), `${label} must be a physical directory`);
  assert(fs.lstatSync(resolved).isDirectory(), `${label} is not a directory`);
  return resolved;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inspectFile(file, includeBytes = false) {
  const handle = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    assert(before.isFile(), `evidence path is not a file: ${file}`);
    assert(before.nlink === 1n, `evidence file is hardlinked: ${file}`);
    assert(before.size <= BigInt(MAX_FILE_BYTES), `evidence file is oversized: ${file}`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      assert(count > 0, `short read while hashing: ${file}`);
      offset += count;
    }
    const after = fs.fstatSync(handle, { bigint: true });
    assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.nlink === after.nlink, `file changed while hashing: ${file}`);
    const pathname = fs.lstatSync(file, { bigint: true });
    assert(pathname.isFile() && pathname.dev === after.dev && pathname.ino === after.ino,
      `file identity changed while hashing: ${file}`);
    return {
      bytes: includeBytes ? bytes : undefined,
      receipt: {
        sha256: sha256(bytes),
        size: Number(after.size),
        dev: String(after.dev),
        ino: String(after.ino),
        mtimeNs: String(after.mtimeNs),
        nlink: String(after.nlink),
      },
    };
  } finally {
    fs.closeSync(handle);
  }
}

function readJson(file) {
  const inspected = inspectFile(file, true);
  return { value: JSON.parse(inspected.bytes.toString("utf8")), receipt: inspected.receipt };
}

function writeJsonExclusive(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  return inspectFile(file).receipt;
}

function stableReceipt(receipt) {
  return { sha256: receipt.sha256, size: receipt.size };
}

function git(root, args, { buffer = false, allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: buffer ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 && !allowFailure) {
    const stderr = buffer ? result.stderr?.toString("utf8") : result.stderr;
    throw new Error(`git ${args[0]} failed: ${stderr?.trim() || `status ${result.status}`}`);
  }
  return result;
}

function gitText(root, args) {
  return git(root, args).stdout.trim();
}

function ensureCommit(root, commit) {
  const normalized = normalizeSha("campaign source commit", commit);
  if (git(root, ["cat-file", "-e", `${normalized}^{commit}`], { allowFailure: true }).status !== 0) {
    git(root, ["fetch", "--no-tags", "--depth=1", "origin", normalized]);
  }
  assert.equal(gitText(root, ["rev-parse", "--verify", `${normalized}^{commit}`]), normalized,
    "campaign source did not resolve exactly");
  return normalized;
}

function trackedBlob(root, commit, pathname) {
  const listing = git(root, ["ls-tree", "-z", commit, "--", pathname], { buffer: true }).stdout;
  const record = listing.toString("utf8").replace(/\0$/u, "");
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(record);
  assert(match && match[3] === pathname, `${pathname} is missing or unsafe at ${commit}`);
  const bytes = git(root, ["cat-file", "blob", match[2]], { buffer: true }).stdout;
  return { blob: match[2], sha256: sha256(bytes), bytes };
}

function sourceIdentity(root, commit) {
  const resolved = ensureCommit(root, commit);
  const source = trackedBlob(root, resolved, "src/path-prefix.ts");
  return {
    requestedRef: resolved,
    commit: resolved,
    tree: normalizeSha("campaign source tree", gitText(root, ["rev-parse", `${resolved}^{tree}`])),
    manifestHash: trackedBlob(root, resolved, "package.json").sha256,
    lockfileHash: trackedBlob(root, resolved, "pnpm-lock.yaml").sha256,
    pathPrefixSourceBlob: source.blob,
    pathPrefixSourceHash: source.sha256,
  };
}

function benchmarkIdentity(root, commit) {
  const trackedPaths = git(root, ["ls-tree", "-r", "-z", "--name-only", commit, "--", "benchmarks"],
    { buffer: true }).stdout.toString("utf8").split("\0")
    .filter((pathname) => pathname.endsWith(".mjs")).sort();
  const livePaths = fs.readdirSync(path.join(root, "benchmarks"))
    .filter((name) => name.endsWith(".mjs")).map((name) => `benchmarks/${name}`).sort();
  assert.deepEqual(livePaths, trackedPaths, "live benchmark module inventory differs from the reviewed commit");
  const inventory = [...trackedPaths, "package.json", "pnpm-lock.yaml"].sort().map((pathname) => {
    const tracked = trackedBlob(root, commit, pathname);
    const live = inspectFile(path.join(root, ...pathname.split("/"))).receipt;
    assert.equal(live.sha256, tracked.sha256, `live ${pathname} differs from the reviewed blob`);
    return { path: pathname, blob: tracked.blob, sha256: tracked.sha256, bytes: tracked.bytes };
  });
  const hash = createHash("sha256");
  for (const entry of inventory.filter(({ path: pathname }) => pathname.startsWith("benchmarks/"))) {
    hash.update(path.posix.basename(entry.path)).update(entry.bytes);
  }
  for (const pathname of ["package.json", "pnpm-lock.yaml"]) {
    hash.update(inventory.find((entry) => entry.path === pathname).bytes);
  }
  const finalLivePaths = fs.readdirSync(path.join(root, "benchmarks"))
    .filter((name) => name.endsWith(".mjs")).map((name) => `benchmarks/${name}`).sort();
  assert.deepEqual(finalLivePaths, trackedPaths,
    "live benchmark module inventory changed while freezing the manifest");
  assert.equal(gitText(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "",
    "campaign harness changed while freezing the manifest");
  return {
    hash: hash.digest("hex"),
    files: inventory.map(({ path: pathname, blob, sha256: fileHash }) =>
      ({ path: pathname, blob, sha256: fileHash })),
  };
}

function exactEnvironment(name, pattern = /.+/u) {
  const value = process.env[name];
  assert.equal(typeof value, "string", `${name} is missing`);
  assert(pattern.test(value), `${name} is invalid`);
  return value;
}

function appendOutputs(values) {
  const output = exactEnvironment("GITHUB_OUTPUT");
  fs.appendFileSync(output, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function prepare(options) {
  const harnessRoot = realDirectory(options["harness-root"], "campaign harness root");
  assert.equal(path.basename(harnessRoot), "harness", "campaign harness must use the fixed harness path");
  assert.equal(gitText(harnessRoot, ["status", "--porcelain=v1", "--untracked-files=all"]), "",
    "campaign harness has tracked or untracked modifications");
  const harnessCommit = ensureCommit(harnessRoot,
    exactEnvironment("PATH_PREFIX_EXPECTED_HARNESS_SHA", /^[0-9a-f]{40}$/u));
  assert.equal(gitText(harnessRoot, ["rev-parse", "HEAD"]), harnessCommit,
    "campaign harness checkout does not match its expected commit");
  assert.equal(exactEnvironment("GITHUB_WORKFLOW_SHA", /^[0-9a-f]{40}$/u), harnessCommit,
    "campaign harness differs from github.workflow_sha");
  const workflowPath = ".github/workflows/path-prefix-performance.yml";
  const workflow = trackedBlob(harnessRoot, harnessCommit, workflowPath);
  const methodWorkflowPath = ".github/workflows/benchmarks.yml";
  const methodWorkflow = trackedBlob(harnessRoot, harnessCommit, methodWorkflowPath);
  const analyzerPath = "benchmarks/path-prefix-performance-evidence.mjs";
  const analyzer = trackedBlob(harnessRoot, harnessCommit, analyzerPath);
  assert.equal(inspectFile(path.join(harnessRoot, workflowPath)).receipt.sha256, workflow.sha256,
    "checked-out campaign workflow differs from its tracked blob");
  assert.equal(inspectFile(path.join(harnessRoot, methodWorkflowPath)).receipt.sha256, methodWorkflow.sha256,
    "checked-out method workflow differs from its tracked blob");
  assert.equal(inspectFile(path.join(harnessRoot, analyzerPath)).receipt.sha256, analyzer.sha256,
    "checked-out analyzer differs from its tracked blob");
  const harnessSource = sourceIdentity(harnessRoot, harnessCommit);
  const benchmark = benchmarkIdentity(harnessRoot, harnessCommit);
  const manifest = createPathPrefixPerformanceManifest({
    repository: exactEnvironment("GITHUB_REPOSITORY"),
    runId: exactEnvironment("GITHUB_RUN_ID", /^(0|[1-9][0-9]*)$/u),
    runAttempt: Number(exactEnvironment("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/u)),
    workflowRef: exactEnvironment("GITHUB_WORKFLOW_REF"),
    harness: {
      requestedRef: harnessCommit,
      commit: harnessCommit,
      tree: harnessSource.tree,
      manifestHash: harnessSource.manifestHash,
      lockfileHash: harnessSource.lockfileHash,
      benchmarkHash: benchmark.hash,
      benchmarkFiles: benchmark.files,
      workflowPath,
      workflowFileHash: workflow.sha256,
      methodWorkflowPath,
      methodWorkflowFileHash: methodWorkflow.sha256,
    },
    candidate: sourceIdentity(harnessRoot,
      exactEnvironment("PATH_PREFIX_CANDIDATE_SHA", /^[0-9a-f]{40}$/u)),
    baseline: sourceIdentity(harnessRoot,
      exactEnvironment("PATH_PREFIX_BASELINE_SHA", /^[0-9a-f]{40}$/u)),
    analyzer: {
      version: PATH_PREFIX_PERFORMANCE_VERSION,
      path: analyzerPath,
      blob: analyzer.blob,
      sha256: analyzer.sha256,
    },
  });
  const output = absolute(options.output, "campaign manifest output");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJsonExclusive(output, manifest);
  const manifestFileHash = inspectFile(output).receipt.sha256;
  appendOutputs({
    matrix: JSON.stringify({ include: manifest.jobs }),
    campaign_hash: manifest.campaignHash,
    manifest_file_sha256: manifestFileHash,
    harness_sha: manifest.harness.commit,
    candidate_sha: manifest.sources.candidate.commit,
    baseline_sha: manifest.sources.baseline.commit,
  });
}

function loadManifest(file, expectedFileHash) {
  assert(SHA256.test(expectedFileHash), "expected campaign manifest file hash is invalid");
  const inspected = readJson(absolute(file, "campaign manifest"));
  assert.equal(inspected.receipt.sha256, expectedFileHash, "campaign manifest file hash mismatch");
  return { manifest: validatePathPrefixPerformanceManifest(inspected.value), receipt: inspected.receipt };
}

function currentRuntime() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    runnerOS: exactEnvironment("RUNNER_OS"),
    runnerArch: exactEnvironment("RUNNER_ARCH"),
    imageOS: exactEnvironment("ImageOS"),
    imageVersion: exactEnvironment("ImageVersion"),
    runnerEnvironment: exactEnvironment("RUNNER_ENVIRONMENT"),
    githubJob: exactEnvironment("GITHUB_JOB"),
  };
}

function assertWorkflowEnvironment(manifest) {
  assert.equal(exactEnvironment("GITHUB_REPOSITORY"), manifest.repository, "workflow repository mismatch");
  assert.equal(exactEnvironment("GITHUB_RUN_ID"), manifest.workflow.runId, "workflow run id mismatch");
  assert.equal(Number(exactEnvironment("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/u)),
    manifest.workflow.runAttempt, "workflow run attempt mismatch");
  assert.equal(exactEnvironment("GITHUB_WORKFLOW_REF"), manifest.workflow.ref, "workflow ref mismatch");
}

function startJob(options) {
  const loaded = loadManifest(options.campaign, options["expected-campaign-file-hash"]);
  const { manifest } = loaded;
  assertWorkflowEnvironment(manifest);
  const job = manifest.jobs.find(({ id }) => id === options["job-id"]);
  assert(job, "outer job id is absent from the frozen matrix");
  const runtime = currentRuntime();
  assert.equal(runtime.platform, job.runtimePlatform, "outer job runtime platform mismatch");
  assert.equal(runtime.runnerOS, job.runnerOS, "outer job runner OS mismatch");
  assert.equal(runtime.runnerArch, job.runnerArch, "outer job runner architecture mismatch");
  assert.equal(runtime.arch, job.runnerArch.toLowerCase(), "outer job process architecture mismatch");
  assert.match(runtime.node, new RegExp(`^v${job.nodeVersion}\\.`), "outer job Node version mismatch");
  assert.equal(process.env.PATH_PREFIX_MATRIX_OS, job.os, "outer job runner label mismatch");
  assert.equal(process.env.PATH_PREFIX_MATRIX_ORDER, job.order, "outer job order mismatch");
  const start = {
    schema: START_SCHEMA,
    version: PATH_PREFIX_PERFORMANCE_VERSION,
    status: "started",
    excluded: false,
    campaignHash: manifest.campaignHash,
    manifestFileHash: loaded.receipt.sha256,
    job: { ...job },
    workflow: { ...manifest.workflow },
    launchNonce: randomUUID(),
    startedAt: new Date().toISOString(),
    runtime,
    analyzer: { ...manifest.analyzer },
  };
  const output = absolute(options.output, "outer job start output");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJsonExclusive(output, start);
  appendOutputs({ launch_nonce: start.launchNonce });
}

function commonSourceIdentity(actual, expected, label) {
  exactObjectKeys(actual, ["requestedRef", "matchedRef", "commit", "tree", "manifestHash", "lockfileHash",
    "filenameSourceBlob", "filenameSourceHash", "filenameFallbackProfile"], label);
  assert.equal(actual.requestedRef, expected.commit, `${label} requested ref mismatch`);
  assert.equal(actual.matchedRef, null, `${label} unexpectedly used a named ref`);
  for (const field of ["commit", "tree", "manifestHash", "lockfileHash"]) {
    assert.equal(actual[field], expected[field], `${label} ${field} mismatch`);
  }
}

const SOURCE_PHASES = ["before-build", "after-build", "after-measurement"];
function sourceForBinding(manifest, bindingId) {
  assert(["candidate", "source-baseline", "rebuild-baseline"].includes(bindingId), "unknown source binding id");
  return bindingId === "source-baseline" ? manifest.sources.baseline : manifest.sources.candidate;
}

function sourceCheck(options) {
  const { manifest } = loadManifest(options.campaign, options["expected-campaign-file-hash"]);
  assertWorkflowEnvironment(manifest);
  const bindingId = options["binding-id"];
  const expected = sourceForBinding(manifest, bindingId);
  const phaseIndex = SOURCE_PHASES.indexOf(options.phase);
  assert(phaseIndex >= 0, "unknown source binding phase");
  const root = realDirectory(options["checkout-root"], "source checkout root");
  assert.equal(path.basename(root), bindingId === "candidate" ? "candidate" : "baseline",
    "source binding checkout role mismatch");
  const output = absolute(options.output, "source binding output");
  assert.equal(path.basename(output), `${bindingId}-${options.phase}.json`, "source binding filename mismatch");
  const binding = collectPathPrefixSourceBinding(root, expected);
  for (const phase of SOURCE_PHASES.slice(0, phaseIndex)) {
    const previous = readJson(path.join(path.dirname(output), `${bindingId}-${phase}.json`)).value;
    assert.equal(previous.campaignHash, manifest.campaignHash, "source proof campaign mismatch");
    assert.deepEqual(previous.workflow, manifest.workflow, "source proof run/attempt mismatch");
    assert.equal(previous.bindingId, bindingId, "source proof role mismatch");
    assert.equal(previous.phase, phase, "source proof phase mismatch");
    assert.deepEqual(binding, previous.binding, `live source identity changed since ${phase}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJsonExclusive(output, { schema: "fs-safe-path-prefix-source-binding-v1",
    campaignHash: manifest.campaignHash, workflow: manifest.workflow,
    bindingId, phase: options.phase, binding });
}

function validateSourceProof(jobRoot, manifest, bindingId) {
  const bindings = SOURCE_PHASES.map(phase => {
    const proof = readJson(path.join(jobRoot, "source-bindings", `${bindingId}-${phase}.json`)).value;
    exactObjectKeys(proof, ["schema", "campaignHash", "workflow", "bindingId", "phase", "binding"],
      "source binding proof");
    assert.equal(proof.schema, "fs-safe-path-prefix-source-binding-v1", "source proof schema mismatch");
    assert.equal(proof.campaignHash, manifest.campaignHash, "source proof campaign mismatch");
    assert.deepEqual(proof.workflow, manifest.workflow, "source proof run/attempt mismatch");
    assert.equal(proof.bindingId, bindingId, "source proof role mismatch");
    assert.equal(proof.phase, phase, "source proof phase mismatch");
    return proof.binding;
  });
  return assertPathPrefixSourceLifecycle(bindings, sourceForBinding(manifest, bindingId));
}

function validatePlanForFamily(plan, manifest, job, family) {
  validatePlanHash(plan);
  exactObjectKeys(plan, ["schemaVersion", "repository", "run", "trust", "harness", "sources",
    "settings", "matrix", "builds", "reports", "planHash"], `${family} plan`);
  assert.equal(plan.schemaVersion, 1, `${family} plan schema mismatch`);
  exactObjectKeys(plan.settings, ["platform", "compareRef", "candidateRef", "iterations", "samples",
    "filter", "order", "blocks", "nativeMode", "nodeVersion", "control", "timeoutMinutes",
    "expectedHarnessSha", "controlKind"], `${family} plan settings`);
  assert.equal(plan.repository, manifest.repository, `${family} repository mismatch`);
  assert.deepEqual(plan.run, { id: manifest.workflow.runId, attempt: manifest.workflow.runAttempt },
    `${family} workflow run mismatch`);
  exactObjectKeys(plan.harness, ["workflowRef", "workflowPath", "sha", "tree", "workflowFileHash",
    "benchmarkHash", "manifestHash", "lockfileHash"], `${family} harness plan`);
  exactObjectKeys(plan.sources, ["candidate", "baseline"], `${family} source plan`);
  assert.equal(plan.harness.sha, manifest.harness.commit, `${family} harness commit mismatch`);
  assert.equal(plan.harness.tree, manifest.harness.tree, `${family} harness tree mismatch`);
  assert.equal(plan.harness.manifestHash, manifest.harness.manifestHash, `${family} harness manifest mismatch`);
  assert.equal(plan.harness.lockfileHash, manifest.harness.lockfileHash, `${family} harness lockfile mismatch`);
  assert.equal(plan.harness.benchmarkHash, manifest.harness.benchmarkHash, `${family} harness benchmark mismatch`);
  assert.equal(plan.harness.workflowRef, manifest.workflow.ref, `${family} workflow ref mismatch`);
  assert.equal(plan.harness.workflowPath, ".github/workflows/benchmarks.yml",
    `${family} method workflow path mismatch`);
  assert.equal(plan.harness.workflowFileHash, manifest.harness.methodWorkflowFileHash,
    `${family} method workflow hash mismatch`);
  const expectedSources = expectedPathPrefixFamilySources(manifest, family);
  commonSourceIdentity(plan.sources.candidate, expectedSources.candidate, `${family} candidate`);
  commonSourceIdentity(plan.sources.baseline, expectedSources.baseline, `${family} baseline`);
  assert.equal(plan.settings.filter, PATH_PREFIX_FILTER, `${family} filter mismatch`);
  assert.equal(plan.settings.platform, job.platform, `${family} platform input mismatch`);
  assert.equal(plan.settings.candidateRef, manifest.sources.candidate.commit,
    `${family} candidate ref input mismatch`);
  assert.equal(plan.settings.compareRef, expectedSources.baseline.commit,
    `${family} comparison ref input mismatch`);
  assert.equal(plan.settings.expectedHarnessSha, manifest.harness.commit,
    `${family} expected harness input mismatch`);
  assert.equal(plan.settings.iterations, PATH_PREFIX_ITERATION_MARKER, `${family} iteration marker mismatch`);
  assert.equal(plan.settings.samples, PATH_PREFIX_SAMPLES, `${family} sample count mismatch`);
  assert.equal(plan.settings.blocks, PATH_PREFIX_BLOCKS, `${family} block count mismatch`);
  assert.equal(plan.settings.nativeMode, "both", `${family} native mode matrix mismatch`);
  assert.equal(plan.settings.timeoutMinutes, 120, `${family} method-study timeout mismatch`);
  assert.equal(plan.settings.nodeVersion, job.nodeVersion, `${family} Node matrix mismatch`);
  assert.equal(plan.settings.order, job.order, `${family} order mismatch`);
  assert.equal(plan.settings.controlKind, FAMILY_CONTROL[family].controlKind, `${family} control kind mismatch`);
  assert.equal(plan.settings.control, FAMILY_CONTROL[family].control, `${family} control setting mismatch`);
  exactObjectKeys(plan.matrix, ["include"], `${family} plan matrix`);
  assert.deepEqual(plan.matrix.include, [{ platform: job.platform, os: job.os }],
    `${family} platform matrix mismatch`);
  const expectedReports = expectedPathPrefixReports(job.order);
  const expectedPlanReports = expectedReports.map((report) => ({
    block: report.block,
    position: report.position,
    sequence: report.sequence,
    role: report.role,
    label: report.file.slice(0, 0 - `-${report.mode}.json`.length),
    mode: report.mode,
    buildId: family === "same-artifact" ? "candidate-build" : `${report.role}-build`,
    file: report.file,
  }));
  assert.deepEqual(plan.reports, expectedPlanReports, `${family} report plan mismatch`);
  const expectedBuilds = family === "same-artifact"
    ? [{ id: "candidate-build", checkout: "candidate", sourceRole: "candidate" }]
    : [
      { id: "candidate-build", checkout: "candidate", sourceRole: "candidate" },
      { id: "baseline-build", checkout: "baseline", sourceRole: "baseline" },
    ];
  assert.deepEqual(plan.builds, expectedBuilds, `${family} build plan mismatch`);
  return expectedReports;
}

function evidenceRuntime(report, start, label) {
  const runtime = report.methodAuditEvidence?.runtime;
  assert(runtime, `${label} method-audit runtime evidence is missing`);
  for (const key of ["node", "platform", "arch", "runnerOS", "runnerArch", "imageOS", "imageVersion",
    "runnerEnvironment", "githubJob"]) {
    assert.equal(runtime[key], start.runtime[key], `${label} runtime ${key} mismatch`);
  }
  assert.equal(runtime.githubRunId, start.workflow.runId, `${label} workflow run id mismatch`);
  assert.equal(Number(runtime.githubRunAttempt), start.workflow.runAttempt,
    `${label} workflow run attempt mismatch`);
  assert.equal(runtime.campaignLaunchNonce, start.launchNonce, `${label} launch nonce mismatch`);
}

function validateRawRunnerOutputReceipt(report, receipt, label) {
  exactObjectKeys(receipt, ["sha256", "size", "dev", "ino", "mtimeNs"],
    `${label} raw runner output receipt`);
  assert(SHA256.test(receipt.sha256), `${label} raw runner output hash is invalid`);
  assert(Number.isSafeInteger(receipt.size) && receipt.size > 0,
    `${label} raw runner output size is invalid`);
  for (const key of ["dev", "ino", "mtimeNs"]) {
    assert(/^(0|[1-9][0-9]*)$/u.test(receipt[key]), `${label} raw runner output ${key} is invalid`);
  }
  const { methodAuditEvidence: _evidence, ...rawReport } = report;
  const rawBytes = Buffer.from(`${JSON.stringify(rawReport, null, 2)}\n`, "utf8");
  assert.equal(rawBytes.length, receipt.size, `${label} reconstructed raw runner output size mismatch`);
  assert.equal(sha256(rawBytes), receipt.sha256, `${label} reconstructed raw runner output hash mismatch`);
}

function validateFinalReport({ report, reportPlan, plan, before, start, manifest, family, reportHash }) {
  validateRawReport(plan, reportPlan, report, before);
  validatePathPrefixCampaignReport(report, PATH_PREFIX_FILTER);
  const evidence = report.methodAuditEvidence;
  assert(evidence && evidence.schemaVersion === 1, `${reportPlan.file} method-audit evidence is missing`);
  assert.equal(evidence.planHash, plan.planHash, `${reportPlan.file} plan hash mismatch`);
  assert.equal(evidence.harness.workflowSha, manifest.harness.commit, `${reportPlan.file} harness mismatch`);
  assert.equal(evidence.harness.workflowTree, manifest.harness.tree, `${reportPlan.file} harness tree mismatch`);
  assert.equal(evidence.harness.benchmarkHash, manifest.harness.benchmarkHash,
    `${reportPlan.file} benchmark harness mismatch`);
  const expectedSource = expectedPathPrefixFamilySources(manifest, family)[reportPlan.role];
  assert.equal(evidence.source.role, reportPlan.role, `${reportPlan.file} source role mismatch`);
  assert.equal(evidence.source.commit, expectedSource.commit, `${reportPlan.file} source commit mismatch`);
  assert.equal(evidence.source.tree, expectedSource.tree, `${reportPlan.file} source tree mismatch`);
  const measurement = evidence.measurement;
  exactObjectKeys(measurement, ["reportId", "buildId", "artifactPathId", "controlKind", "order",
    "block", "position", "sequence", "mode", "iterations", "samples", "warmup",
    "specializedMeasurement", "filter", "runnerOutputReceipt"], `${reportPlan.file} measurement`);
  validateRawRunnerOutputReceipt(report, measurement.runnerOutputReceipt, reportPlan.file);
  for (const key of ["block", "position", "sequence", "mode", "file"]) {
    const evidenceKey = key === "file" ? "reportId" : key;
    const expected = key === "file" ? reportPlan.file.slice(0, -5) : reportPlan[key];
    assert.equal(measurement[evidenceKey], expected, `${reportPlan.file} measurement ${evidenceKey} mismatch`);
  }
  assert.equal(measurement.controlKind, FAMILY_CONTROL[family].controlKind,
    `${reportPlan.file} comparison family mismatch`);
  assert.equal(measurement.order, start.job.order, `${reportPlan.file} measurement order mismatch`);
  assert.equal(measurement.buildId, reportPlan.buildId, `${reportPlan.file} measurement build mismatch`);
  const buildPlan = plan.builds.find(({ id }) => id === reportPlan.buildId);
  assert.equal(measurement.artifactPathId, `${buildPlan.checkout}/dist`,
    `${reportPlan.file} artifact path mismatch`);
  assert.equal(measurement.warmup, 0, `${reportPlan.file} outer warmup mismatch`);
  assert.deepEqual(measurement.specializedMeasurement, report.metadata.pathPrefixCampaign,
    `${reportPlan.file} specialized measurement receipt mismatch`);
  assert.equal(measurement.filter, PATH_PREFIX_FILTER, `${reportPlan.file} filter mismatch`);
  assert.equal(measurement.samples, PATH_PREFIX_SAMPLES, `${reportPlan.file} sample count mismatch`);
  assert.equal(measurement.iterations, PATH_PREFIX_ITERATION_MARKER,
    `${reportPlan.file} iteration marker mismatch`);
  assert.equal(evidence.installation.identityStableThroughStudy, true,
    `${reportPlan.file} installation was not stable`);
  const build = before.builds[reportPlan.buildId];
  assert.deepEqual(evidence.installation.distTreeHash, build.distTreeHash,
    `${reportPlan.file} dist tree hash mismatch`);
  assert.deepEqual(evidence.installation.distPhysicalSnapshot, build.distPhysicalSnapshot,
    `${reportPlan.file} physical dist snapshot mismatch`);
  assert.equal(report.metadata?.measuredDistribution?.distHash, build.runnerDistHash,
    `${reportPlan.file} measured runner dist mismatch`);
  evidenceRuntime(report, start, reportPlan.file);
  assert.equal(report.metadata.platform, start.runtime.platform, `${reportPlan.file} report platform mismatch`);
  assert.equal(report.metadata.node, start.runtime.node, `${reportPlan.file} report Node mismatch`);
  assert.equal(report.metadata.arch, start.runtime.arch, `${reportPlan.file} report architecture mismatch`);
  assert.deepEqual(report.results.map(({ name }) => name), PATH_PREFIX_CAMPAIGN_NAMES,
    `${reportPlan.file} exact workload inventory mismatch`);
  return {
    file: reportPlan.file,
    reportHash,
    block: reportPlan.block,
    position: reportPlan.position,
    sequence: reportPlan.sequence,
    role: reportPlan.role,
    mode: reportPlan.mode,
    rows: report.results.map((result) => ({
      name: result.name,
      iterations: result.iterations,
      samplesUs: [...result.samplesUs],
      ...bindPathPrefixResultReceipts(result),
    })),
  };
}

function distributionForRole(plan, before, role) {
  const buildIds = new Set(plan.reports.filter((report) => report.role === role)
    .map(({ buildId }) => buildId));
  assert.equal(buildIds.size, 1, `${role} distribution build is ambiguous`);
  const buildId = [...buildIds][0];
  const buildPlan = plan.builds.find(({ id }) => id === buildId);
  const build = before.builds[buildId];
  assert(buildPlan && build, `${role} distribution build is missing`);
  const source = plan.sources[buildPlan.sourceRole];
  return {
    sourceCommit: source.commit,
    sourceTree: source.tree,
    buildId,
    artifactPathId: `${buildPlan.checkout}/dist`,
    distTreeHash: build.distTreeHash,
    runnerDistHash: build.runnerDistHash,
    dependencySnapshot: build.dependencySnapshot,
    nativeArtifacts: build.nativeArtifacts,
    physical: build.distPhysicalSnapshot,
  };
}

function validateFamilyDirectory(jobRoot, family, manifest, start) {
  const familyRoot = path.join(jobRoot, family);
  const planFile = path.join(familyRoot, "method-audit-plan.json");
  const beforeFile = path.join(familyRoot, "before-snapshot.json");
  const reportsRoot = realDirectory(path.join(familyRoot, "reports"), `${family} reports root`);
  const planInspection = readJson(planFile);
  const plan = planInspection.value;
  const expectedReports = validatePlanForFamily(plan, manifest, start.job, family);
  const studyFile = path.join(reportsRoot, "study-provenance.json");
  const studyInspection = readJson(studyFile);
  const study = studyInspection.value;
  assert.equal(study.schemaVersion, 1, `${family} study schema mismatch`);
  assert.deepEqual(study.plan, plan, `${family} study plan differs from its plan file`);
  assert.equal(study.platform, start.job.platform, `${family} study platform mismatch`);
  assert.equal(study.before.planHash, plan.planHash, `${family} before snapshot plan mismatch`);
  assert.equal(study.after.planHash, plan.planHash, `${family} after snapshot plan mismatch`);
  assertStableSnapshots(study.before, study.after);
  const expectedSources = expectedPathPrefixFamilySources(manifest, family);
  for (const buildPlan of plan.builds) {
    const bindingId = buildPlan.sourceRole === "candidate" ? "candidate"
      : family === "source-comparison" ? "source-baseline" : "rebuild-baseline";
    const lifecycle = validateSourceProof(jobRoot, manifest, bindingId);
    for (const snapshot of [study.before, study.after]) {
      const binding = snapshot.builds[buildPlan.id].pathPrefixSourceBinding;
      assertPathPrefixSourceBinding(binding, expectedSources[buildPlan.sourceRole]);
      assert.deepEqual(binding, lifecycle, `${family} measured source differs from its build lifecycle`);
      assert.deepEqual(snapshot.checkouts[buildPlan.checkout].pathPrefixSourceBinding, lifecycle,
        `${family} checkout source differs from its build lifecycle`);
    }
  }
  assert.deepEqual(study.before, readJson(beforeFile).value, `${family} before snapshot file mismatch`);
  const expectedFiles = [...expectedReports.map(({ file }) => file), "study-provenance.json"].sort();
  assert.deepEqual(fs.readdirSync(reportsRoot).sort(), expectedFiles, `${family} evidence file inventory mismatch`);
  assert.deepEqual(Object.keys(study.reports).sort(), expectedReports.map(({ file }) => file).sort(),
    `${family} report hash inventory mismatch`);
  assert.deepEqual(Object.keys(study.runnerOutputReceipts).sort(), expectedReports.map(({ file }) => file).sort(),
    `${family} raw runner receipt inventory mismatch`);
  const normalizedReports = [];
  for (const reportPlan of expectedReports) {
    const file = path.join(reportsRoot, reportPlan.file);
    const inspected = readJson(file);
    assert.equal(inspected.receipt.sha256, study.reports[reportPlan.file],
      `${family} report file hash mismatch: ${reportPlan.file}`);
    assert.deepEqual(inspected.value.methodAuditEvidence?.measurement?.runnerOutputReceipt,
      study.runnerOutputReceipts[reportPlan.file], `${family} raw runner receipt mismatch: ${reportPlan.file}`);
    const planReport = plan.reports.find(({ file: plannedFile }) => plannedFile === reportPlan.file);
    assert(planReport, `${family} report is absent from the method plan: ${reportPlan.file}`);
    normalizedReports.push(validateFinalReport({
      report: inspected.value,
      reportPlan: planReport,
      plan,
      before: study.before,
      start,
      manifest,
      family,
      reportHash: inspected.receipt.sha256,
    }));
  }
  return {
    family,
    status: "complete",
    excluded: false,
    planHash: plan.planHash,
    planFileHash: planInspection.receipt.sha256,
    studyHash: studyInspection.receipt.sha256,
    candidateDistribution: distributionForRole(plan, study.before, "candidate"),
    baselineDistribution: distributionForRole(plan, study.before, "baseline"),
    reports: normalizedReports,
  };
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function evidenceInventory(root, excluded = new Set()) {
  const records = [];
  let entries = 0;
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      entries += 1;
      assert(entries <= 5_000, "job evidence inventory exceeds its entry limit");
      const full = path.join(directory, name);
      const relative = slash(assertInside(root, full, "job evidence entry"));
      if (excluded.has(relative)) continue;
      const stat = fs.lstatSync(full, { bigint: true });
      assert(!stat.isSymbolicLink(), `job evidence contains a link: ${relative}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        const receipt = inspectFile(full).receipt;
        records.push({ path: relative, ...stableReceipt(receipt) });
      } else {
        assert.fail(`job evidence contains an unsupported entry: ${relative}`);
      }
    }
  };
  walk(root);
  return records;
}

function readStart(file, manifest, manifestFileHash) {
  const start = readJson(file).value;
  exactObjectKeys(
    start,
    ["schema", "version", "status", "excluded", "campaignHash", "manifestFileHash", "job",
      "workflow", "launchNonce", "startedAt", "runtime", "analyzer"],
    "outer job start receipt",
  );
  assert.equal(start.schema, START_SCHEMA, "outer job start schema mismatch");
  assert.equal(start.version, PATH_PREFIX_PERFORMANCE_VERSION, "outer job start version mismatch");
  assert.equal(start.status, "started", "outer job did not start cleanly");
  assert.equal(start.excluded, false, "outer job start was excluded");
  assert.equal(start.campaignHash, manifest.campaignHash, "outer job start campaign mismatch");
  assert.equal(start.manifestFileHash, manifestFileHash, "outer job start manifest file mismatch");
  assert.deepEqual(start.workflow, manifest.workflow, "outer job start workflow mismatch");
  assert.deepEqual(start.analyzer, manifest.analyzer, "outer job start analyzer mismatch");
  const job = manifest.jobs.find(({ id }) => id === start.job?.id);
  assert(job, "outer job start has an unknown matrix id");
  assert.deepEqual(start.job, job, "outer job start matrix mismatch");
  exactObjectKeys(start.runtime, ["platform", "arch", "node", "runnerOS", "runnerArch", "imageOS",
    "imageVersion", "runnerEnvironment", "githubJob"], "outer job start runtime");
  assert.equal(start.runtime.platform, job.runtimePlatform, "outer job start runtime platform mismatch");
  assert.match(start.runtime.node, new RegExp(`^v${job.nodeVersion}\\.`), "outer job start Node mismatch");
  assert(/^[0-9a-f-]{36}$/u.test(start.launchNonce), "outer job start launch nonce is invalid");
  assert.equal(new Date(start.startedAt).toISOString(), start.startedAt, "outer job start timestamp is invalid");
  return start;
}

function verifyReviewedHarness(manifest) {
  const harnessRoot = realDirectory(path.resolve(import.meta.dirname, ".."), "reviewed harness root");
  assert.equal(gitText(harnessRoot, ["rev-parse", "HEAD"]), manifest.harness.commit,
    "reviewed harness checkout commit differs from the frozen manifest");
  assert.equal(gitText(harnessRoot, ["rev-parse", "HEAD^{tree}"]), manifest.harness.tree,
    "reviewed harness checkout tree differs from the frozen manifest");
  const benchmark = benchmarkIdentity(harnessRoot, manifest.harness.commit);
  assert.equal(benchmark.hash, manifest.harness.benchmarkHash,
    "reviewed harness benchmark hash differs from the frozen manifest");
  assert.deepEqual(benchmark.files, manifest.harness.benchmarkFiles,
    "reviewed harness benchmark file inventory differs from the frozen manifest");
  const campaignWorkflow = trackedBlob(harnessRoot, manifest.harness.commit, manifest.harness.workflowPath);
  assert.equal(campaignWorkflow.sha256, manifest.harness.workflowFileHash,
    "reviewed campaign workflow blob differs from the frozen manifest");
  assert.equal(inspectFile(path.join(harnessRoot, manifest.harness.workflowPath)).receipt.sha256,
    manifest.harness.workflowFileHash, "checked-out campaign workflow differs from the frozen manifest");
  const methodWorkflow = trackedBlob(harnessRoot, manifest.harness.commit,
    manifest.harness.methodWorkflowPath);
  assert.equal(methodWorkflow.sha256, manifest.harness.methodWorkflowFileHash,
    "reviewed method workflow blob differs from the frozen manifest");
  assert.equal(inspectFile(path.join(harnessRoot, manifest.harness.methodWorkflowPath)).receipt.sha256,
    manifest.harness.methodWorkflowFileHash, "checked-out method workflow differs from the frozen manifest");
  const analyzer = trackedBlob(harnessRoot, manifest.harness.commit, manifest.analyzer.path);
  assert.equal(analyzer.blob, manifest.analyzer.blob,
    "reviewed analyzer blob differs from the frozen manifest");
  assert.equal(analyzer.sha256, manifest.analyzer.sha256,
    "reviewed analyzer bytes differ from the frozen manifest");
  assert.equal(inspectFile(path.join(harnessRoot, manifest.analyzer.path)).receipt.sha256,
    manifest.analyzer.sha256, "executing analyzer hash differs from the frozen manifest");
  return { ...manifest.analyzer };
}

function sealJob(options) {
  const loaded = loadManifest(options.campaign, options["expected-campaign-file-hash"]);
  const { manifest } = loaded;
  assertWorkflowEnvironment(manifest);
  verifyReviewedHarness(manifest);
  const jobRoot = realDirectory(options["job-root"], "outer job evidence root");
  const output = absolute(options.output, "outer job receipt output");
  assertInside(jobRoot, output, "outer job receipt output");
  assert.equal(path.basename(output), "job-receipt.json", "outer job receipt filename mismatch");
  assert(!fs.existsSync(output), "outer job receipt already exists");
  const startFile = absolute(options.start, "outer job start receipt");
  assertInside(jobRoot, startFile, "outer job start receipt");
  const start = readStart(startFile, manifest, loaded.receipt.sha256);
  assert.deepEqual(currentRuntime(), start.runtime, "outer job runtime changed after measurement");
  const families = PATH_PREFIX_COMPARISON_FAMILIES.map((family) =>
    validateFamilyDirectory(jobRoot, family, manifest, start));
  const inventory = evidenceInventory(jobRoot, new Set([slash(path.relative(jobRoot, output))]));
  const receipt = {
    schema: PATH_PREFIX_JOB_SCHEMA,
    version: PATH_PREFIX_PERFORMANCE_VERSION,
    status: "complete",
    excluded: false,
    campaignHash: manifest.campaignHash,
    manifestFileHash: loaded.receipt.sha256,
    job: { ...start.job },
    workflow: { ...start.workflow },
    launchNonce: start.launchNonce,
    startedAt: start.startedAt,
    finishedAt: new Date().toISOString(),
    runtime: { ...start.runtime },
    analyzer: { ...manifest.analyzer },
    inventory,
    families,
  };
  validatePathPrefixJobReceipt(receipt, manifest);
  writeJsonExclusive(output, receipt);
}

function findFiles(root, basename) {
  const matches = [];
  let entries = 0;
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      entries += 1;
      assert(entries <= 100_000, "aggregate evidence exceeds its entry limit");
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      assert(!stat.isSymbolicLink(), `aggregate evidence contains a link: ${full}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && name === basename) matches.push(full);
      else if (!stat.isFile()) assert.fail(`aggregate evidence contains an unsupported entry: ${full}`);
    }
  };
  walk(root);
  return matches;
}

function verifyDownloadedJob(receiptFile, manifest, manifestFileHash) {
  const jobRoot = path.dirname(receiptFile);
  const inspected = readJson(receiptFile);
  const receipt = validatePathPrefixJobReceipt(inspected.value, manifest);
  assertPathPrefixManifestFileHash(receipt, manifestFileHash);
  const actual = evidenceInventory(jobRoot, new Set(["job-receipt.json"]));
  assertPathPrefixEvidenceInventory(receipt.inventory, actual);
  const start = readStart(path.join(jobRoot, "job-start.json"), manifest, manifestFileHash);
  assert.deepEqual({
    job: receipt.job,
    workflow: receipt.workflow,
    launchNonce: receipt.launchNonce,
    startedAt: receipt.startedAt,
    runtime: receipt.runtime,
    analyzer: receipt.analyzer,
  }, {
    job: start.job,
    workflow: start.workflow,
    launchNonce: start.launchNonce,
    startedAt: start.startedAt,
    runtime: start.runtime,
    analyzer: start.analyzer,
  }, "downloaded job receipt differs from its immutable start receipt");
  const recomputedFamilies = PATH_PREFIX_COMPARISON_FAMILIES.map((family) =>
    validateFamilyDirectory(jobRoot, family, manifest, start));
  assert.deepEqual(recomputedFamilies, receipt.families,
    "downloaded comparison families differ from their validated report files");
  return { receipt, receiptFile: stableReceipt(inspected.receipt) };
}

function aggregateLayout(evidenceRoot, manifest) {
  const failures = [];
  const receiptFiles = [];
  const expected = manifest.jobs.map(({ id }) =>
    `path-prefix-job-${id}-${manifest.workflow.runId}-${manifest.workflow.runAttempt}`).sort();
  const entries = fs.readdirSync(evidenceRoot, { withFileTypes: true });
  const actual = entries.map(({ name }) => name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push({ type: "artifact-directory-inventory", expected, actual });
  }
  for (const entry of entries) {
    const full = path.join(evidenceRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      failures.push({ type: "unsafe-artifact-entry", path: entry.name });
      continue;
    }
    const realpath = fs.realpathSync.native(full);
    if (pathKey(realpath) !== pathKey(full)) {
      failures.push({ type: "aliased-artifact-directory", path: entry.name });
      continue;
    }
    const receiptFile = path.join(full, "job-receipt.json");
    if (!fs.existsSync(receiptFile) || !fs.lstatSync(receiptFile).isFile()) {
      failures.push({ type: "missing-job-receipt", path: entry.name });
      continue;
    }
    receiptFiles.push(receiptFile);
  }
  const discovered = findFiles(evidenceRoot, "job-receipt.json").map(pathKey).sort();
  const direct = receiptFiles.map(pathKey).sort();
  if (JSON.stringify(discovered) !== JSON.stringify(direct)) {
    failures.push({ type: "nested-or-duplicate-job-receipt" });
  }
  return { failures, receiptFiles };
}

function aggregate(options) {
  const loaded = loadManifest(options.campaign, options["expected-campaign-file-hash"]);
  const { manifest } = loaded;
  assertWorkflowEnvironment(manifest);
  const analyzer = verifyReviewedHarness(manifest);
  const evidenceRoot = realDirectory(options["evidence-root"], "downloaded campaign evidence root");
  const output = absolute(options.output, "campaign analysis output");
  assert(!fs.existsSync(output), "campaign analysis output already exists");
  const layout = aggregateLayout(evidenceRoot, manifest);
  const receiptFiles = layout.receiptFiles;
  const receipts = [];
  const receiptInputs = [];
  const provenanceFailures = [...layout.failures];
  const workflowResults = { prepare: options["prepare-result"], study: options["study-result"] };
  try {
    assertPathPrefixWorkflowResults(workflowResults);
  } catch (error) {
    provenanceFailures.push({ type: "upstream-workflow-result", failure: failureRecord(error) });
  }
  for (const [index, receiptFile] of receiptFiles.entries()) {
    try {
      const verified = verifyDownloadedJob(receiptFile, manifest, loaded.receipt.sha256);
      receipts.push(verified.receipt);
      receiptInputs.push({ jobId: verified.receipt.job.id, ...verified.receiptFile });
    } catch (error) {
      provenanceFailures.push({ type: "downloaded-job", receiptIndex: index,
        path: slash(path.relative(evidenceRoot, receiptFile)), failure: failureRecord(error) });
    }
  }
  const analysis = analyzePathPrefixPerformanceCampaign(manifest, receipts);
  if (provenanceFailures.length > 0) {
    analysis.overall = "REJECT";
    analysis.failures.unshift(...provenanceFailures);
  }
  const report = {
    ...analysis,
    generatedAt: new Date().toISOString(),
    analyzer,
    workflowResults,
    publicationRequiresSuccessfulAggregateJob: true,
    manifestFile: stableReceipt(loaded.receipt),
    receiptInputs: receiptInputs.sort((left, right) => left.jobId.localeCompare(right.jobId)),
    evidenceFiles: receiptFiles.length,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJsonExclusive(output, report);
  if (report.overall !== "ACCEPT") process.exitCode = 2;
}

let fatalOutput;
try {
  const { command, options } = parseArguments(process.argv);
  fatalOutput = options.output ? absolute(options.output, "path-prefix evidence output") : undefined;
  if (command === "prepare") prepare(options);
  else if (command === "start-job") startJob(options);
  else if (command === "source-check") sourceCheck(options);
  else if (command === "seal-job") sealJob(options);
  else aggregate(options);
} catch (error) {
  const failure = failureRecord(error);
  if (fatalOutput && !fs.existsSync(fatalOutput)) {
    try {
      fs.mkdirSync(path.dirname(fatalOutput), { recursive: true });
      writeJsonExclusive(fatalOutput, {
        schema: PATH_PREFIX_ANALYSIS_SCHEMA,
        version: PATH_PREFIX_PERFORMANCE_VERSION,
        overall: "REJECT",
        generatedAt: new Date().toISOString(),
        failure,
      });
    } catch {
      // Keep the original fail-closed error.
    }
  }
  process.stderr.write(`path-prefix performance evidence error: ${failure.message}\n`);
  process.exitCode = 2;
}
