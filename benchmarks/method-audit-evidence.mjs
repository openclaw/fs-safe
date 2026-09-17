import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  attachPlanHash,
  assertStableReportReceipt,
  createMethodAuditPlan,
  createReportEvidence,
  createRunnerArguments,
  digestJson,
  normalizeSha,
  normalizeSha256,
  selectNamedComparisonRef,
  validateCompleteReportSet,
  validateDispatchInputs,
  validatePlanHash,
} from "./method-audit-plan.mjs";
import { profileForFilenameSource } from "./filename-fallback-profile.mjs";
import { measuredSourceBinding } from "./measured-distribution.mjs";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const DIST_LIMITS = Object.freeze({ maxEntries: 20_000, maxBytes: 1024 * 1024 * 1024 });
const DEPENDENCY_LIMITS = Object.freeze({ maxEntries: 100_000, maxHashedBytes: 128 * 1024 * 1024 });
const DEPENDENCY_SCOPE = "pnpm-layout-manifests-locks-native-v1";
const DEPENDENCY_LIMITATION = "Hashes dependency paths, types, sizes, symlink targets, package manifests, pnpm metadata/locks, and native addons. Other dependency bytes are represented by the frozen lockfile and layout metadata, not rehashed in full.";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const command = argv[2];
  if (!command || !["prepare", "verify-harness", "snapshot", "measure"].includes(command)) {
    fail("expected prepare, verify-harness, snapshot, or measure command");
  }
  const options = {};
  for (let index = 3; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("command options must be --name value pairs");
    if (options[key.slice(2)] !== undefined) fail(`duplicate option ${key}`);
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function exactOptions(options, required) {
  const actual = Object.keys(options).sort();
  const expected = [...required].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`expected options: ${expected.map((key) => `--${key}`).join(", ")}`);
}

function absoluteOption(options, name) {
  const value = options[name];
  if (!path.isAbsolute(value)) fail(`--${name} must be absolute`);
  return path.resolve(value);
}

function git(root, args, { buffer = false, allowFailure = false } = {}) {
  const result = spawnSync("git", ["--no-replace-objects", "-C", root, ...args], {
    encoding: buffer ? undefined : "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = buffer ? result.stderr?.toString("utf8") : result.stderr;
    fail(`git ${args[0]} failed: ${detail?.trim() || `status ${result.status}`}`);
  }
  return result;
}

function gitText(root, args) {
  return git(root, args).stdout.trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inspectFile(file, byteLimit = MAX_FILE_BYTES, includeBytes = false) {
  const handle = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    if (!before.isFile() || before.size > BigInt(byteLimit)) fail(`unsafe or oversized evidence file: ${file}`);
    const hash = createHash("sha256");
    const bytes = includeBytes ? Buffer.alloc(Number(before.size)) : null;
    const buffer = bytes ?? Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const bufferOffset = bytes ? offset : 0;
      const bytesRead = fs.readSync(
        handle,
        buffer,
        bufferOffset,
        Math.min(bytes ? Number(before.size) - offset : buffer.length, Number(before.size) - offset),
        offset,
      );
      if (bytesRead === 0) fail(`short read while hashing ${file}`);
      hash.update(buffer.subarray(bufferOffset, bufferOffset + bytesRead));
      offset += bytesRead;
    }
    const after = fs.fstatSync(handle, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      fail(`file changed while hashing: ${file}`);
    }
    const pathname = fs.lstatSync(file, { bigint: true });
    if (!pathname.isFile() || pathname.dev !== after.dev || pathname.ino !== after.ino) fail(`file identity changed while hashing: ${file}`);
    return {
      bytes,
      receipt: {
        sha256: hash.digest("hex"),
        size: Number(after.size),
        dev: String(after.dev),
        ino: String(after.ino),
        mtimeNs: String(after.mtimeNs),
      },
    };
  } finally {
    fs.closeSync(handle);
  }
}

function hashFile(file, byteLimit = MAX_FILE_BYTES) {
  const { sha256, size } = inspectFile(file, byteLimit).receipt;
  return { sha256, size };
}

