import assert from "node:assert/strict";
import { digestJson, normalizeSha, normalizeSha256 } from "./method-audit-plan.mjs";
import { PATH_PREFIX_CAMPAIGN_NAMES, PATH_PREFIX_CAMPAIGN_ROWS } from "./path-prefix-campaign.mjs";
import { PNPM_METADATA_SOURCE, PNPM_TASK_STATE, PNPM_WORKSPACE_STATE,
  validatePathPrefixExecutionReceipt } from "./method-audit-dependency-identity.mjs";

export const PATH_PREFIX_PERFORMANCE_VERSION = "path-prefix-performance-v1";
export const PATH_PREFIX_PERFORMANCE_SCHEMA = "fs-safe-path-prefix-performance-plan-v1";
export const PATH_PREFIX_JOB_SCHEMA = "fs-safe-path-prefix-performance-job-v1";
export const PATH_PREFIX_ANALYSIS_SCHEMA = "fs-safe-path-prefix-performance-analysis-v1";
export const PATH_PREFIX_FILTER = "resolvePathPrefixSync/";
export const PATH_PREFIX_BLOCKS = 3;
export const PATH_PREFIX_SAMPLES = 9;
export const PATH_PREFIX_ITERATION_MARKER = 10_000;
export const PATH_PREFIX_JOB_TIMEOUT_MINUTES = 360;

export const PATH_PREFIX_NATIVE_MODES = Object.freeze(["off", "require"]);
export const PATH_PREFIX_ORDERS = Object.freeze(["abba", "baab"]);
export const PATH_PREFIX_NODE_VERSIONS = Object.freeze(["22", "24"]);
export const PATH_PREFIX_COMPARISON_FAMILIES = Object.freeze([
  "source-comparison",
  "same-source-rebuild",
  "same-artifact",
]);
export const PATH_PREFIX_GATE_SCOPES = Object.freeze([
  "block-1",
  "block-2",
  "block-3",
  "pooled",
]);

const PLATFORM_JOBS = Object.freeze([
  Object.freeze({ platform: "linux", os: "ubuntu-latest", runtimePlatform: "linux",
    runnerOS: "Linux", runnerArch: "X64" }),
  Object.freeze({ platform: "macos", os: "macos-15", runtimePlatform: "darwin",
    runnerOS: "macOS", runnerArch: "ARM64" }),
  Object.freeze({ platform: "windows", os: "windows-latest", runtimePlatform: "win32",
    runnerOS: "Windows", runnerArch: "X64" }),
]);

export const PATH_PREFIX_OUTER_JOBS = Object.freeze(PLATFORM_JOBS.flatMap((platform) =>
  PATH_PREFIX_NODE_VERSIONS.flatMap((nodeVersion) => PATH_PREFIX_ORDERS.map((order) => Object.freeze({
    id: `${platform.platform}-node-${nodeVersion}-${order}`,
    ...platform,
    nodeVersion,
    order,
  })))));

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLATFORM_BY_ID = new Map(PATH_PREFIX_OUTER_JOBS.map((job) => [job.id, job]));
const FAMILY_SET = new Set(PATH_PREFIX_COMPARISON_FAMILIES);
const ROW_SET = new Set(PATH_PREFIX_CAMPAIGN_NAMES);
const ITERATIONS_BY_ROW = new Map(PATH_PREFIX_CAMPAIGN_ROWS.map(({ name, effectiveIterations }) =>
  [name, effectiveIterations]));

function exactKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} field inventory mismatch`);
}

function canonicalInteger(value, minimum, maximum, label) {
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label} is invalid`);
  return value;
}

function boundedText(value, maximum, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert(value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum,
    `${label} length is invalid`);
  assert(!/[\u0000-\u001f\u007f-\u009f]/u.test(value), `${label} contains control characters`);
  return value;
}

function isoTimestamp(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.equal(new Date(value).toISOString(), value, `${label} is invalid`);
  return value;
}

function sourceIdentity(value, label) {
  exactKeys(value, ["requestedRef", "commit", "tree", "manifestHash", "lockfileHash",
    "pathPrefixSourceBlob", "pathPrefixSourceHash"], label);
  const commit = normalizeSha(`${label} commit`, value.commit);
  assert.equal(value.requestedRef, commit, `${label} must use its exact commit as requested ref`);
  return {
    requestedRef: commit,
    commit,
    tree: normalizeSha(`${label} tree`, value.tree),
    manifestHash: normalizeSha256(`${label} manifest hash`, value.manifestHash),
    lockfileHash: normalizeSha256(`${label} lockfile hash`, value.lockfileHash),
    pathPrefixSourceBlob: normalizeSha(`${label} path-prefix source blob`, value.pathPrefixSourceBlob),
    pathPrefixSourceHash: normalizeSha256(`${label} path-prefix source hash`, value.pathPrefixSourceHash),
  };
}

