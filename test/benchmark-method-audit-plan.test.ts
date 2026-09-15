import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  attachPlanHash,
  assertStableReportReceipt,
  assertStableSnapshots,
  createMethodAuditPlan,
  createReportEvidence,
  createRunnerArguments,
  measurementSequence,
  selectNamedComparisonRef,
  validateCompleteReportSet,
  validateDispatchInputs,
} from "../benchmarks/method-audit-plan.mjs";
import {
  measuredSourceBinding,
  parseMeasuredSourceArguments,
} from "../benchmarks/measured-distribution.mjs";

const H = "1".repeat(40);
const C = "2".repeat(40);
const B = "3".repeat(40);
const X = "4".repeat(40);
const H64 = "a".repeat(64);
const C64 = "b".repeat(64);
const B64 = "c".repeat(64);
const N64 = "d".repeat(64);
const RECEIPT = {
  sha256: N64,
  size: 123,
  dev: "7",
  ino: "11",
  mtimeNs: "1700000000000000000",
};

function resolution(
  commit: string,
  requestedRef: string | null,
  hash = C64,
  filenameFallbackProfile = commit === B ? "legacy" : "sanitized",
) {
  return {
    requestedRef,
    matchedRef: requestedRef && !/^[0-9a-f]{40}$/u.test(requestedRef) ? `refs/remotes/origin/${requestedRef}` : null,
    commit,
    tree: commit === C ? X : commit,
    manifestHash: hash,
    lockfileHash: hash,
    filenameSourceBlob: commit,
    filenameSourceHash: hash,
    filenameFallbackProfile,
  };
}

function planFor(overrides: Record<string, string> = {}, baseline = resolution(B, "main", B64)) {
  const inputs = validateDispatchInputs({ native_mode: "off", compare_ref: "main", ...overrides });
  return attachPlanHash(createMethodAuditPlan({
    inputs,
    harness: {
      workflowRef: "openclaw/fs-safe/.github/workflows/benchmarks.yml@refs/heads/main",
      sha: H,
      tree: H,
      workflowFileHash: H64,
      benchmarkHash: H64,
      manifestHash: H64,
      lockfileHash: H64,
    },
    candidate: resolution(C, inputs.candidateRef || null),
    baseline,
    context: { repository: "openclaw/fs-safe", runId: "123", runAttempt: "1" },
  }));
}

function defaultPlan() {
  const inputs = validateDispatchInputs();
  return attachPlanHash(createMethodAuditPlan({
    inputs,
    harness: {
      workflowRef: "openclaw/fs-safe/.github/workflows/benchmarks.yml@refs/heads/main",
      sha: H,
      tree: H,
      workflowFileHash: H64,
      benchmarkHash: H64,
      manifestHash: H64,
      lockfileHash: H64,
    },
    candidate: resolution(C, null),
    context: { repository: "openclaw/fs-safe", runId: "123", runAttempt: "1" },
  }));
}

function buildSnapshot(source: ReturnType<typeof resolution>, nativeHash = N64) {
  return {
    installationSchemaVersion: 1,
    commit: source.commit,
    tree: source.tree,
    manifestHash: source.manifestHash,
    lockfileHash: source.lockfileHash,
    filenameSourceBlob: source.filenameSourceBlob,
    filenameSourceHash: source.filenameSourceHash,
    filenameFallbackProfile: source.filenameFallbackProfile,
    distTreeHash: { algorithm: "bounded-tree-sha256-v1", hash: source.manifestHash, entries: 2, bytes: 10 },
    runnerDistHash: source.lockfileHash,
    dependencySnapshot: { schemaVersion: 1, scope: "pnpm-layout-manifests-locks-native-v1", hash: source.tree.padEnd(64, "0") },
    nativeArtifacts: [{ path: "packages/host/fs-safe-native.node", sha256: nativeHash, size: 10 }],
  };
}

