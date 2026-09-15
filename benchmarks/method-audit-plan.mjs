import { createHash } from "node:crypto";

const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const EXECUTION_TRUST = Object.freeze({
  model: "trusted-reviewed-revisions-v1",
  assumption: "Harness, candidate, and baseline revisions are trusted for execution. Evidence detects accidental identity drift; it is not a sandbox against hostile code.",
});
const PLATFORM_MATRIX = Object.freeze({
  all: [
    { platform: "linux", os: "ubuntu-latest" },
    { platform: "macos", os: "macos-15" },
    { platform: "windows", os: "windows-latest" },
  ],
  linux: [{ platform: "linux", os: "ubuntu-latest" }],
  macos: [{ platform: "macos", os: "macos-15" }],
  windows: [{ platform: "windows", os: "windows-latest" }],
});

export const METHOD_AUDIT_DEFAULTS = Object.freeze({
  platform: "all",
  compare_ref: "",
  candidate_ref: "",
  iterations: "20",
  samples: "5",
  filter: "",
  order: "baseline-candidate",
  blocks: "1",
  native_mode: "both",
  node_version: "24",
  control: "rebuild",
  timeout_minutes: "45",
  expected_harness_sha: "",
});

function fail(message) {
  throw new Error(message);
}

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) fail(`${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

function boundedText(name, value, maxBytes, { allowEmpty = true } = {}) {
  if (typeof value !== "string") fail(`${name} must be a string`);
  if ((!allowEmpty && value === "") || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`${name} must contain ${allowEmpty ? `at most ${maxBytes}` : `1 through ${maxBytes}`} UTF-8 bytes`);
  }
  if (CONTROL_PATTERN.test(value)) fail(`${name} must not contain control characters`);
  return value;
}

function canonicalInteger(name, value, minimum, maximum) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail(`${name} must be a canonical decimal integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

export function normalizeSha(name, value, { optional = false } = {}) {
  if (optional && value === "") return "";
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail(`${name} must be a full 40-hex commit SHA${optional ? " or empty" : ""}`);
  }
  return value.toLowerCase();
}