function harnessIdentity(value) {
  exactKeys(value, ["requestedRef", "commit", "tree", "manifestHash", "lockfileHash",
    "benchmarkHash", "benchmarkFiles", "workflowPath", "workflowFileHash", "methodWorkflowPath",
    "methodWorkflowFileHash"], "harness identity");
  const commit = normalizeSha("harness commit", value.commit);
  assert.equal(value.requestedRef, commit, "harness must use its exact commit as requested ref");
  assert.equal(value.workflowPath, ".github/workflows/path-prefix-performance.yml",
    "campaign workflow path mismatch");
  assert.equal(value.methodWorkflowPath, ".github/workflows/benchmarks.yml",
    "method workflow path mismatch");
  assert(Array.isArray(value.benchmarkFiles) && value.benchmarkFiles.length > 0,
    "harness benchmark file inventory is empty");
  const benchmarkFiles = value.benchmarkFiles.map((entry, index) => {
    exactKeys(entry, ["path", "blob", "sha256"], `harness benchmark file ${index + 1}`);
    assert(/^benchmarks\/[a-z0-9][a-z0-9-]*\.mjs$/u.test(entry.path) ||
      ["package.json", "pnpm-lock.yaml"].includes(entry.path),
    `harness benchmark file ${index + 1} path is invalid`);
    return { path: entry.path, blob: normalizeSha("harness benchmark blob", entry.blob),
      sha256: normalizeSha256("harness benchmark file hash", entry.sha256) };
  });
  assert.deepEqual(benchmarkFiles.map(({ path: pathname }) => pathname),
    [...benchmarkFiles.map(({ path: pathname }) => pathname)].sort(),
    "harness benchmark file inventory order mismatch");
  assert.equal(new Set(benchmarkFiles.map(({ path: pathname }) => pathname)).size, benchmarkFiles.length,
    "harness benchmark file inventory contains duplicates");
  return {
    requestedRef: commit,
    commit,
    tree: normalizeSha("harness tree", value.tree),
    manifestHash: normalizeSha256("harness manifest hash", value.manifestHash),
    lockfileHash: normalizeSha256("harness lockfile hash", value.lockfileHash),
    benchmarkHash: normalizeSha256("harness benchmark hash", value.benchmarkHash),
    benchmarkFiles,
    workflowPath: value.workflowPath,
    workflowFileHash: normalizeSha256("campaign workflow hash", value.workflowFileHash),
    methodWorkflowPath: value.methodWorkflowPath,
    methodWorkflowFileHash: normalizeSha256("method workflow hash", value.methodWorkflowFileHash),
  };
}

function analyzerIdentity(value) {
  exactKeys(value, ["version", "path", "blob", "sha256"], "analyzer identity");
  assert.equal(value.version, PATH_PREFIX_PERFORMANCE_VERSION, "analyzer version mismatch");
  assert.equal(value.path, "benchmarks/path-prefix-performance-evidence.mjs", "analyzer path mismatch");
  return {
    version: value.version,
    path: value.path,
    blob: normalizeSha("analyzer blob", value.blob),
    sha256: normalizeSha256("analyzer hash", value.sha256),
  };
}

function manifestSettings() {
  return {
    filter: PATH_PREFIX_FILTER,
    iterationMarker: PATH_PREFIX_ITERATION_MARKER,
    samplesPerReport: PATH_PREFIX_SAMPLES,
    blocks: PATH_PREFIX_BLOCKS,
    reportsPerArmPerBlock: 2,
    nativeModes: [...PATH_PREFIX_NATIVE_MODES],
    orders: [...PATH_PREFIX_ORDERS],
    nodeVersions: [...PATH_PREFIX_NODE_VERSIONS],
    rows: [...PATH_PREFIX_CAMPAIGN_NAMES],
    comparisonFamilies: [...PATH_PREFIX_COMPARISON_FAMILIES],
    controls: {
      sameSourceRebuild: "candidate source rebuilt in two physical installations",
      sameArtifact: "candidate and baseline labels use one identical installation",
      cancellation: "controls never subtract from, offset, or cancel a source result",
    },
    gates: {
      median: { relativeRegression: 0.10, absoluteRegressionUs: 50 },
      maximumSampleAverage: { relativeRegression: 0.20, absoluteRegressionUs: 100 },
      scopes: [...PATH_PREFIX_GATE_SCOPES],
      zeroBaseline: "relative regression is +Infinity when candidate is positive and baseline is zero",
      exclusions: false,
      subtraction: false,
      selectiveReruns: false,
    },
    serialization: { maxParallelOuterJobs: 1, failFast: false },
    timeoutMinutesPerOuterJob: PATH_PREFIX_JOB_TIMEOUT_MINUTES,
  };
}

export function createPathPrefixPerformanceManifest({
  repository,
  runId,
  runAttempt,
  workflowRef,
  harness,
  candidate,
  baseline,
  analyzer,
}) {
  const normalizedHarness = harnessIdentity(harness);
  const normalizedCandidate = sourceIdentity(candidate, "candidate identity");
  const normalizedBaseline = sourceIdentity(baseline, "baseline identity");
  assert.notEqual(normalizedCandidate.commit, normalizedBaseline.commit,
    "source comparison requires distinct candidate and baseline commits");
  const body = {
    schema: PATH_PREFIX_PERFORMANCE_SCHEMA,
    version: PATH_PREFIX_PERFORMANCE_VERSION,
    repository: boundedText(repository, 256, "repository"),
    workflow: {
      ref: boundedText(workflowRef, 512, "workflow ref"),
      runId: boundedText(runId, 64, "workflow run id"),
      runAttempt: canonicalInteger(runAttempt, 1, 1_000, "workflow run attempt"),
    },
    harness: normalizedHarness,
    sources: { candidate: normalizedCandidate, baseline: normalizedBaseline },
    analyzer: analyzerIdentity(analyzer),
    settings: manifestSettings(),
    jobs: PATH_PREFIX_OUTER_JOBS.map((job) => ({ ...job })),
  };
  return { ...body, campaignHash: digestJson(body) };
}