function readReport(file) {
  const inspected = inspectFile(file, MAX_FILE_BYTES, true);
  return { receipt: inspected.receipt, report: JSON.parse(inspected.bytes.toString("utf8")) };
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function assertInside(root, target, description) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return relative;
  fail(`${description} escapes its checkout`);
}

function assertRealDirectory(root, description) {
  const resolved = path.resolve(root);
  const real = fs.realpathSync.native(resolved);
  if (process.platform === "win32" ? real.toLowerCase() !== resolved.toLowerCase() : real !== resolved) {
    fail(`${description} must not be a link or alias`);
  }
  if (!fs.lstatSync(resolved).isDirectory()) fail(`${description} must be a directory`);
  return resolved;
}

function hashDistTree(distRoot) {
  const root = assertRealDirectory(distRoot, "dist root");
  const records = [];
  let entries = 0;
  let bytes = 0;
  const walk = (directory, relativeDirectory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      entries += 1;
      if (entries > DIST_LIMITS.maxEntries) fail("dist tree exceeds the evidence entry limit");
      const full = path.join(directory, name);
      const relative = slash(path.join(relativeDirectory, name));
      const stat = fs.lstatSync(full, { bigint: true });
      if (stat.isSymbolicLink()) fail(`dist tree contains a link: ${relative}`);
      if (stat.isDirectory()) {
        records.push({ path: `${relative}/`, type: "directory" });
        walk(full, relative);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1n) fail(`dist tree contains a hardlinked file: ${relative}`);
        const identity = hashFile(full);
        bytes += identity.size;
        if (bytes > DIST_LIMITS.maxBytes) fail("dist tree exceeds the evidence byte limit");
        records.push({ path: relative, type: "file", ...identity });
      } else {
        fail(`dist tree contains an unsupported entry: ${relative}`);
      }
    }
  };
  walk(root, "");
  return { algorithm: "bounded-tree-sha256-v1", hash: digestJson(records), entries, bytes };
}

function shouldHashDependency(relative) {
  const base = path.posix.basename(relative);
  return base === "package.json" || base === ".modules.yaml" || base === "lock.yaml" ||
    base === "pnpm-lock.yaml" || relative.endsWith(".node");
}

function snapshotDependencies(checkoutRoot) {
  const checkout = assertRealDirectory(checkoutRoot, "checkout root");
  const dependencyRoot = assertRealDirectory(path.join(checkout, "node_modules"), "dependency root");
  const records = [];
  const nativeArtifacts = [];
  let entries = 0;
  let hashedBytes = 0;
  const walk = (directory, relativeDirectory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      entries += 1;
      if (entries > DEPENDENCY_LIMITS.maxEntries) fail("dependency layout exceeds the evidence entry limit");
      const full = path.join(directory, name);
      const relative = slash(path.join(relativeDirectory, name));
      if (Buffer.byteLength(relative, "utf8") > 4096) fail("dependency layout contains an oversized path");
      const stat = fs.lstatSync(full, { bigint: true });
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync.native(full);
        const targetRelative = slash(assertInside(checkout, target, `dependency link ${relative}`));
        records.push({ path: relative, type: "link", target: targetRelative });
      } else if (stat.isDirectory()) {
        records.push({ path: `${relative}/`, type: "directory" });
        walk(full, relative);
      } else if (stat.isFile()) {
        if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`dependency file is too large to identify: ${relative}`);
        const record = { path: relative, type: "file", size: Number(stat.size) };
        if (shouldHashDependency(relative)) {
          const identity = hashFile(full);
          hashedBytes += identity.size;
          if (hashedBytes > DEPENDENCY_LIMITS.maxHashedBytes) fail("dependency layout exceeds the evidence hash byte limit");
          record.sha256 = identity.sha256;
          if (relative.endsWith(".node")) nativeArtifacts.push({ path: `node_modules/${relative}`, ...identity });
        }
        records.push(record);
      } else {
        fail(`dependency layout contains an unsupported entry: ${relative}`);
      }
    }
  };
  walk(dependencyRoot, "");
  return {
    snapshot: {
      schemaVersion: 1,
      scope: DEPENDENCY_SCOPE,
      hash: digestJson(records),
      entries,
      hashedBytes,
      limits: { ...DEPENDENCY_LIMITS },
      limitation: DEPENDENCY_LIMITATION,
    },
    nativeArtifacts,
  };
}