export function validateCompareRef(value) {
  boundedText("compare_ref", value, 256);
  if (value === "" || SHA_PATTERN.test(value)) return value.toLowerCase();
  if (value !== value.trim() || value.startsWith("-") || value.startsWith("+") ||
      value.includes("://") || value.startsWith("git@") || value.includes("..") ||
      value.includes("@{") || /[~^:?*[\\\s]/u.test(value) || value.includes("//") ||
      value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) {
    fail("compare_ref must be one unambiguous branch, tag, or full commit SHA");
  }
  const headRef = value.startsWith("refs/heads/");
  const tagRef = value.startsWith("refs/tags/");
  if (value.startsWith("refs/") && !headRef && !tagRef) {
    fail("compare_ref only accepts refs/heads/* or refs/tags/* explicit refs");
  }
  const selected = headRef ? value.slice("refs/heads/".length)
    : tagRef ? value.slice("refs/tags/".length) : value;
  if (!selected || selected === "HEAD" || selected === "@" ||
      selected.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
    fail("compare_ref must be one unambiguous branch, tag, or full commit SHA");
  }
  return value;
}

export function validateDispatchInputs(raw = {}) {
  const value = (name) => raw[name] ?? METHOD_AUDIT_DEFAULTS[name];
  const config = {
    platform: oneOf("platform", value("platform"), Object.keys(PLATFORM_MATRIX)),
    compareRef: validateCompareRef(value("compare_ref")),
    candidateRef: normalizeSha("candidate_ref", value("candidate_ref"), { optional: true }),
    iterations: canonicalInteger("iterations", value("iterations"), 1, 10_000),
    samples: canonicalInteger("samples", value("samples"), 1, 25),
    filter: boundedText("filter", value("filter"), 256),
    order: oneOf("order", value("order"), ["baseline-candidate", "abba", "baab"]),
    blocks: canonicalInteger("blocks", value("blocks"), 1, 5),
    nativeMode: oneOf("native_mode", value("native_mode"), ["both", "off", "require"]),
    nodeVersion: oneOf("node_version", value("node_version"), ["22", "24"]),
    control: oneOf("control", value("control"), ["rebuild", "same-artifact"]),
    timeoutMinutes: canonicalInteger("timeout_minutes", value("timeout_minutes"), 45, 120),
    expectedHarnessSha: normalizeSha("expected_harness_sha", value("expected_harness_sha"), { optional: true }),
  };
  if (![45, 90, 120].includes(config.timeoutMinutes)) {
    fail("timeout_minutes must be one of: 45, 90, 120");
  }
  if ((config.order === "abba" || config.order === "baab") && config.compareRef === "") {
    fail(`${config.order.toUpperCase()} order requires compare_ref`);
  }
  if ((config.order === "abba" || config.order === "baab") && config.filter === "") {
    fail(`${config.order.toUpperCase()} order requires a focused method filter`);
  }
  if (config.control === "same-artifact" && config.compareRef === "") {
    fail("same-artifact control requires compare_ref");
  }
  return config;
}

function referenceCandidates(requested) {
  if (requested.startsWith("refs/heads/")) {
    return [`refs/remotes/origin/${requested.slice("refs/heads/".length)}`];
  }
  if (requested.startsWith("refs/tags/")) return [requested];
  return [`refs/remotes/origin/${requested}`, `refs/tags/${requested}`];
}

export function selectNamedComparisonRef(requested, availableRefs) {
  validateCompareRef(requested);
  if (requested === "" || SHA_PATTERN.test(requested)) fail("named comparison ref required");
  const candidates = new Set(referenceCandidates(requested));
  const matches = availableRefs.filter(({ name }) => candidates.has(name));
  if (matches.length === 0) fail(`compare_ref ${JSON.stringify(requested)} did not resolve`);
  if (matches.length !== 1) fail(`compare_ref ${JSON.stringify(requested)} is ambiguous`);
  return matches[0];
}

export function deriveControlKind(control, candidateSha, baselineSha) {
  const candidate = normalizeSha("candidate SHA", candidateSha);
  if (!baselineSha) return "none";
  const baseline = normalizeSha("baseline SHA", baselineSha);
  if (control === "same-artifact") {
    if (candidate !== baseline) fail("same-artifact control requires identical candidate and baseline SHAs");
    return "same-artifact";
  }
  if (control !== "rebuild") fail("invalid control kind");
  return candidate === baseline ? "same-source-rebuild" : "source-comparison";
}

export function measurementSequence({ order, blocks, hasBaseline }) {
  oneOf("order", order, ["baseline-candidate", "abba", "baab"]);
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > 5) fail("blocks must be an integer from 1 through 5");
  if (!hasBaseline && order !== "baseline-candidate") fail(`${order.toUpperCase()} order requires a baseline`);
  const roles = order === "abba" ? ["baseline", "candidate", "candidate", "baseline"]
    : order === "baab" ? ["candidate", "baseline", "baseline", "candidate"]
      : hasBaseline ? ["baseline", "candidate"] : ["candidate"];
  const positions = [];
  for (let block = 1; block <= blocks; block += 1) {
    const roleCounts = { baseline: 0, candidate: 0 };
    const totals = Object.fromEntries(["baseline", "candidate"].map((role) => [
      role, roles.filter((entry) => entry === role).length,
    ]));
    for (let position = 1; position <= roles.length; position += 1) {
      const role = roles[position - 1];
      roleCounts[role] += 1;
      const suffix = totals[role] > 1 ? `-${roleCounts[role] === 1 ? "a" : "b"}` : "";
      positions.push({
        block,
        position,
        sequence: positions.length + 1,
        role,
        label: `block-${block}-${role}${suffix}`,
      });
    }
  }
  return positions;
}

function validateResolution(name, resolution) {
  if (!resolution || typeof resolution !== "object") fail(`${name} resolution is required`);
  return {
    requestedRef: resolution.requestedRef ?? null,
    matchedRef: resolution.matchedRef ?? null,
    commit: normalizeSha(`${name} commit`, resolution.commit),
    tree: normalizeSha(`${name} tree`, resolution.tree),
    manifestHash: normalizeSha256(`${name} manifest hash`, resolution.manifestHash),
    lockfileHash: normalizeSha256(`${name} lockfile hash`, resolution.lockfileHash),
  };
}