function snapshotFor(plan: ReturnType<typeof planFor>) {
  const builds = Object.fromEntries(plan.builds.map((build) => {
    const source = plan.sources[build.sourceRole as "candidate" | "baseline"]!;
    return [build.id, buildSnapshot(source)];
  }));
  return {
    schemaVersion: 1,
    planHash: plan.planHash,
    harness: {
      commit: H,
      tree: H,
      manifestHash: H64,
      lockfileHash: H64,
      workflowFileHash: H64,
      benchmarkHash: H64,
      dependencySnapshot: { schemaVersion: 1, scope: "pnpm-layout-manifests-locks-native-v1", hash: H64 },
    },
    checkouts: {
      candidate: {
        commit: C,
        tree: X,
        manifestHash: C64,
        lockfileHash: C64,
        filenameSourceBlob: C,
        filenameSourceHash: C64,
        filenameFallbackProfile: "sanitized",
      },
      baseline: plan.sources.baseline && {
        commit: plan.sources.baseline.commit,
        tree: plan.sources.baseline.tree,
        manifestHash: plan.sources.baseline.manifestHash,
        lockfileHash: plan.sources.baseline.lockfileHash,
        filenameSourceBlob: plan.sources.baseline.filenameSourceBlob,
        filenameSourceHash: plan.sources.baseline.filenameSourceHash,
        filenameFallbackProfile: plan.sources.baseline.filenameFallbackProfile,
      },
    },
    builds,
  };
}

function rawReport(plan: ReturnType<typeof planFor>, reportPlan = plan.reports[0]) {
  const buildPlan = plan.builds.find(({ id }) => id === reportPlan.buildId)!;
  const build = plan.sources[buildPlan.sourceRole as "candidate" | "baseline"]!;
  return {
    schemaVersion: 1,
    metadata: {
      harnessRevision: H,
      harnessHash: H64,
      distHash: build.lockfileHash,
      measuredDistribution: {
        binding: "method-audit-plan-v1",
        buildId: buildPlan.id,
        sourceRole: buildPlan.sourceRole,
        sourceCommit: build.commit,
        sourceTree: build.tree,
        filenameSourceBlob: build.filenameSourceBlob,
        filenameSourceHash: build.filenameSourceHash,
        expectedFilenameFallbackProfile: build.filenameFallbackProfile,
        observedFilenameFallbackProfile: build.filenameFallbackProfile,
        distHash: build.lockfileHash,
      },
      sampleSemantics: "Each samplesUs value is an average microseconds per call over result.iterations.",
      nativeHash: null,
      node: "v24.9.0",
      platform: "win32",
      arch: "x64",
      cpu: "Synthetic CPU",
      mode: reportPlan.mode,
      native: false,
      samples: 5,
    },
    results: [{ name: "root", medianUs: 1 }],
  };
}