function collectStagedNative(checkoutRoot, existing) {
  const artifacts = new Map(existing.map((entry) => [entry.path, entry]));
  const roots = ["packages", "native"].map((name) => path.join(checkoutRoot, name)).filter(fs.existsSync);
  let entries = 0;
  const walk = (root, directory, recursive) => {
    for (const name of fs.readdirSync(directory).sort()) {
      entries += 1;
      if (entries > 20_000) fail("native artifact scan exceeds its entry limit");
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail(`native artifact root contains a link: ${slash(path.relative(checkoutRoot, full))}`);
      if (stat.isDirectory() && recursive) walk(root, full, true);
      else if (stat.isFile() && name.endsWith(".node")) {
        const relative = slash(path.relative(checkoutRoot, full));
        artifacts.set(relative, { path: relative, ...hashFile(full) });
      }
    }
  };
  for (const root of roots) walk(root, root, path.basename(root) === "packages");
  return [...artifacts.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function runnerDistHash(distRoot) {
  const parts = [];
  for (const name of fs.readdirSync(distRoot).filter((entry) => /\.(js|wasm)$/u.test(entry)).sort()) {
    const full = path.join(distRoot, name);
    if (!fs.lstatSync(full).isFile()) fail(`runner distribution entry is unsafe: ${name}`);
    parts.push(name + hashFile(full).sha256);
  }
  return sha256(parts.join("\n"));
}

function benchmarkHash(checkoutRoot) {
  const hash = createHash("sha256");
  const directory = path.join(checkoutRoot, "benchmarks");
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".mjs")).sort()) {
    hash.update(name).update(fs.readFileSync(path.join(directory, name)));
  }
  for (const name of ["package.json", "pnpm-lock.yaml"]) hash.update(fs.readFileSync(path.join(checkoutRoot, name)));
  return hash.digest("hex");
}

function gitCheckoutIdentity(root, expected, role) {
  const commit = normalizeSha(`${role} checkout SHA`, gitText(root, ["rev-parse", "HEAD"]));
  const tree = normalizeSha(`${role} checkout tree`, gitText(root, ["rev-parse", "HEAD^{tree}"]));
  if (commit !== expected.commit || tree !== expected.tree) fail(`${role} checkout does not match the resolved source`);
  const trackedStatus = gitText(root, ["status", "--porcelain=v1", "--untracked-files=no"]);
  if (trackedStatus !== "") fail(`${role} checkout has tracked modifications`);
  const manifestHash = hashFile(path.join(root, "package.json")).sha256;
  const lockfileHash = hashFile(path.join(root, "pnpm-lock.yaml")).sha256;
  if (manifestHash !== expected.manifestHash || lockfileHash !== expected.lockfileHash) {
    fail(`${role} manifest or lockfile does not match the resolved source`);
  }
  const identity = { commit, tree, manifestHash, lockfileHash };
  const expectsFilenameSource = expected.filenameSourceBlob !== undefined ||
    expected.filenameSourceHash !== undefined || expected.filenameFallbackProfile !== undefined;
  if (!expectsFilenameSource) return identity;
  const filenameSourceBlob = normalizeSha(
    `${role} filename source blob`,
    gitText(root, ["rev-parse", "HEAD:src/filename.ts"]),
  );
  const filenameSourceHash = hashFile(path.join(root, "src", "filename.ts")).sha256;
  const filenameFallbackProfile = profileForFilenameSource(
    filenameSourceBlob,
    fs.readFileSync(path.join(root, "src", "filename.ts")),
  );
  if (filenameSourceBlob !== expected.filenameSourceBlob ||
      filenameSourceHash !== expected.filenameSourceHash ||
      filenameFallbackProfile !== expected.filenameFallbackProfile) {
    fail(`${role} filename source does not match the resolved source blob`);
  }
  return {
    ...identity,
    filenameSourceBlob,
    filenameSourceHash,
    filenameFallbackProfile,
  };
}