export function validatePathPrefixPerformanceManifest(manifest) {
  exactKeys(manifest, ["schema", "version", "repository", "workflow", "harness", "sources",
    "analyzer", "settings", "jobs", "campaignHash"], "campaign manifest");
  assert.equal(manifest.schema, PATH_PREFIX_PERFORMANCE_SCHEMA, "campaign schema mismatch");
  assert.equal(manifest.version, PATH_PREFIX_PERFORMANCE_VERSION, "campaign version mismatch");
  const expected = createPathPrefixPerformanceManifest({
    repository: manifest.repository,
    runId: manifest.workflow?.runId,
    runAttempt: manifest.workflow?.runAttempt,
    workflowRef: manifest.workflow?.ref,
    harness: manifest.harness,
    candidate: manifest.sources?.candidate,
    baseline: manifest.sources?.baseline,
    analyzer: manifest.analyzer,
  });
  assert.deepEqual(manifest, expected, "campaign manifest content or hash mismatch");
  return manifest;
}

export function expectedPathPrefixFamilySources(manifest, family) {
  validatePathPrefixPerformanceManifest(manifest);
  assert(FAMILY_SET.has(family), "unknown path-prefix comparison family");
  if (family === "source-comparison") {
    return { candidate: manifest.sources.candidate, baseline: manifest.sources.baseline };
  }
  return { candidate: manifest.sources.candidate, baseline: manifest.sources.candidate };
}

export function pathPrefixPositionRoles(order) {
  assert(PATH_PREFIX_ORDERS.includes(order), "path-prefix order is invalid");
  return order === "abba"
    ? ["baseline", "candidate", "candidate", "baseline"]
    : ["candidate", "baseline", "baseline", "candidate"];
}

export function expectedPathPrefixReports(order) {
  const roles = pathPrefixPositionRoles(order);
  const reports = [];
  for (let block = 1; block <= PATH_PREFIX_BLOCKS; block += 1) {
    const seen = { baseline: 0, candidate: 0 };
    for (let position = 1; position <= roles.length; position += 1) {
      const role = roles[position - 1];
      seen[role] += 1;
      const label = `block-${block}-${role}-${seen[role] === 1 ? "a" : "b"}`;
      for (const mode of PATH_PREFIX_NATIVE_MODES) {
        reports.push({ block, position, sequence: (block - 1) * 4 + position, role, mode,
          file: `${label}-${mode}.json` });
      }
    }
  }
  return reports;
}

export function bindPathPrefixResultReceipts(result) {
  assert(result?.pathPrefixCampaignReceipt && typeof result.pathPrefixCampaignReceipt === "object",
    "path-prefix execution receipt is missing");
  assert(result?.pathPrefixFixtureReceipt && typeof result.pathPrefixFixtureReceipt === "object",
    "path-prefix fixture receipt is missing");
  return {
    executionReceiptHash: digestJson(result.pathPrefixCampaignReceipt),
    fixtureReceiptHash: digestJson(result.pathPrefixFixtureReceipt),
  };
}

export function assertPathPrefixManifestFileHash(receipt, actualFileHash) {
  assert(SHA256.test(actualFileHash), "actual campaign manifest file hash is invalid");
  assert.equal(receipt.manifestFileHash, actualFileHash, "campaign manifest bytes do not match the job receipt");
}

export function assertPathPrefixEvidenceInventory(expected, actual) {
  assert.deepEqual(actual, expected, "downloaded job evidence inventory mismatch");
  return actual;
}

function exactJob(value, label) {
  exactKeys(value, ["id", "platform", "os", "runtimePlatform", "runnerOS", "runnerArch",
    "nodeVersion", "order"], label);
  const expected = PLATFORM_BY_ID.get(value.id);
  assert(expected, `${label} has an unknown id`);
  assert.deepEqual(value, expected, `${label} matrix values mismatch`);
  return expected;
}

function finiteSamples(values, label) {
  assert(Array.isArray(values) && values.length === PATH_PREFIX_SAMPLES,
    `${label} raw sample count mismatch`);
  for (const value of values) assert(Number.isFinite(value) && value >= 0, `${label} has an invalid sample`);
  return values;
}

function validateRow(row, label) {
  exactKeys(row, ["name", "iterations", "samplesUs", "executionReceiptHash", "fixtureReceiptHash"], label);
  assert(ROW_SET.has(row.name), `${label} has an unknown workload`);
  assert.equal(row.iterations, ITERATIONS_BY_ROW.get(row.name),
    `${label} effective iteration count mismatch`);
  finiteSamples(row.samplesUs, label);
  assert(SHA256.test(row.executionReceiptHash), `${label} execution receipt hash mismatch`);
  assert(SHA256.test(row.fixtureReceiptHash), `${label} fixture receipt hash mismatch`);
  return row;
}

