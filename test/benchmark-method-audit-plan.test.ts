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
  validateMeasuredDistribution,
} from "../benchmarks/measured-distribution.mjs";
import { completeSyntheticBenchmarkResults } from "./helpers/benchmark-report.js";

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
    results: completeSyntheticBenchmarkResults(
      plan.settings.samples,
      plan.settings.iterations,
      reportPlan.mode,
    ),
  };
}

describe("copy-tree measured row admission", () => {
  it.each([
    ["probeTreeClone", "probeTreeClone-extra", "Unknown probeTreeClone success row"],
    ["probeTreeClone", "other/probeTreeClone", "Unknown probeTreeClone success row"],
    [
      "copyTree/settled-success/",
      "other/copyTree/settled-success/unknown",
      "Unknown copyTree success row",
    ],
  ])("rejects measured and skipped unknown %s rows through the distribution gate", (
    filter,
    unknownName,
    message,
  ) => {
    const plan = planFor({ filter });
    const reportPlan = plan.reports[0]!;
    const report = rawReport(plan, reportPlan);
    const selected = report.results.filter(({ name }) => name.includes(filter));
    const unknown = { ...selected[0]!, name: unknownName };
    expect(() => validateMeasuredDistribution(
      plan,
      reportPlan,
      { ...report, results: [...selected, unknown] },
      report.metadata.distHash,
    )).toThrow(message);

    expect(() => validateMeasuredDistribution(
      plan,
      reportPlan,
      { ...report, results: [...selected, { ...unknown, skipped: "not run" }] },
      report.metadata.distHash,
    )).toThrow(message);
  });
});
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
    const candidateReport = plan.reports.find(({ role }) => role === "candidate")!;
    const makeReports = () => new Map(plan.reports.map((entry) => [entry.file, rawReport(plan, entry)]));
    const mutated = structuredClone(before);
    mutated.builds["candidate-build"].distTreeHash.hash = N64;
    expect(() => assertStableSnapshots(before, mutated)).toThrow("mutated");

    const reportCases: Array<[(reports: ReturnType<typeof makeReports>) => void, string]> = [
      [(reports) => { reports.delete(plan.reports[0].file); }, "incomplete"],
      [(reports) => { reports.get(plan.reports[0].file)!.metadata.distHash = N64; }, "distribution hash mismatch"],
      [(reports) => {
        reports.get(candidateReport.file)!.metadata.measuredDistribution.observedFilenameFallbackProfile = "legacy";
      }, "filename fallback profile mismatch"],
      [(reports) => { reports.get(candidateReport.file)!.metadata.measuredDistribution.buildId = "baseline-build"; },
        "measured buildId mismatch"],
      [(reports) => { reports.get(candidateReport.file)!.metadata.measuredDistribution.sourceRole = "baseline"; },
        "measured sourceRole mismatch"],
      [(reports) => { reports.get(plan.reports[0].file)!.metadata.sampleSemantics = "individual calls"; }, "sample semantics mismatch"],
      [(reports) => {
        reports.get(plan.reports[0].file)!.results = [{
          name: "sanitizeUntrustedFileName/matrix/fallback-path", iterations: 1,
          samplesUs: [1, 1, 1, 1, 1], minUs: 1, medianUs: 1, maxUs: 1, workloadSemantics: "equivalent-output",
        }];
      }, "workload semantics mismatch"],
      [(reports) => {
        const report = reports.get(plan.reports[0].file)!;
        report.metadata.native = true;
        report.metadata.nativeHash = H64;
      }, "native addon hash mismatch"],
    ];
    for (const [mutate, message] of reportCases) {
      const changed = makeReports();
      mutate(changed);
      expect(() => validateCompleteReportSet(plan, changed, before, before)).toThrow(message);
    }
    for (const field of ["manifestHash", "filenameSourceHash"] as const) {
      const changed = structuredClone(before);
      changed.builds["candidate-build"][field] = H64;
      expect(() => validateCompleteReportSet(plan, makeReports(), changed, changed))
        .toThrow("not bound to its resolved source blobs");
    }
  });
});