describe("method-audit input preflight", () => {
  it("preserves the existing dispatch defaults and adds bounded evidence defaults", () => {
    expect(validateDispatchInputs()).toMatchObject({
      platform: "all",
      compareRef: "",
      candidateRef: "",
      iterations: 20,
      samples: 5,
      filter: "",
      order: "baseline-candidate",
      blocks: 1,
      nativeMode: "both",
      nodeVersion: "24",
      control: "rebuild",
      timeoutMinutes: 45,
      expectedHarnessSha: "",
    });
  });

  it("creates the complete no-baseline default plan", () => {
    const plan = defaultPlan();
    expect(plan.settings.controlKind).toBe("none");
    expect(plan.sources.baseline).toBeNull();
    expect(plan.builds).toEqual([{ id: "candidate-build", checkout: "candidate", sourceRole: "candidate" }]);
    expect(plan.reports).toMatchObject([
      { role: "candidate", mode: "off", buildId: "candidate-build", file: "block-1-candidate-off.json" },
      { role: "candidate", mode: "require", buildId: "candidate-build", file: "block-1-candidate-require.json" },
    ]);
    expect(plan.matrix.include.map(({ platform }) => platform)).toEqual(["linux", "macos", "windows"]);
  });

  it.each([
    ["iterations", "01"],
    ["iterations", "10001"],
    ["samples", "0"],
    ["samples", "26"],
    ["blocks", "6"],
    ["timeout_minutes", "60"],
    ["candidate_ref", "main"],
    ["expected_harness_sha", "abc"],
    ["compare_ref", "--upload-pack=bad"],
    ["compare_ref", "main^{tree}"],
    ["compare_ref", "refs/heads/a:refs/heads/b"],
    ["compare_ref", "https://example.test/repo"],
    ["compare_ref", "main\nother"],
    ["filter", "bad\u0000filter"],
    ["filter", "é".repeat(129)],
  ])("rejects hostile or noncanonical %s", (name, value) => {
    expect(() => validateDispatchInputs({ [name]: value })).toThrow();
  });

  it("rejects balanced and same-artifact studies without their required controls", () => {
    expect(() => validateDispatchInputs({ order: "abba", filter: "root" })).toThrow("requires compare_ref");
    expect(() => validateDispatchInputs({ order: "baab", compare_ref: "main" })).toThrow("focused method filter");
    expect(() => validateDispatchInputs({ control: "same-artifact" })).toThrow("requires compare_ref");
  });

  it("resolves one exact named ref and rejects branch/tag ambiguity", () => {
    const refs = [
      { name: "refs/remotes/origin/main", commit: C },
      { name: "refs/tags/main", commit: B },
    ];
    expect(selectNamedComparisonRef("refs/heads/main", refs)).toEqual(refs[0]);
    expect(selectNamedComparisonRef("refs/tags/main", refs)).toEqual(refs[1]);
    expect(() => selectNamedComparisonRef("main", refs)).toThrow("ambiguous");
  });

  it("rejects harness, exact candidate, and same-artifact SHA mismatches", () => {
    expect(() => planFor({ expected_harness_sha: B })).toThrow("expected_harness_sha");
    expect(() => planFor({ candidate_ref: B })).toThrow("candidate_ref");
    expect(() => planFor({ control: "same-artifact", compare_ref: B }, resolution(B, B, B64)))
      .toThrow("identical candidate and baseline SHAs");
  });

  it("binds a resolved baseline to the exact requested ref", () => {
    expect(() => planFor({}, resolution(B, "release", B64))).toThrow("does not identify compare_ref");
  });
});