function installationSnapshot(root, source, role) {
  const checkout = gitCheckoutIdentity(root, source, role);
  const distRoot = path.join(root, "dist");
  const dependencies = snapshotDependencies(root);
  return {
    installationSchemaVersion: 1,
    ...checkout,
    distTreeHash: hashDistTree(distRoot),
    runnerDistHash: runnerDistHash(distRoot),
    dependencySnapshot: dependencies.snapshot,
    nativeArtifacts: collectStagedNative(root, dependencies.nativeArtifacts),
  };
}

function requireFixedRoots(options) {
  const harness = assertRealDirectory(absoluteOption(options, "harness-root"), "harness checkout");
  const candidate = assertRealDirectory(absoluteOption(options, "candidate-root"), "candidate checkout");
  const baseline = assertRealDirectory(absoluteOption(options, "baseline-root"), "baseline checkout");
  const parent = path.dirname(harness);
  for (const [name, root] of [["harness", harness], ["candidate", candidate], ["baseline", baseline]]) {
    if (path.basename(root) !== name || path.dirname(root) !== parent) fail("study checkouts must use fixed sibling harness/candidate/baseline paths");
  }
  return { harness, candidate, baseline };
}

function loadPlan(file, expectedFileHash) {
  if (hashFile(file).sha256 !== expectedFileHash.toLowerCase()) fail("downloaded method-audit plan file hash mismatch");
  return validatePlanHash(JSON.parse(fs.readFileSync(file, "utf8")));
}

function verifyHarnessCheckout(plan, harnessRoot) {
  const harnessExpected = {
    commit: plan.harness.sha,
    tree: plan.harness.tree,
    manifestHash: plan.harness.manifestHash,
    lockfileHash: plan.harness.lockfileHash,
  };
  const harnessCheckout = gitCheckoutIdentity(harnessRoot, harnessExpected, "harness");
  const actualBenchmarkHash = benchmarkHash(harnessRoot);
  const workflowFileHash = hashFile(path.join(harnessRoot, plan.harness.workflowPath)).sha256;
  if (actualBenchmarkHash !== plan.harness.benchmarkHash || workflowFileHash !== plan.harness.workflowFileHash) {
    fail("reviewed harness content does not match the prepared plan");
  }
  return { ...harnessCheckout, workflowFileHash, benchmarkHash: actualBenchmarkHash };
}

function createSnapshot(plan, roots) {
  const harnessCheckout = verifyHarnessCheckout(plan, roots.harness);
  const harnessDependencies = snapshotDependencies(roots.harness).snapshot;
  const checkouts = {
    candidate: gitCheckoutIdentity(roots.candidate, plan.sources.candidate, "candidate"),
    baseline: null,
  };
  if (plan.sources.baseline) checkouts.baseline = gitCheckoutIdentity(roots.baseline, plan.sources.baseline, "baseline");
  const builds = {};
  for (const build of plan.builds) {
    const root = roots[build.checkout];
    builds[build.id] = installationSnapshot(root, plan.sources[build.sourceRole], build.sourceRole);
  }
  return {
    schemaVersion: 1,
    planHash: plan.planHash,
    harness: {
      ...harnessCheckout,
      dependencySnapshot: harnessDependencies,
    },
    checkouts,
    builds,
  };
}

function trackedBlobIdentity(root, commit, file) {
  const listing = git(root, ["ls-tree", "-z", commit, "--", file], { buffer: true }).stdout;
  const record = listing.toString("utf8").replace(/\0$/u, "");
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(record);
  if (!match || match[3] !== file) fail(`${file} is missing or unsafe at ${commit}`);
  const bytes = git(root, ["cat-file", "blob", match[2]], { buffer: true }).stdout;
  return { blob: match[2], hash: sha256(bytes), bytes };
}

function trackedBlob(root, commit, file) {
  return trackedBlobIdentity(root, commit, file).bytes;
}