export function normalizeSha256(name, value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value)) fail(`${name} must be a SHA-256 digest`);
  return value.toLowerCase();
}

export function createMethodAuditPlan({ inputs, harness, candidate, baseline = null, context }) {
  const normalizedHarness = {
    workflowRef: boundedText("workflow ref", harness.workflowRef, 512, { allowEmpty: false }),
    workflowPath: ".github/workflows/benchmarks.yml",
    sha: normalizeSha("workflow SHA", harness.sha),
    tree: normalizeSha("harness tree", harness.tree),
    workflowFileHash: normalizeSha256("workflow file hash", harness.workflowFileHash),
    benchmarkHash: normalizeSha256("benchmark harness hash", harness.benchmarkHash),
    manifestHash: normalizeSha256("harness manifest hash", harness.manifestHash),
    lockfileHash: normalizeSha256("harness lockfile hash", harness.lockfileHash),
  };
  if (inputs.expectedHarnessSha && inputs.expectedHarnessSha !== normalizedHarness.sha) {
    fail("expected_harness_sha does not match github.workflow_sha");
  }
  const normalizedCandidate = validateResolution("candidate", candidate);
  if (normalizedCandidate.requestedRef !== (inputs.candidateRef || null)) {
    fail("candidate resolution does not identify candidate_ref");
  }
  if (inputs.candidateRef && inputs.candidateRef !== normalizedCandidate.commit) {
    fail("candidate_ref did not resolve to the requested exact commit");
  }
  const normalizedBaseline = baseline ? validateResolution("baseline", baseline) : null;
  if (Boolean(inputs.compareRef) !== Boolean(normalizedBaseline)) fail("compare_ref resolution is incomplete");
  if (normalizedBaseline && normalizedBaseline.requestedRef !== inputs.compareRef) {
    fail("baseline resolution does not identify compare_ref");
  }
  if (/^[0-9a-f]{40}$/u.test(inputs.compareRef) && normalizedBaseline?.commit !== inputs.compareRef) {
    fail("compare_ref did not resolve to the requested exact commit");
  }
  const controlKind = deriveControlKind(inputs.control, normalizedCandidate.commit, normalizedBaseline?.commit);
  const roleBuilds = {
    candidate: "candidate-build",
    baseline: controlKind === "same-artifact" ? "candidate-build" : "baseline-build",
  };
  const builds = [{ id: "candidate-build", checkout: "candidate", sourceRole: "candidate" }];
  if (normalizedBaseline && controlKind !== "same-artifact") {
    builds.push({ id: "baseline-build", checkout: "baseline", sourceRole: "baseline" });
  }
  const positions = measurementSequence({
    order: inputs.order,
    blocks: inputs.blocks,
    hasBaseline: Boolean(normalizedBaseline),
  });
  const modes = inputs.nativeMode === "both" ? ["off", "require"] : [inputs.nativeMode];
  const reports = positions.flatMap((measurement) => modes.map((mode) => ({
    ...measurement,
    mode,
    buildId: roleBuilds[measurement.role],
    file: `${measurement.label}-${mode}.json`,
  })));
  return {
    schemaVersion: 1,
    repository: boundedText("repository", context.repository, 256, { allowEmpty: false }),
    run: {
      id: boundedText("run id", context.runId, 64, { allowEmpty: false }),
      attempt: canonicalInteger("run attempt", context.runAttempt, 1, 1_000),
    },
    trust: { ...EXECUTION_TRUST },
    harness: normalizedHarness,
    sources: { candidate: normalizedCandidate, baseline: normalizedBaseline },
    settings: { ...inputs, controlKind },
    matrix: { include: PLATFORM_MATRIX[inputs.platform].map((entry) => ({ ...entry })) },
    builds,
    reports,
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestJson(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function attachPlanHash(plan) {
  return { ...plan, planHash: digestJson(plan) };
}

export function createRunnerArguments({ runnerFile, distRoot, reportFile, mode, settings }) {
  oneOf("native mode", mode, ["off", "require"]);
  const args = [
    runnerFile,
    "--mode", mode,
    "--iterations", String(settings.iterations),
    "--samples", String(settings.samples),
    "--warmup", "3",
    "--json", reportFile,
    "--dist", distRoot,
  ];
  if (settings.filter) args.push("--filter", settings.filter);
  return args;
}

export function validatePlanHash(plan) {
  const { planHash, ...body } = plan;
  if (normalizeSha256("plan hash", planHash) !== digestJson(body)) fail("method-audit plan hash mismatch");
  if (plan.trust?.model !== EXECUTION_TRUST.model || plan.trust?.assumption !== EXECUTION_TRUST.assumption) {
    fail("method-audit plan has an unsupported execution trust model");
  }
  return plan;
}

function normalizedReportReceipt(file, receipt) {
  if (!receipt || typeof receipt !== "object") fail(`${file} is missing its runner output receipt`);
  const decimal = (name, value) => {
    if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) fail(`${file} has an invalid ${name} receipt`);
    return value;
  };
  if (!Number.isSafeInteger(receipt.size) || receipt.size < 0) fail(`${file} has an invalid size receipt`);
  return {
    sha256: normalizeSha256(`${file} output hash`, receipt.sha256),
    size: receipt.size,
    dev: decimal("dev", receipt.dev),
    ino: decimal("ino", receipt.ino),
    mtimeNs: decimal("mtime", receipt.mtimeNs),
  };
}

export function assertStableReportReceipt(file, produced, observed) {
  const initial = normalizedReportReceipt(file, produced);
  const final = normalizedReportReceipt(file, observed);
  for (const field of ["sha256", "size", "dev", "ino", "mtimeNs"]) {
    if (initial[field] !== final[field]) fail(`${file} changed after its benchmark process exited (${field})`);
  }
  return initial;
}

function buildForReport(plan, reportPlan) {
  const build = plan.builds.find(({ id }) => id === reportPlan.buildId);
  if (!build) fail(`missing build ${reportPlan.buildId}`);
  return build;
}

export function validateRawReport(plan, reportPlan, report, snapshot) {
  const build = snapshot.builds[reportPlan.buildId];
  const buildPlan = buildForReport(plan, reportPlan);
  if (!build) fail(`snapshot is missing ${reportPlan.buildId}`);
  const buildSource = plan.sources[buildPlan.sourceRole];
  if (!buildSource || build.commit !== buildSource.commit || build.tree !== buildSource.tree ||
      build.manifestHash !== buildSource.manifestHash || build.lockfileHash !== buildSource.lockfileHash) {
    fail(`${reportPlan.file} installation is not bound to its resolved source blobs`);
  }
  if (snapshot.harness.commit !== plan.harness.sha || snapshot.harness.tree !== plan.harness.tree ||
      snapshot.harness.manifestHash !== plan.harness.manifestHash ||
      snapshot.harness.lockfileHash !== plan.harness.lockfileHash ||
      snapshot.harness.workflowFileHash !== plan.harness.workflowFileHash) {
    fail(`${reportPlan.file} harness installation is not bound to the reviewed workflow blobs`);
  }
  if (report?.schemaVersion !== 1 || !Array.isArray(report.results)) fail(`${reportPlan.file} has an incompatible report schema`);
  if (!report.results.some((result) => result.skipped === undefined)) fail(`${reportPlan.file} contains no measured cases`);
  if (report.metadata?.harnessRevision !== plan.harness.sha ||
      report.metadata?.harnessHash !== snapshot.harness.benchmarkHash) {
    fail(`${reportPlan.file} was not produced by the reviewed harness`);
  }
  if (report.metadata?.distHash !== build.runnerDistHash) fail(`${reportPlan.file} distribution hash mismatch`);
  if (report.metadata?.mode !== reportPlan.mode) fail(`${reportPlan.file} native mode mismatch`);
  if (report.metadata?.samples !== plan.settings.samples) fail(`${reportPlan.file} sample count mismatch`);
  if (typeof report.metadata?.node !== "string" || !report.metadata.node.startsWith(`v${plan.settings.nodeVersion}.`)) {
    fail(`${reportPlan.file} Node version mismatch`);
  }
  const nativeHashes = new Set(build.nativeArtifacts.map(({ sha256 }) => sha256));
  if (report.metadata.nativeHash !== null && !nativeHashes.has(report.metadata.nativeHash)) {
    fail(`${reportPlan.file} loaded native addon hash mismatch`);
  }
  if (reportPlan.mode === "off" && (report.metadata.native || report.metadata.nativeHash !== null)) {
    fail(`${reportPlan.file} unexpectedly loaded a native addon`);
  }
  if (reportPlan.mode === "require" && (!report.metadata.native || report.metadata.nativeHash === null)) {
    fail(`${reportPlan.file} did not load the required native addon`);
  }
}

function stableSnapshot(snapshot) {
  return { harness: snapshot.harness, checkouts: snapshot.checkouts, builds: snapshot.builds };
}

export function assertStableSnapshots(before, after) {
  if (before.planHash !== after.planHash || digestJson(stableSnapshot(before)) !== digestJson(stableSnapshot(after))) {
    fail("measured harness, source, or installation identity mutated during the study");
  }
}

export function validateCompleteReportSet(plan, reports, before, after) {
  validatePlanHash(plan);
  assertStableSnapshots(before, after);
  const expected = new Map(plan.reports.map((entry) => [entry.file, entry]));
  if (reports.size !== expected.size) fail("method-audit report set is incomplete or contains unexpected files");
  for (const [file, reportPlan] of expected) {
    const report = reports.get(file);
    if (!report) fail(`method-audit report set is missing ${file}`);
    validateRawReport(plan, reportPlan, report, before);
  }
}

export function createReportEvidence(plan, reportPlan, report, snapshot, runner, {
  identityStableThroughStudy = false,
  runnerOutputReceipt,
} = {}) {
  validateRawReport(plan, reportPlan, report, snapshot);
  const outputReceipt = assertStableReportReceipt(reportPlan.file, runnerOutputReceipt, runnerOutputReceipt);
  const buildPlan = buildForReport(plan, reportPlan);
  const source = plan.sources[reportPlan.role];
  const build = snapshot.builds[reportPlan.buildId];
  return {
    schemaVersion: 1,
    planHash: plan.planHash,
    trust: plan.trust,
    harness: {
      workflowRef: plan.harness.workflowRef,
      workflowSha: plan.harness.sha,
      workflowTree: plan.harness.tree,
      workflowFile: plan.harness.workflowPath,
      workflowFileHash: plan.harness.workflowFileHash,
      benchmarkHash: snapshot.harness.benchmarkHash,
      manifestBlobHash: plan.harness.manifestHash,
      lockfileBlobHash: plan.harness.lockfileHash,
      installedManifestHash: snapshot.harness.manifestHash,
      installedLockfileHash: snapshot.harness.lockfileHash,
      dependencySnapshot: snapshot.harness.dependencySnapshot,
    },
    source: {
      role: reportPlan.role,
      requestedRef: source.requestedRef,
      matchedRef: source.matchedRef,
      commit: source.commit,
      tree: source.tree,
      manifestBlobHash: source.manifestHash,
      lockfileBlobHash: source.lockfileHash,
    },
    measurement: {
      reportId: reportPlan.file.slice(0, -5),
      buildId: reportPlan.buildId,
      artifactPathId: `${buildPlan.checkout}/dist`,
      controlKind: plan.settings.controlKind,
      order: plan.settings.order,
      block: reportPlan.block,
      position: reportPlan.position,
      sequence: reportPlan.sequence,
      mode: reportPlan.mode,
      iterations: plan.settings.iterations,
      samples: plan.settings.samples,
      warmup: 3,
      filter: plan.settings.filter,
      runnerOutputReceipt: outputReceipt,
    },
    installation: {
      schemaVersion: build.installationSchemaVersion,
      manifestHash: build.manifestHash,
      lockfileHash: build.lockfileHash,
      distTreeHash: build.distTreeHash,
      dependencySnapshot: build.dependencySnapshot,
      nativeArtifacts: build.nativeArtifacts,
      loadedNativeHash: report.metadata.nativeHash,
      identityStableThroughStudy,
    },
    runtime: {
      node: report.metadata.node,
      platform: report.metadata.platform,
      arch: report.metadata.arch,
      cpu: report.metadata.cpu,
      ...runner,
    },
  };
}