function validateReport(report, expected, label) {
  exactKeys(report, ["file", "reportHash", "block", "position", "sequence", "role", "mode", "rows"], label);
  for (const key of ["file", "block", "position", "sequence", "role", "mode"]) {
    assert.equal(report[key], expected[key], `${label} ${key} mismatch`);
  }
  assert(SHA256.test(report.reportHash), `${label} report hash mismatch`);
  assert.deepEqual(report.rows.map(({ name }) => name), PATH_PREFIX_CAMPAIGN_NAMES,
    `${label} workload inventory mismatch`);
  report.rows.forEach((row, index) => validateRow(row, `${label} row ${index + 1}`));
  return report;
}

function validatePhysicalSnapshot(snapshot, label) {
  exactKeys(snapshot, ["schemaVersion", "path", "realpath", "identity", "entries"], label);
  assert.equal(snapshot.schemaVersion, 1, `${label} schema mismatch`);
  for (const key of ["path", "realpath"]) boundedText(snapshot[key], 16_384, `${label} ${key}`);
  exactKeys(snapshot.identity, ["dev", "ino", "nlink"], `${label} root identity`);
  for (const key of ["dev", "ino", "nlink"]) {
    assert(/^(0|[1-9][0-9]*)$/u.test(snapshot.identity[key]), `${label} root ${key} is invalid`);
  }
  assert(Array.isArray(snapshot.entries) && snapshot.entries.length > 0, `${label} entries are empty`);
  const paths = [];
  for (const [index, entry] of snapshot.entries.entries()) {
    const expectedKeys = entry.type === "file"
      ? ["path", "type", "size", "dev", "ino", "nlink"]
      : ["path", "type", "dev", "ino", "nlink"];
    exactKeys(entry, expectedKeys, `${label} entry ${index + 1}`);
    assert(["file", "directory"].includes(entry.type), `${label} entry type is invalid`);
    assert(!entry.path.includes("..") && !entry.path.includes("\\") && entry.path.length > 0,
      `${label} entry path is unsafe`);
    if (entry.type === "file") {
      canonicalInteger(entry.size, 0, 1024 * 1024 * 1024, `${label} entry size`);
      assert.equal(entry.nlink, "1", `${label} contains a hardlinked file`);
    }
    for (const key of ["dev", "ino", "nlink"]) {
      assert(/^(0|[1-9][0-9]*)$/u.test(entry[key]), `${label} entry ${key} is invalid`);
    }
    paths.push(entry.path);
  }
  assert.equal(new Set(paths).size, paths.length, `${label} entry paths are duplicated`);
  return snapshot;
}

export function assertPathPrefixWorkflowResults(results) {
  exactKeys(results, ["prepare", "study"], "upstream workflow results");
  assert.equal(results.prepare, "success", "prepare job (including manifest upload) did not succeed");
  assert.equal(results.study, "success", "study jobs (including evidence uploads) did not all succeed");
  return results;
}