function sourceResolution(root, requestedRef, commit, matchedRef = null) {
  const probe = git(root, ["cat-file", "-e", `${commit}^{commit}`], { allowFailure: true });
  if (probe.status !== 0) {
    normalizeSha("unavailable exact commit", commit);
    git(root, ["fetch", "--no-tags", "--depth=1", "origin", commit]);
  }
  const resolvedCommit = normalizeSha("resolved commit", gitText(root, ["rev-parse", "--verify", `${commit}^{commit}`]));
  const tree = normalizeSha("resolved tree", gitText(root, ["rev-parse", "--verify", `${resolvedCommit}^{tree}`]));
  const filenameSource = trackedBlobIdentity(root, resolvedCommit, "src/filename.ts");
  return {
    requestedRef: requestedRef || null,
    matchedRef,
    commit: resolvedCommit,
    tree,
    manifestHash: sha256(trackedBlob(root, resolvedCommit, "package.json")),
    lockfileHash: sha256(trackedBlob(root, resolvedCommit, "pnpm-lock.yaml")),
    filenameSourceBlob: filenameSource.blob,
    filenameSourceHash: filenameSource.hash,
    filenameFallbackProfile: profileForFilenameSource(filenameSource.blob, filenameSource.bytes),
  };
}

function availableRefs(root) {
  const output = gitText(root, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(*objectname)",
    "refs/remotes/origin",
    "refs/tags",
  ]);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [name, object, peeled] = line.split("\t");
    return { name, commit: peeled || object };
  }).filter(({ name }) => name !== "refs/remotes/origin/HEAD");
}