describe("method-audit sequence and build controls", () => {
  it.each([
    ["baseline-candidate", ["baseline", "candidate"]],
    ["abba", ["baseline", "candidate", "candidate", "baseline"]],
    ["baab", ["candidate", "baseline", "baseline", "candidate"]],
  ])("plans the exact %s sequence", (order, roles) => {
    const sequence = measurementSequence({ order, blocks: 2, hasBaseline: true });
    expect(sequence.slice(0, roles.length).map(({ role }) => role)).toEqual(roles);
    expect(sequence.slice(roles.length).map(({ role }) => role)).toEqual(roles);
    expect(sequence.map(({ sequence: index }) => index)).toEqual(sequence.map((_, index) => index + 1));
  });

  it("maps same-artifact labels to one build and one candidate dist path", () => {
    const plan = planFor({ control: "same-artifact", compare_ref: C }, resolution(C, C));
    expect(plan.settings.controlKind).toBe("same-artifact");
    expect(plan.builds).toEqual([{ id: "candidate-build", checkout: "candidate", sourceRole: "candidate" }]);
    expect(new Set(plan.reports.map(({ buildId }) => buildId))).toEqual(new Set(["candidate-build"]));
    const baselinePlan = plan.reports.find(({ role }) => role === "baseline")!;
    const evidence = createReportEvidence(plan, baselinePlan, rawReport(plan, baselinePlan), snapshotFor(plan), {}, {
      runnerOutputReceipt: RECEIPT,
    });
    expect(evidence.measurement.artifactPathId).toBe("candidate/dist");
    expect(measuredSourceBinding(plan, baselinePlan)).toMatchObject({
      buildId: "candidate-build",
      sourceRole: "candidate",
      sourceCommit: C,
      expectedFilenameFallbackProfile: "sanitized",
    });
  });

  it("keeps identical-source rebuilds as two separately identified builds", () => {
    const plan = planFor({ compare_ref: C }, resolution(C, C));
    expect(plan.settings.controlKind).toBe("same-source-rebuild");
    expect(plan.builds.map(({ checkout }) => checkout)).toEqual(["candidate", "baseline"]);
  });

  it("keeps spaces and a leading slash filter as literal argv entries", () => {
    const filter = "/Root path/with spaces";
    const args = createRunnerArguments({
      runnerFile: "C:\\audit space\\harness\\benchmarks\\runner.mjs",
      distRoot: "C:\\audit space\\candidate\\dist",
      reportFile: "C:\\audit space\\reports\\one.json",
      mode: "off",
      settings: { iterations: 20, samples: 5, filter },
    });
    expect(args.at(-2)).toBe("--filter");
    expect(args.at(-1)).toBe(filter);
    expect(args).toContain("C:\\audit space\\candidate\\dist");
  });

  it("passes a complete plan binding without consulting a harness dist", () => {
    const plan = planFor();
    const reportPlan = plan.reports.find(({ role }) => role === "baseline")!;
    const measuredSource = measuredSourceBinding(plan, reportPlan);
    const args = createRunnerArguments({
      runnerFile: "C:\\audit\\harness\\benchmarks\\runner.mjs",
      distRoot: "C:\\audit\\baseline\\dist",
      reportFile: "C:\\audit\\reports\\baseline.json",
      mode: "off",
      settings: plan.settings,
      measuredSource,
    });
    expect(args).toContain("C:\\audit\\baseline\\dist");
    expect(args.join("\n")).not.toContain("harness\\dist");
    const parsed = Object.fromEntries(
      Array.from({ length: (args.length - 1) / 2 }, (_, index) =>
        [args[1 + index * 2].slice(2), args[2 + index * 2]]),
    );
    expect(parseMeasuredSourceArguments(parsed)).toEqual(measuredSource);
    expect(() => parseMeasuredSourceArguments({ "measured-build-id": "candidate-build" }))
      .toThrow("supplied together");
  });
});