function validateDistribution(distribution, label) {
  exactKeys(distribution, ["sourceCommit", "sourceTree", "buildId", "artifactPathId", "distTreeHash",
    "runnerDistHash", "dependencySnapshot", "nativeArtifacts", "physical"], label);
  normalizeSha(`${label} source commit`, distribution.sourceCommit);
  normalizeSha(`${label} source tree`, distribution.sourceTree);
  assert(/^[a-z][a-z0-9-]*$/u.test(distribution.buildId), `${label} build id is invalid`);
  assert(["candidate/dist", "baseline/dist"].includes(distribution.artifactPathId),
    `${label} artifact path id is invalid`);
  assert(SHA256.test(distribution.runnerDistHash), `${label} runner dist hash is invalid`);
  assert(distribution.dependencySnapshot && distribution.dependencySnapshot.schemaVersion === 1,
    `${label} dependency snapshot schema mismatch`);
  assert.equal(distribution.dependencySnapshot.scope, "pnpm-layout-manifests-locks-native-v1",
    `${label} dependency snapshot scope mismatch`);
  assert(SHA256.test(distribution.dependencySnapshot.hash), `${label} dependency snapshot hash is invalid`);
  const canonical = distribution.dependencySnapshot.canonical;
  exactKeys(canonical, ["schemaVersion", "scope", "hash", "entries", "executionHash"], `${label} canonical dependencies`);
  assert.equal(canonical.schemaVersion, 2, `${label} canonical dependency schema mismatch`);
  assert.equal(canonical.scope, "pnpm-install-and-build-identity-v2", `${label} canonical dependency scope mismatch`);
  assert(SHA256.test(canonical.hash), `${label} canonical dependency hash is invalid`);
  canonicalInteger(canonical.entries, 1, 100_000, `${label} canonical dependency entry count`);
  const execution = validatePathPrefixExecutionReceipt(distribution.dependencySnapshot.executionIdentity);
  assert.equal(canonical.executionHash, execution.sha256, `${label} canonical execution hash mismatch`);
  assert.equal(execution.inputs.source.commit, distribution.sourceCommit, `${label} execution source commit mismatch`);
  assert.equal(execution.inputs.source.tree, distribution.sourceTree, `${label} execution source tree mismatch`);
  const modules = distribution.dependencySnapshot.modulesMetadata;
  exactKeys(modules, ["path", "sha256", "size", "prunedAt", "virtualStoreDir"], `${label} raw pnpm metadata`);
  assert.equal(modules.path, ".modules.yaml", `${label} raw pnpm metadata path mismatch`);
  assert(SHA256.test(modules.sha256), `${label} raw pnpm metadata hash is invalid`);
  canonicalInteger(modules.size, 1, 256 * 1024 * 1024, `${label} raw pnpm metadata size`);
  boundedText(modules.prunedAt, 1_024, `${label} raw pnpm prunedAt`);
  assert(Number.isFinite(Date.parse(modules.prunedAt)), `${label} raw pnpm prunedAt is invalid`);
  boundedText(modules.virtualStoreDir, 4_096, `${label} raw pnpm virtualStoreDir`);
  const workspace = distribution.dependencySnapshot.workspaceMetadata;
  exactKeys(workspace, ["path", "sha256", "size", "lastValidatedTimestamp", "projectRoots"],
    `${label} raw pnpm workspace metadata`);
  assert.equal(workspace.path, PNPM_WORKSPACE_STATE, `${label} raw workspace metadata path mismatch`);
  assert(SHA256.test(workspace.sha256), `${label} raw workspace hash is invalid`);
  canonicalInteger(workspace.size, 1, 256 * 1024 * 1024, `${label} raw workspace size`);
  canonicalInteger(workspace.lastValidatedTimestamp, 1, Number.MAX_SAFE_INTEGER, `${label} raw workspace timestamp`);
  assert(Array.isArray(workspace.projectRoots) && workspace.projectRoots.length > 0,
    `${label} raw workspace project roots are missing`);
  for (const root of workspace.projectRoots) boundedText(root, 4_096, `${label} workspace project root`);
  const tasks = distribution.dependencySnapshot.taskMetadata;
  exactKeys(tasks, ["schemaVersion", "sourceCommit", "latest", "completedInvocations", "files"],
    `${label} raw pnpm task metadata`);
  assert.equal(tasks.schemaVersion, 1, `${label} raw task metadata version mismatch`);
  assert.equal(tasks.sourceCommit, PNPM_METADATA_SOURCE, `${label} reviewed pnpm task semantics mismatch`);
  exactKeys(tasks.latest, ["version", "invocation", "run"], `${label} raw task header`);
  assert.equal(tasks.latest.version, 1, `${label} task header version mismatch`);
  assert(SHA256.test(tasks.latest.invocation), `${label} task invocation is invalid`);
  assert(/^[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(tasks.latest.run),
    `${label} task run identity is invalid`);
  assert(Array.isArray(tasks.completedInvocations) && tasks.completedInvocations.every(value => SHA256.test(value)) &&
    tasks.completedInvocations.includes(tasks.latest.invocation), `${label} completed task invocations are invalid`);
  assert(Array.isArray(tasks.files) && tasks.files.length === tasks.completedInvocations.length + 1,
    `${label} raw task file inventory is invalid`);
  for (const file of tasks.files) {
    exactKeys(file, ["path", "sha256", "size"], `${label} raw task file`);
    assert(file.path.startsWith(`${PNPM_TASK_STATE}/`) && !file.path.includes("..") && !file.path.includes("\\"),
      `${label} raw task file path is invalid`);
    assert(SHA256.test(file.sha256), `${label} raw task file hash is invalid`);
    canonicalInteger(file.size, 0, 256 * 1024 * 1024, `${label} raw task file size`);
  }
  assert(Array.isArray(distribution.nativeArtifacts) && distribution.nativeArtifacts.length > 0,
    `${label} native artifact inventory is empty`);
  for (const [index, artifact] of distribution.nativeArtifacts.entries()) {
    exactKeys(artifact, ["path", "sha256", "size"], `${label} native artifact ${index + 1}`);
    assert(typeof artifact.path === "string" && artifact.path.endsWith(".node") &&
      !artifact.path.includes("..") && !artifact.path.includes("\\"),
    `${label} native artifact path is invalid`);
    assert(SHA256.test(artifact.sha256), `${label} native artifact hash is invalid`);
    canonicalInteger(artifact.size, 1, 256 * 1024 * 1024, `${label} native artifact size`);
  }
  assert.deepEqual(distribution.nativeArtifacts.map(({ path: artifactPath }) => artifactPath),
    [...distribution.nativeArtifacts.map(({ path: artifactPath }) => artifactPath)].sort(),
    `${label} native artifact order mismatch`);
  exactKeys(distribution.distTreeHash, ["algorithm", "hash", "entries", "bytes"],
    `${label} dist tree hash`);
  assert.equal(distribution.distTreeHash.algorithm, "bounded-tree-sha256-v1",
    `${label} dist tree algorithm mismatch`);
  assert(SHA256.test(distribution.distTreeHash.hash), `${label} dist tree digest is invalid`);
  canonicalInteger(distribution.distTreeHash.entries, 1, 20_000, `${label} dist entries`);
  canonicalInteger(distribution.distTreeHash.bytes, 1, 1024 * 1024 * 1024, `${label} dist bytes`);
  validatePhysicalSnapshot(distribution.physical, `${label} physical snapshot`);
  const pathSuffix = `/${distribution.artifactPathId}`;
  for (const key of ["path", "realpath"]) {
    const normalized = distribution.physical[key].replaceAll("\\", "/").toLowerCase();
    assert(normalized.endsWith(pathSuffix), `${label} physical ${key} does not bind its artifact path`);
  }
  return distribution;
}

function distinctPhysicalDistributions(candidate, baseline, label, requireSameInventory) {
  assert.notEqual(candidate.physical.realpath.toLowerCase(), baseline.physical.realpath.toLowerCase(),
    `${label} distribution paths are not distinct`);
  assert.notDeepEqual([candidate.physical.identity.dev, candidate.physical.identity.ino],
    [baseline.physical.identity.dev, baseline.physical.identity.ino],
    `${label} distribution roots are not physically distinct`);
  const candidateEntries = new Map(candidate.physical.entries.map((entry) => [entry.path, entry]));
  const baselineEntries = new Map(baseline.physical.entries.map((entry) => [entry.path, entry]));
  if (requireSameInventory) {
    assert.deepEqual([...candidateEntries].map(([entryPath, { type }]) => [entryPath, type]),
      [...baselineEntries].map(([entryPath, { type }]) => [entryPath, type]),
      `${label} physical distribution entry inventory differs`);
  }
  for (const [entryPath, left] of candidateEntries) {
    const right = baselineEntries.get(entryPath);
    if (left.type !== "file" || right?.type !== "file") continue;
    assert.notDeepEqual([left.dev, left.ino], [right.dev, right.ino],
      `${label} cross-install file is hardlinked: ${entryPath}`);
  }
}

function validateFamily(family, expectedJob, label) {
  exactKeys(family, ["family", "status", "excluded", "planHash", "planFileHash", "studyHash",
    "candidateDistribution", "baselineDistribution", "reports"], label);
  assert(FAMILY_SET.has(family.family), `${label} comparison family is invalid`);
  assert.equal(family.status, "complete", `${label} did not complete`);
  assert.equal(family.excluded, false, `${label} was excluded`);
  for (const key of ["planHash", "planFileHash", "studyHash"]) {
    assert(SHA256.test(family[key]), `${label} ${key} is invalid`);
  }
  validateDistribution(family.candidateDistribution, `${label} candidate distribution`);
  validateDistribution(family.baselineDistribution, `${label} baseline distribution`);
  assert.deepEqual(
    [family.candidateDistribution.buildId, family.candidateDistribution.artifactPathId],
    ["candidate-build", "candidate/dist"],
    `${label} candidate distribution role mapping mismatch`,
  );
  if (family.family === "same-artifact") {
    assert.deepEqual(
      [family.baselineDistribution.buildId, family.baselineDistribution.artifactPathId],
      ["candidate-build", "candidate/dist"],
      `${label} same-artifact baseline role mapping mismatch`,
    );
    assert.deepEqual(family.candidateDistribution, family.baselineDistribution,
      `${label} same-artifact distribution differs`);
  } else {
    assert.deepEqual(
      [family.baselineDistribution.buildId, family.baselineDistribution.artifactPathId],
      ["baseline-build", "baseline/dist"],
      `${label} baseline distribution role mapping mismatch`,
    );
    distinctPhysicalDistributions(family.candidateDistribution, family.baselineDistribution, label,
      family.family === "same-source-rebuild");
    if (family.family === "same-source-rebuild") {
      assert.equal(family.candidateDistribution.sourceCommit, family.baselineDistribution.sourceCommit,
        `${label} same-source commit differs`);
      assert.deepEqual(family.candidateDistribution.distTreeHash, family.baselineDistribution.distTreeHash,
        `${label} same-source dist bytes differ`);
      assert.equal(family.candidateDistribution.runnerDistHash, family.baselineDistribution.runnerDistHash,
        `${label} same-source runner dist bytes differ`);
      assert.deepEqual(family.candidateDistribution.nativeArtifacts,
        family.baselineDistribution.nativeArtifacts, `${label} same-source native artifact bytes differ`);
      assert.deepEqual(family.candidateDistribution.dependencySnapshot.canonical,
        family.baselineDistribution.dependencySnapshot.canonical, `${label} same-source dependency layout differs`);
    } else {
      assert.notEqual(family.candidateDistribution.sourceCommit, family.baselineDistribution.sourceCommit,
        `${label} source comparison commits are identical`);
    }
  }
  const expectedReports = expectedPathPrefixReports(expectedJob.order);
  assert.deepEqual(family.reports.map(({ file }) => file), expectedReports.map(({ file }) => file),
    `${label} report inventory mismatch`);
  family.reports.forEach((report, index) => validateReport(report, expectedReports[index],
    `${label} report ${index + 1}`));
  return family;
}

export function validatePathPrefixJobReceipt(receipt, manifest) {
  validatePathPrefixPerformanceManifest(manifest);
  exactKeys(receipt, ["schema", "version", "status", "excluded", "campaignHash", "manifestFileHash",
    "job", "workflow", "launchNonce", "startedAt", "finishedAt", "runtime", "analyzer", "inventory",
    "families"],
  "path-prefix job receipt");
  assert.equal(receipt.schema, PATH_PREFIX_JOB_SCHEMA, "job receipt schema mismatch");
  assert.equal(receipt.version, PATH_PREFIX_PERFORMANCE_VERSION, "job receipt version mismatch");
  assert.equal(receipt.status, "complete", "outer job did not complete");
  assert.equal(receipt.excluded, false, "outer job was excluded");
  assert.equal(receipt.campaignHash, manifest.campaignHash, "job campaign hash mismatch");
  assert(SHA256.test(receipt.manifestFileHash), "job manifest file hash is invalid");
  const job = exactJob(receipt.job, "job receipt matrix cell");
  assert.deepEqual(receipt.workflow, manifest.workflow, "job workflow run/attempt mismatch");
  assert(UUID.test(receipt.launchNonce), "job launch nonce is invalid");
  isoTimestamp(receipt.startedAt, "job start timestamp");
  isoTimestamp(receipt.finishedAt, "job finish timestamp");
  assert(new Date(receipt.finishedAt).getTime() >= new Date(receipt.startedAt).getTime(),
    "job finish precedes its start");
  exactKeys(receipt.runtime, ["platform", "arch", "node", "runnerOS", "runnerArch", "imageOS",
    "imageVersion", "runnerEnvironment", "githubJob"], "job runtime");
  assert.equal(receipt.runtime.platform, job.runtimePlatform, "job runtime platform mismatch");
  assert.equal(receipt.runtime.runnerOS, job.runnerOS, "job runner OS mismatch");
  assert.equal(receipt.runtime.runnerArch, job.runnerArch, "job runner architecture mismatch");
  assert.equal(receipt.runtime.arch, job.runnerArch.toLowerCase(), "job process architecture mismatch");
  assert.match(receipt.runtime.node, new RegExp(`^v${job.nodeVersion}\\.`), "job Node version mismatch");
  for (const key of ["node", "arch", "runnerOS", "runnerArch", "imageOS", "imageVersion",
    "runnerEnvironment", "githubJob"]) boundedText(receipt.runtime[key], 1_024, `job runtime ${key}`);
  assert.deepEqual(receipt.analyzer, manifest.analyzer, "job analyzer identity mismatch");
  assert(Array.isArray(receipt.inventory) && receipt.inventory.length > 0, "job evidence inventory is empty");
  const inventoryPaths = receipt.inventory.map(({ path: entryPath }) => entryPath);
  assert.equal(new Set(inventoryPaths).size, inventoryPaths.length, "job evidence inventory has duplicates");
  for (const [index, entry] of receipt.inventory.entries()) {
    exactKeys(entry, ["path", "sha256", "size"], `job inventory entry ${index + 1}`);
    assert(/^[a-z0-9][a-z0-9./-]*$/u.test(entry.path) && !entry.path.includes(".."),
      "job evidence inventory path is unsafe");
    assert(SHA256.test(entry.sha256), "job evidence inventory hash is invalid");
    canonicalInteger(entry.size, 1, 256 * 1024 * 1024, "job evidence inventory size");
  }
  assert.deepEqual(receipt.families.map(({ family }) => family), PATH_PREFIX_COMPARISON_FAMILIES,
    "job comparison family inventory mismatch");
  receipt.families.forEach((family, index) => {
    validateFamily(family, job, `job ${job.id} family ${index + 1}`);
    const sources = expectedPathPrefixFamilySources(manifest, family.family);
    assert.deepEqual(
      [family.candidateDistribution.sourceCommit, family.candidateDistribution.sourceTree],
      [sources.candidate.commit, sources.candidate.tree],
      `job ${job.id} ${family.family} candidate source mismatch`,
    );
    assert.deepEqual(
      [family.baselineDistribution.sourceCommit, family.baselineDistribution.sourceTree],
      [sources.baseline.commit, sources.baseline.tree],
      `job ${job.id} ${family.family} baseline source mismatch`,
    );
  });
  assert.equal(new Set(receipt.families.map(({ planHash }) => planHash)).size,
    PATH_PREFIX_COMPARISON_FAMILIES.length, "comparison family plan hashes are not distinct");
  return receipt;
}

function sortedMedian(values) {
  assert(values.length > 0, "cannot summarize an empty sample stream");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function gateMetric(candidate, baseline, relativeLimit, absoluteLimit) {
  const absoluteRegressionUs = candidate - baseline;
  const relativeRegression = baseline === 0
    ? (candidate > 0 ? Number.POSITIVE_INFINITY : 0)
    : absoluteRegressionUs / baseline;
  return {
    candidate,
    baseline,
    absoluteRegressionUs,
    relativeRegression: Number.isFinite(relativeRegression) ? relativeRegression : "+Infinity",
    relativeLimit,
    absoluteLimitUs: absoluteLimit,
    failed: relativeRegression > relativeLimit || absoluteRegressionUs > absoluteLimit,
  };
}

export function pathPrefixPerformanceGate(candidateSamples, baselineSamples) {
  assert.equal(candidateSamples.length, baselineSamples.length, "candidate/baseline sample counts differ");
  assert(candidateSamples.length > 0, "gate has no raw samples");
  candidateSamples.forEach((sample, index) => assert(Number.isFinite(sample) && sample >= 0,
    `candidate sample ${index + 1} is invalid`));
  baselineSamples.forEach((sample, index) => assert(Number.isFinite(sample) && sample >= 0,
    `baseline sample ${index + 1} is invalid`));
  return {
    sampleCountPerArm: candidateSamples.length,
    median: gateMetric(sortedMedian(candidateSamples), sortedMedian(baselineSamples), 0.10, 50),
    maximumSampleAverage: gateMetric(Math.max(...candidateSamples), Math.max(...baselineSamples),
      0.20, 100),
  };
}

function rowSamples(family, mode, rowName, role, block = null) {
  return family.reports
    .filter((report) => report.mode === mode && report.role === role &&
      (block === null || report.block === block))
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((report) => report.rows.find(({ name }) => name === rowName).samplesUs);
}

export function buildPathPrefixPerformanceGates(receipts) {
  const gates = [];
  for (const receipt of receipts) {
    for (const family of receipt.families) {
      for (const mode of PATH_PREFIX_NATIVE_MODES) {
        for (const row of PATH_PREFIX_CAMPAIGN_NAMES) {
          for (const scope of PATH_PREFIX_GATE_SCOPES) {
            const block = scope === "pooled" ? null : Number(scope.slice("block-".length));
            const candidate = rowSamples(family, mode, row, "candidate", block);
            const baseline = rowSamples(family, mode, row, "baseline", block);
            const expectedSamples = PATH_PREFIX_SAMPLES * 2 * (block === null ? PATH_PREFIX_BLOCKS : 1);
            assert.equal(candidate.length, expectedSamples, "candidate raw sample inventory mismatch");
            assert.equal(baseline.length, expectedSamples, "baseline raw sample inventory mismatch");
            gates.push({
              jobId: receipt.job.id,
              platform: receipt.job.platform,
              nodeVersion: receipt.job.nodeVersion,
              order: receipt.job.order,
              family: family.family,
              mode,
              row,
              scope,
              ...pathPrefixPerformanceGate(candidate, baseline),
            });
          }
        }
      }
    }
  }
  return gates;
}

function failureRecord(error) {
  return {
    type: "provenance",
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
  };
}

export function analyzePathPrefixPerformanceCampaign(manifest, receipts) {
  const failures = [];
  let normalizedManifest;
  try {
    normalizedManifest = validatePathPrefixPerformanceManifest(manifest);
  } catch (error) {
    return {
      schema: PATH_PREFIX_ANALYSIS_SCHEMA,
      version: PATH_PREFIX_PERFORMANCE_VERSION,
      overall: "REJECT",
      campaignHash: manifest?.campaignHash ?? null,
      declaredJobs: PATH_PREFIX_OUTER_JOBS.length,
      completedJobs: 0,
      gates: [],
      failures: [failureRecord(error)],
    };
  }
  const byJob = new Map();
  const nonces = new Set();
  for (const [index, receipt] of receipts.entries()) {
    try {
      validatePathPrefixJobReceipt(receipt, normalizedManifest);
      assert(!byJob.has(receipt.job.id), `duplicate outer job receipt: ${receipt.job.id}`);
      assert(!nonces.has(receipt.launchNonce), `duplicate outer job launch nonce: ${receipt.launchNonce}`);
      byJob.set(receipt.job.id, receipt);
      nonces.add(receipt.launchNonce);
    } catch (error) {
      failures.push({ ...failureRecord(error), receiptIndex: index });
    }
  }
  for (const expected of PATH_PREFIX_OUTER_JOBS) {
    if (!byJob.has(expected.id)) failures.push({ type: "missing-job", jobId: expected.id });
  }
  for (const id of byJob.keys()) {
    if (!PLATFORM_BY_ID.has(id)) failures.push({ type: "unexpected-job", jobId: id });
  }
  let gates = [];
  if (failures.length === 0 && byJob.size === PATH_PREFIX_OUTER_JOBS.length) {
    try {
      const ordered = PATH_PREFIX_OUTER_JOBS.map(({ id }) => byJob.get(id));
      gates = buildPathPrefixPerformanceGates(ordered);
      for (const gate of gates) {
        for (const metric of ["median", "maximumSampleAverage"]) {
          if (gate[metric].failed) failures.push({
            type: "regression",
            jobId: gate.jobId,
            family: gate.family,
            mode: gate.mode,
            row: gate.row,
            scope: gate.scope,
            metric,
            result: gate[metric],
          });
        }
      }
    } catch (error) {
      failures.push(failureRecord(error));
      gates = [];
    }
  }
  const expectedGateCount = PATH_PREFIX_OUTER_JOBS.length * PATH_PREFIX_COMPARISON_FAMILIES.length *
    PATH_PREFIX_NATIVE_MODES.length * PATH_PREFIX_CAMPAIGN_NAMES.length * PATH_PREFIX_GATE_SCOPES.length;
  if (gates.length !== 0 && gates.length !== expectedGateCount) {
    failures.push({ type: "gate-inventory", expected: expectedGateCount, actual: gates.length });
  }
  return {
    schema: PATH_PREFIX_ANALYSIS_SCHEMA,
    version: PATH_PREFIX_PERFORMANCE_VERSION,
    overall: failures.length === 0 && gates.length === expectedGateCount ? "ACCEPT" : "REJECT",
    campaignHash: normalizedManifest.campaignHash,
    declaredJobs: PATH_PREFIX_OUTER_JOBS.length,
    completedJobs: byJob.size,
    expectedGateCount,
    gates,
    failures,
  };
}