function prepare(options) {
  exactOptions(options, ["harness-root", "output"]);
  const harnessRoot = absoluteOption(options, "harness-root");
  const output = absoluteOption(options, "output");
  if (path.basename(harnessRoot) !== "harness") fail("prepare checkout must use the fixed harness path");
  const inputs = validateDispatchInputs({
    platform: process.env.METHOD_PLATFORM,
    compare_ref: process.env.METHOD_COMPARE_REF,
    candidate_ref: process.env.METHOD_CANDIDATE_REF,
    iterations: process.env.METHOD_ITERATIONS,
    samples: process.env.METHOD_SAMPLES,
    filter: process.env.METHOD_FILTER,
    order: process.env.METHOD_ORDER,
    blocks: process.env.METHOD_BLOCKS,
    native_mode: process.env.METHOD_NATIVE_MODE,
    node_version: process.env.METHOD_NODE_VERSION,
    control: process.env.METHOD_CONTROL,
    timeout_minutes: process.env.METHOD_TIMEOUT_MINUTES,
    expected_harness_sha: process.env.METHOD_EXPECTED_HARNESS_SHA,
  });
  const workflowSha = normalizeSha("github.workflow_sha", process.env.METHOD_WORKFLOW_SHA);
  const workflowPath = process.env.METHOD_WORKFLOW_PATH ?? ".github/workflows/benchmarks.yml";
  if (![".github/workflows/benchmarks.yml", ".github/workflows/atomic-settlement-performance.yml"]
    .includes(workflowPath)) {
    fail("unsupported method-audit workflow path");
  }
  const eventSha = normalizeSha("github.sha", process.env.METHOD_EVENT_SHA);
  const campaignManifestSha256 = process.env.METHOD_CAMPAIGN_MANIFEST_SHA256 === undefined
    ? undefined
    : normalizeSha256("campaign manifest hash", process.env.METHOD_CAMPAIGN_MANIFEST_SHA256);
  const checkedOutSha = normalizeSha("harness checkout SHA", gitText(harnessRoot, ["rev-parse", "HEAD"]));
  if (checkedOutSha !== workflowSha) fail("harness checkout does not match github.workflow_sha");
  if (inputs.expectedHarnessSha && inputs.expectedHarnessSha !== workflowSha) fail("expected_harness_sha does not match github.workflow_sha");
  const candidateCommit = inputs.candidateRef || eventSha;
  const candidate = sourceResolution(harnessRoot, inputs.candidateRef, candidateCommit);
  let baseline = null;
  if (inputs.compareRef) {
    if (/^[0-9a-f]{40}$/u.test(inputs.compareRef)) {
      baseline = sourceResolution(harnessRoot, inputs.compareRef, inputs.compareRef);
    } else {
      const selected = selectNamedComparisonRef(inputs.compareRef, availableRefs(harnessRoot));
      baseline = sourceResolution(harnessRoot, inputs.compareRef, selected.commit, selected.name);
    }
  }
  const harnessTree = normalizeSha("harness tree", gitText(harnessRoot, ["rev-parse", "HEAD^{tree}"]));
  const manifestHash = sha256(trackedBlob(harnessRoot, workflowSha, "package.json"));
  const lockfileHash = sha256(trackedBlob(harnessRoot, workflowSha, "pnpm-lock.yaml"));
  const workflowFileHash = sha256(trackedBlob(harnessRoot, workflowSha, workflowPath));
  const plan = attachPlanHash(createMethodAuditPlan({
    inputs,
    harness: {
      workflowRef: process.env.METHOD_WORKFLOW_REF,
      workflowPath,
      sha: workflowSha,
      tree: harnessTree,
      workflowFileHash,
      benchmarkHash: benchmarkHash(harnessRoot),
      manifestHash,
      lockfileHash,
    },
    candidate,
    baseline,
    context: {
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      campaignManifestSha256,
    },
  }));
  fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  const outputs = {
    matrix: JSON.stringify(plan.matrix),
    harness_sha: plan.harness.sha,
    candidate_sha: plan.sources.candidate.commit,
    baseline_sha: plan.sources.baseline?.commit ?? "",
    has_baseline: String(Boolean(plan.sources.baseline)),
    baseline_build_required: String(plan.builds.some(({ id }) => id === "baseline-build")),
    node_version: plan.settings.nodeVersion,
    timeout_minutes: String(plan.settings.timeoutMinutes),
    control_kind: plan.settings.controlKind,
    plan_file_sha256: hashFile(output).sha256,
  };
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function snapshot(options) {
  exactOptions(options, ["plan", "expected-plan-file-hash", "harness-root", "candidate-root", "baseline-root", "output"]);
  const planFile = absoluteOption(options, "plan");
  const plan = loadPlan(planFile, options["expected-plan-file-hash"]);
  const roots = requireFixedRoots(options);
  const output = absoluteOption(options, "output");
  const evidence = createSnapshot(plan, roots);
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
}

function verifyHarness(options) {
  exactOptions(options, ["plan", "expected-plan-file-hash", "harness-root"]);
  const plan = loadPlan(absoluteOption(options, "plan"), options["expected-plan-file-hash"]);
  const harnessRoot = assertRealDirectory(absoluteOption(options, "harness-root"), "harness checkout");
  if (path.basename(harnessRoot) !== "harness") fail("reviewed harness must use the fixed harness path");
  verifyHarnessCheckout(plan, harnessRoot);
}

function runnerInvocation(plan, reportPlan, roots, outputRoot) {
  const build = plan.builds.find(({ id }) => id === reportPlan.buildId);
  if (!build) fail(`unknown build ${reportPlan.buildId}`);
  const reportPath = path.join(outputRoot, reportPlan.file);
  const args = createRunnerArguments({
    runnerFile: path.join(roots.harness, "benchmarks", "runner.mjs"),
    distRoot: path.join(roots[build.checkout], "dist"),
    reportFile: reportPath,
    mode: reportPlan.mode,
    settings: plan.settings,
    measuredSource: measuredSourceBinding(plan, reportPlan),
  });
  return {
    executable: process.execPath,
    args,
    cwd: roots.harness,
    env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" },
  };
}

function runnerMetadata() {
  return {
    platformSelection: process.env.METHOD_MATRIX_PLATFORM,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT || null,
    runnerOS: process.env.RUNNER_OS || null,
    runnerArch: process.env.RUNNER_ARCH || null,
    imageOS: process.env.ImageOS || null,
    imageVersion: process.env.ImageVersion || null,
    githubRunId: process.env.GITHUB_RUN_ID,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    githubJob: process.env.GITHUB_JOB,
  };
}

function measure(options) {
  exactOptions(options, ["plan", "expected-plan-file-hash", "before", "harness-root", "candidate-root", "baseline-root", "output-root"]);
  const planFile = absoluteOption(options, "plan");
  const expectedPlanFileHash = options["expected-plan-file-hash"].toLowerCase();
  const plan = loadPlan(planFile, expectedPlanFileHash);
  const before = JSON.parse(fs.readFileSync(absoluteOption(options, "before"), "utf8"));
  if (before.planHash !== plan.planHash) fail("before snapshot does not match the method-audit plan");
  const roots = requireFixedRoots(options);
  const outputRoot = absoluteOption(options, "output-root");
  fs.mkdirSync(outputRoot, { recursive: true });
  if (fs.readdirSync(outputRoot).length !== 0) fail("method-audit report directory must start empty");
  const runtime = runnerMetadata();
  const producedReceipts = new Map();
  for (const reportPlan of plan.reports) {
    if (!/^[a-z0-9-]+\.json$/u.test(reportPlan.file)) fail("plan contains an unsafe report filename");
    const reportPath = path.join(outputRoot, reportPlan.file);
    if (fs.existsSync(reportPath)) fail(`${reportPlan.file} exists before its benchmark process starts`);
    const invocation = runnerInvocation(plan, reportPlan, roots, outputRoot);
    const result = spawnSync(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.status !== 0) fail(`${reportPlan.file} measurement failed with status ${result.status}`);
    producedReceipts.set(reportPlan.file, inspectFile(reportPath).receipt);
  }
  const expectedFiles = plan.reports.map(({ file }) => file).sort();
  const producedFiles = fs.readdirSync(outputRoot).sort();
  if (JSON.stringify(producedFiles) !== JSON.stringify(expectedFiles)) {
    fail("method-audit report directory contains an incomplete or unexpected file set");
  }
  const after = createSnapshot(plan, roots);
  const reports = new Map();
  const stableReceipts = new Map();
  for (const reportPlan of plan.reports) {
    const observed = readReport(path.join(outputRoot, reportPlan.file));
    const stable = assertStableReportReceipt(reportPlan.file, producedReceipts.get(reportPlan.file), observed.receipt);
    stableReceipts.set(reportPlan.file, stable);
    reports.set(reportPlan.file, observed.report);
  }
  validateCompleteReportSet(plan, reports, before, after);
  const expectedPlatform = { linux: "linux", macos: "darwin", windows: "win32" }[process.env.METHOD_MATRIX_PLATFORM];
  if (!expectedPlatform || !plan.matrix.include.some(({ platform }) => platform === process.env.METHOD_MATRIX_PLATFORM)) {
    fail("runner platform is not in the validated matrix");
  }
  if ([...reports.values()].some((report) => report.metadata?.platform !== expectedPlatform)) {
    fail("method-audit report platform mismatch");
  }
  if (hashFile(planFile).sha256 !== expectedPlanFileHash) fail("method-audit plan changed during measurement");
  for (const reportPlan of plan.reports) {
    const reportPath = path.join(outputRoot, reportPlan.file);
    assertStableReportReceipt(
      reportPlan.file,
      stableReceipts.get(reportPlan.file),
      inspectFile(reportPath).receipt,
    );
    const report = reports.get(reportPlan.file);
    report.methodAuditEvidence = createReportEvidence(plan, reportPlan, report, before, runtime, {
      identityStableThroughStudy: true,
      runnerOutputReceipt: stableReceipts.get(reportPlan.file),
    });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const reportHashes = Object.fromEntries(plan.reports.map(({ file }) => [file, hashFile(path.join(outputRoot, file)).sha256]));
  const study = {
    schemaVersion: 1,
    plan,
    platform: process.env.METHOD_MATRIX_PLATFORM,
    before,
    after,
    runnerOutputReceipts: Object.fromEntries(stableReceipts),
    reports: reportHashes,
  };
  fs.writeFileSync(path.join(outputRoot, "study-provenance.json"), `${JSON.stringify(study, null, 2)}\n`, { flag: "wx" });
}

try {
  const { command, options } = parseArguments(process.argv);
  if (command === "prepare") prepare(options);
  else if (command === "verify-harness") verifyHarness(options);
  else if (command === "snapshot") snapshot(options);
  else measure(options);
} catch (error) {
  process.stderr.write(`method-audit evidence error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