describe("method-audit provenance validation", () => {
  it("identifies reviewed harness H separately from candidate and baseline sources", () => {
    const plan = planFor();
    const snapshot = snapshotFor(plan);
    const candidatePlan = plan.reports.find(({ role }) => role === "candidate")!;
    const baselinePlan = plan.reports.find(({ role }) => role === "baseline")!;
    const runner = { runnerOS: "Windows", platformSelection: "windows" };
    const candidate = createReportEvidence(plan, candidatePlan, rawReport(plan, candidatePlan), snapshot, runner, {
      runnerOutputReceipt: RECEIPT,
    });
    const baseline = createReportEvidence(plan, baselinePlan, rawReport(plan, baselinePlan), snapshot, runner, {
      runnerOutputReceipt: RECEIPT,
    });
    expect(candidate.harness.workflowSha).toBe(H);
    expect(candidate.source.commit).toBe(C);
    expect(baseline.source.commit).toBe(B);
    expect(candidate.source.manifestBlobHash).toBe(C64);
    expect(candidate.installation.manifestHash).toBe(C64);
    expect(candidate.measurement.artifactPathId).toBe("candidate/dist");
    expect(candidate.measurement.runnerOutputReceipt).toEqual(RECEIPT);
    expect(baseline.measurement.artifactPathId).toBe("baseline/dist");
    expect(candidate.trust.assumption).toContain("not a sandbox against hostile code");
  });

  it.each(["sha256", "size", "dev", "ino", "mtimeNs"] as const)(
    "rejects a report whose captured %s changes after its process exits",
    (field) => {
      const changed = { ...RECEIPT, [field]: field === "size" ? 124 : field === "sha256" ? H64 : "12" };
      expect(() => assertStableReportReceipt("report.json", RECEIPT, changed)).toThrow(field);
    },
  );

  it("fails incomplete, mutated, distribution-mismatched, and native-mismatched evidence", () => {
    const plan = planFor();
    const before = snapshotFor(plan);
    const reports = new Map(plan.reports.map((entry) => [entry.file, rawReport(plan, entry)]));
    const candidateReport = plan.reports.find(({ role }) => role === "candidate")!;
    expect(() => validateCompleteReportSet(plan, new Map([...reports].slice(1)), before, before)).toThrow("incomplete");

    const mutated = structuredClone(before);
    mutated.builds["candidate-build"].distTreeHash.hash = N64;
    expect(() => assertStableSnapshots(before, mutated)).toThrow("mutated");

    const wrongDist = structuredClone(reports);
    const first = wrongDist.get(plan.reports[0].file)!;
    first.metadata.distHash = N64;
    expect(() => validateCompleteReportSet(plan, wrongDist, before, before)).toThrow("distribution hash mismatch");

    const wrongProfile = structuredClone(reports);
    wrongProfile.get(candidateReport.file)!.metadata
      .measuredDistribution.observedFilenameFallbackProfile = "legacy";
    expect(() => validateCompleteReportSet(plan, wrongProfile, before, before))
      .toThrow("filename fallback profile mismatch");

    const wrongBinding = structuredClone(reports);
    wrongBinding.get(candidateReport.file)!.metadata.measuredDistribution.buildId = "baseline-build";
    expect(() => validateCompleteReportSet(plan, wrongBinding, before, before))
      .toThrow("measured buildId mismatch");

    const wrongSourceRole = structuredClone(reports);
    wrongSourceRole.get(candidateReport.file)!.metadata.measuredDistribution.sourceRole = "baseline";
    expect(() => validateCompleteReportSet(plan, wrongSourceRole, before, before))
      .toThrow("measured sourceRole mismatch");

    const wrongSampleSemantics = structuredClone(reports);
    wrongSampleSemantics.get(plan.reports[0].file)!.metadata.sampleSemantics = "individual calls";
    expect(() => validateCompleteReportSet(plan, wrongSampleSemantics, before, before))
      .toThrow("sample semantics mismatch");

    const wrongSemantics = structuredClone(reports);
    wrongSemantics.get(plan.reports[0].file)!.results = [{
      name: "sanitizeUntrustedFileName/matrix/fallback-path",
      medianUs: 1,
      workloadSemantics: "equivalent-output",
    }];
    expect(() => validateCompleteReportSet(plan, wrongSemantics, before, before))
      .toThrow("workload semantics mismatch");

    const wrongNative = structuredClone(reports);
    const nativeReport = wrongNative.get(plan.reports[0].file)!;
    nativeReport.metadata.native = true;
    nativeReport.metadata.nativeHash = H64;
    expect(() => validateCompleteReportSet(plan, wrongNative, before, before)).toThrow("native addon hash mismatch");

    const normalizedAway = structuredClone(before);
    normalizedAway.builds["candidate-build"].manifestHash = H64;
    expect(() => validateCompleteReportSet(plan, reports, normalizedAway, normalizedAway))
      .toThrow("not bound to its resolved source blobs");

    const wrongFilenameSource = structuredClone(before);
    wrongFilenameSource.builds["candidate-build"].filenameSourceHash = H64;
    expect(() => validateCompleteReportSet(plan, reports, wrongFilenameSource, wrongFilenameSource))
      .toThrow("not bound to its resolved source blobs");
  });
});

describe("benchmark workflow contract", () => {
  it("keeps raw dispatch values in the preflight job and uses fixed measured paths", async () => {
    const workflow = (await readFile(".github/workflows/benchmarks.yml", "utf8")).replaceAll("\r\n", "\n");
    const methodJobStart = workflow.indexOf("  method-audit:");
    const methodJobEnd = workflow.indexOf("  benchmark:");
    const methodStepsStart = workflow.indexOf("    steps:", methodJobStart);
    const methodJob = workflow.slice(methodJobStart, methodJobEnd);
    const methodJobHeader = workflow.slice(methodJobStart, methodStepsStart);
    const prepareJob = workflow.slice(workflow.indexOf("  prepare_method_audit:"), workflow.indexOf("  method-audit:"));
    const evidenceDriver = await readFile("benchmarks/method-audit-evidence.mjs", "utf8");
    const runner = await readFile("benchmarks/runner.mjs", "utf8");
    const configureStepStart = methodJob.indexOf("      - name: Configure byte-exact checkouts");
    const downloadStepStart = methodJob.indexOf("      - name: Download resolved method-audit plan");
    const configureStep = methodJob.slice(configureStepStart, downloadStepStart);
    const planPathExport =
      "printf 'PLAN_PATH=%s/method-audit-plan/method-audit-plan.json\\n' " +
      '"$METHOD_RUNNER_TEMP" >> "$GITHUB_ENV"';
    const evidenceRootExport =
      "printf 'EVIDENCE_ROOT=%s/method-audit-evidence\\n' " +
      '"$METHOD_RUNNER_TEMP" >> "$GITHUB_ENV"';
    expect(workflow).toContain("timeout-minutes: 5");
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(methodJob).not.toContain("${{ inputs.");
    expect(methodJobHeader).not.toContain("${{ runner.");
    expect(methodJobHeader).not.toContain("PLAN_PATH:");
    expect(methodJobHeader).not.toContain("EVIDENCE_ROOT:");
    expect(configureStepStart).toBe(methodJob.indexOf("      - name:", methodJob.indexOf("    steps:")));
    expect(downloadStepStart).toBeGreaterThan(configureStepStart);
    expect(configureStep).toContain("METHOD_RUNNER_TEMP: ${{ runner.temp }}");
    expect(configureStep).toContain('if [[ -z "$METHOD_RUNNER_TEMP" ]]; then');
    expect(configureStep).toContain('echo "runner temp directory is unavailable" >&2');
    expect(configureStep).toContain("exit 2");
    expect(configureStep).toContain(planPathExport);
    expect(configureStep).toContain(evidenceRootExport);
    expect(configureStep.indexOf(planPathExport))
      .toBeLessThan(configureStep.indexOf("git config --global core.autocrlf false"));
    expect(configureStep.indexOf(evidenceRootExport))
      .toBeLessThan(configureStep.indexOf("git config --global core.autocrlf false"));
    expect(methodJob).toContain("path: ${{ runner.temp }}/method-audit-plan");
    expect(methodJob.indexOf('--plan "$PLAN_PATH"')).toBeGreaterThan(downloadStepStart);
    expect(methodJob.indexOf('mkdir -p "$EVIDENCE_ROOT"')).toBeGreaterThan(downloadStepStart);
    expect(prepareJob.indexOf("git config --global core.autocrlf false"))
      .toBeLessThan(prepareJob.indexOf("uses: actions/checkout@"));
    expect(methodJob.indexOf("git config --global core.autocrlf false"))
      .toBeLessThan(methodJob.indexOf("uses: actions/checkout@"));
    expect(evidenceDriver).toContain('distRoot: path.join(roots[build.checkout], "dist")');
    expect(evidenceDriver).toContain("exists before its benchmark process starts");
    expect(runner).toContain("fs.readdirSync(dist)");
    expect(runner).not.toContain("candidateDistHash");
    expect(methodJob).toContain("verify-harness");
    expect(methodJob).toContain("MSYS2_ARG_CONV_EXCL: \"*\"");
    expect(workflow).toContain('options: ["22", "24"]');
    expect(workflow).toContain('options: ["rebuild", "same-artifact"]');
    expect(workflow).toContain('options: ["45", "90", "120"]');
  });

  it("leaves the ordinary PR/schedule benchmark job byte-for-byte unchanged", async () => {
    const workflow = (await readFile(".github/workflows/benchmarks.yml", "utf8")).replaceAll("\r\n", "\n");
    const expected = (await readFile("test/fixtures/benchmark-job.yml", "utf8")).replaceAll("\r\n", "\n");
    expect(workflow.slice(workflow.indexOf("  benchmark:"))).toBe(expected);
  });
});
