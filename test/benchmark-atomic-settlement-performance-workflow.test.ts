import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertAtomicSettlementPerformanceBinding,
  ATOMIC_SETTLEMENT_PERFORMANCE_BINDING,
  ATOMIC_SETTLEMENT_REGISTRATION_INPUTS_YAML,
  ATOMIC_SETTLEMENT_REGISTRATION_STUB,
  createAtomicSettlementPerformanceManifest,
  expectedAtomicSettlementRawReports,
  ATOMIC_SETTLEMENT_ARTIFACT_CLOCK_TOLERANCE_MS,
  validateAtomicSettlementArtifactUploadWindow,
  validateAtomicSettlementPerformanceManifest,
  validateAtomicSettlementPerformanceRunApi,
  validateAtomicSettlementRegistrationStub,
} from "../benchmarks/atomic-settlement-performance-campaign.mjs";
import {
  ATOMIC_SETTLEMENT_NAMES,
  ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN,
  ATOMIC_SETTLEMENT_PERFORMANCE_DESCRIPTOR_SHA256,
  validateAtomicSettlementPerformanceReport,
} from "../benchmarks/atomic-settlement.mjs";
import {
  attachPlanHash,
  createMethodAuditPlan,
  validateDispatchInputs,
} from "../benchmarks/method-audit-plan.mjs";

const H = "a".repeat(40);
const C = "b".repeat(40);
const B = "c".repeat(40);
const R = "d".repeat(40);
const HASH = "1".repeat(64);
const STUB_HASH = "2".repeat(64);
const SEAL = `refs/tags/atomic-settlement-performance-h-${H}`;
const CREATED = "2026-09-17T00:00:00.000Z";
const OBSERVED = "2026-09-17T00:00:01.000Z";

const READY_BINDING = Object.freeze({
  schema: "fs-safe-atomic-settlement-campaign-binding-v1",
  state: "reviewed-registration-baseline-and-candidate",
  registrationWorkflowPath: ".github/workflows/atomic-settlement-performance.yml",
  registrationCommit: R,
  registrationWorkflowSha256: STUB_HASH,
  baselineCommit: B,
  candidateCommit: C,
});

const HARNESS_FILES = [
  ".github/workflows/atomic-settlement-performance.yml",
  "package.json",
  "pnpm-lock.yaml",
  "benchmarks/runner.mjs",
  "benchmarks/method-audit-evidence.mjs",
  "benchmarks/method-audit-plan.mjs",
  "benchmarks/measured-distribution.mjs",
  "benchmarks/atomic-settlement.mjs",
  "benchmarks/atomic-settlement-performance-campaign.mjs",
  "benchmarks/atomic-settlement-performance-evidence.mjs",
  "benchmarks/exact-artifact-zip.mjs",
].map((path) => ({ path, sha256: HASH, size: 1 }));

function source(commit: string) {
  return { commit, tree: commit, manifestSha256: HASH, lockfileSha256: HASH };
}

function manifest() {
  return createAtomicSettlementPerformanceManifest({
    repository: "openclaw/fs-safe",
    run: { id: "123", number: 77, attempt: 1, createdAt: CREATED },
    binding: READY_BINDING,
    dispatch: {
      repository: "openclaw/fs-safe",
      eventName: "workflow_dispatch",
      ref: SEAL,
      refProtected: true,
      refType: "tag",
      workflowRef:
        `openclaw/fs-safe/.github/workflows/atomic-settlement-performance.yml@${SEAL}`,
      workflowSha: H,
      eventSha: H,
      expectedHarnessSha: H,
      expectedRunNumber: 77,
      expectedRunAttempt: 1,
    },
    harness: {
      commit: H,
      tree: H,
      workflowSha256: HASH,
      benchmarkSha256: HASH,
      manifestSha256: HASH,
      lockfileSha256: HASH,
      fileInventory: HARNESS_FILES,
    },
    harnessSeal: {
      repository: "https://github.com/openclaw/fs-safe.git",
      ref: SEAL,
      commit: H,
      observedAt: OBSERVED,
    },
    mainTip: {
      repository: "https://github.com/openclaw/fs-safe.git",
      ref: "refs/heads/main",
      commit: R,
      observedAt: OBSERVED,
    },
    baseline: source(B),
    candidate: source(C),
  });
}

function runApi() {
  return {
    id: 123,
    run_number: 77,
    run_attempt: 1,
    created_at: CREATED,
    event: "workflow_dispatch",
    head_sha: H,
    head_branch: SEAL.slice("refs/tags/".length),
    path: ".github/workflows/atomic-settlement-performance.yml",
    repository: { full_name: "openclaw/fs-safe" },
    head_repository: { full_name: "openclaw/fs-safe" },
  };
}

const RUN_CONTRACT = Object.freeze({
  repository: "openclaw/fs-safe",
  runId: "123",
  runNumber: 77,
  runAttempt: 1,
  createdAt: CREATED,
  harnessCommit: H,
  sealRef: SEAL,
});

function report() {
  return {
    metadata: { samples: 9 },
    results: ATOMIC_SETTLEMENT_NAMES.map((name) => ({
      name,
      iterations: 10,
      samplesUs: Array(9).fill(1),
      minUs: 1,
      medianUs: 1,
      maxUs: 1,
      workloadSemantics:
        "successful replacement of an existing regular file; fixture setup and verification are untimed",
      workloadDetails: {
        bytes: 28,
        destination: "existing",
        durable: false,
        settlement: "publication-then-retained-handle-close",
      },
    })),
  };
}

describe("atomic settlement performance workflow contract", () => {
  it("freezes the exact workload and campaign arithmetic", () => {
    expect(ATOMIC_SETTLEMENT_NAMES).toEqual([
      "replaceFileAtomic/settlement/success",
      "replaceFileAtomicSync/settlement/success",
      "FileStoreSync.write/settlement/success",
    ]);
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN).toMatchObject({
      platforms: ["linux", "macos", "windows"],
      nodeVersions: ["22", "24"],
      orders: ["abba", "baab"],
      studies: ["source-comparison", "same-source-rebuild", "same-artifact"],
      modes: ["off", "require"],
      blocks: 5,
      configuredIterations: 200,
      iterationsPerSample: 10,
      samples: 9,
      matrixJobs: 36,
      rawReportProcesses: 1440,
      cells: { ordered: 216, combinedOrders: 108, total: 324 },
    });
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_DESCRIPTOR_SHA256)
      .toMatch(/^[0-9a-f]{64}$/u);
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.matrixJobs).toBe(
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.platforms.length *
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.nodeVersions.length *
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.orders.length *
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.studies.length,
    );
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.rawReportProcesses).toBe(
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.matrixJobs *
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.blocks *
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.positionsPerBlock *
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.modes.length,
    );
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.cells.total).toBe(
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.cells.ordered +
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.cells.combinedOrders,
    );
    const unorderedDimensions = ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.studies.length *
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.platforms.length *
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.nodeVersions.length *
      ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.modes.length * ATOMIC_SETTLEMENT_NAMES.length;
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.cells.ordered).toBe(
      unorderedDimensions * ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.orders.length,
    );
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.cells.combinedOrders)
      .toBe(unorderedDimensions);
    expect(expectedAtomicSettlementRawReports()).toHaveLength(1440);
    expect(new Set(expectedAtomicSettlementRawReports().map(({ reportId }) => reportId)).size)
      .toBe(1440);
  });

  it("requires all exact rows, ordered, measured, and sampled", () => {
    expect(() => validateAtomicSettlementPerformanceReport(
      report(),
      "settlement/success",
      200,
    )).not.toThrow();
    const missing = report();
    missing.results.pop();
    expect(() => validateAtomicSettlementPerformanceReport(
      missing,
      "settlement/success",
      200,
    )).toThrow("result set or order");
    const skipped = report();
    Reflect.set(skipped.results[0], "skipped", "unavailable");
    expect(() => validateAtomicSettlementPerformanceReport(
      skipped,
      "settlement/success",
      200,
    )).toThrow("must be measured");
  });

  it("pins reviewed B/C and stays fail-closed until the stub identity exists", () => {
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_BINDING).toEqual({
      schema: "fs-safe-atomic-settlement-campaign-binding-v1",
      state: "awaiting-default-main-registration-stub",
      registrationWorkflowPath: ".github/workflows/atomic-settlement-performance.yml",
      registrationCommit: null,
      registrationWorkflowSha256: null,
      baselineCommit: "af017899d1f7045f3da2b4cc5a7583712a0f93be",
      candidateCommit: "ddea6b806b54a165115ec3052bc7df3c48a172b2",
    });
    expect(() => assertAtomicSettlementPerformanceBinding())
      .toThrow("must be finalized");
    expect(() => assertAtomicSettlementPerformanceBinding(
      ATOMIC_SETTLEMENT_PERFORMANCE_BINDING,
      { requireReady: false },
    )).not.toThrow();
    expect(() => assertAtomicSettlementPerformanceBinding(READY_BINDING)).not.toThrow();
    expect(() => assertAtomicSettlementPerformanceBinding({
      ...READY_BINDING,
      registrationCommit: B,
    })).toThrow("distinct identities");
  });

  it("defines one exact inert default-branch registration stub", () => {
    expect(() => validateAtomicSettlementRegistrationStub(
      ATOMIC_SETTLEMENT_REGISTRATION_STUB,
    )).not.toThrow();
    expect(ATOMIC_SETTLEMENT_REGISTRATION_STUB).toContain("permissions: {}");
    expect(ATOMIC_SETTLEMENT_REGISTRATION_STUB).toContain("timeout-minutes: 1");
    expect(ATOMIC_SETTLEMENT_REGISTRATION_STUB).toContain("exit 1");
    expect(ATOMIC_SETTLEMENT_REGISTRATION_STUB).not.toContain("actions/checkout");
    expect(ATOMIC_SETTLEMENT_REGISTRATION_STUB).not.toContain("node ");
    expect(() => validateAtomicSettlementRegistrationStub(
      ATOMIC_SETTLEMENT_REGISTRATION_STUB.replace("exit 1", "exit 0"),
    )).toThrow("exact reviewed");
  });

  it("binds the external H seal, first attempt, main registration commit, and API run", () => {
    const frozen = manifest();
    expect(() => validateAtomicSettlementPerformanceManifest(
      frozen,
      READY_BINDING,
    )).not.toThrow();
    expect(() => validateAtomicSettlementPerformanceRunApi(
      runApi(),
      RUN_CONTRACT,
    )).not.toThrow();
    for (const changed of [
      { run_attempt: 2 },
      { run_number: 78 },
      { head_sha: C },
      { head_branch: "main" },
      { path: ".github/workflows/other.yml@main" },
      { repository: { full_name: "fork/fs-safe" } },
      { created_at: OBSERVED },
    ]) {
      expect(() => validateAtomicSettlementPerformanceRunApi(
        { ...runApi(), ...changed },
        RUN_CONTRACT,
      )).toThrow();
    }
    expect(() => validateAtomicSettlementPerformanceManifest({
      ...frozen,
      run: { ...frozen.run, attempt: 2 },
    }, READY_BINDING)).toThrow("first-attempt");
    expect(() => validateAtomicSettlementPerformanceManifest({
      ...frozen,
      dispatch: { ...frozen.dispatch, refProtected: false },
    }, READY_BINDING)).toThrow("not protected");
    expect(() => validateAtomicSettlementPerformanceManifest({
      ...frozen,
      mainTip: { ...frozen.mainTip, commit: B },
    }, READY_BINDING)).toThrow("registration commit");
  });

  it("owns a no-concurrency, fail-fast-disabled, exact-ID workflow", async () => {
    const workflow = (await readFile(
      ".github/workflows/atomic-settlement-performance.yml",
      "utf8",
    )).replaceAll("\r\n", "\n");
    const evidence = await readFile(
      "benchmarks/atomic-settlement-performance-evidence.mjs",
      "utf8",
    );
    const campaign = await readFile(
      "benchmarks/atomic-settlement-performance-campaign.mjs",
      "utf8",
    );
    const methodPlan = await readFile("benchmarks/method-audit-plan.mjs", "utf8");
    const methodEvidence = await readFile("benchmarks/method-audit-evidence.mjs", "utf8");
    const zipEvidence = await readFile("benchmarks/exact-artifact-zip.mjs", "utf8");

    expect(workflow).toContain(`  workflow_dispatch:\n${ATOMIC_SETTLEMENT_REGISTRATION_INPUTS_YAML}`);
    expect(workflow).toContain("platform: [linux, macos, windows]");
    expect(workflow).not.toContain("wsl2");
    expect(workflow).toContain('node: ["22", "24"]');
    expect(workflow).toContain("order: [abba, baab]");
    expect(workflow).toContain(
      "study: [source-comparison, same-source-rebuild, same-artifact]",
    );
    expect(workflow).toContain('METHOD_ITERATIONS: "200"');
    expect(workflow).toContain('METHOD_SAMPLES: "9"');
    expect(workflow).toContain('METHOD_BLOCKS: "5"');
    expect(workflow).toContain("METHOD_NATIVE_MODE: both");
    expect(workflow).toContain("METHOD_FILTER: settlement/success");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).not.toContain("concurrency:");
    expect(workflow.indexOf("Capture authoritative dispatch identity before fanout"))
      .toBeLessThan(workflow.indexOf("strategy:"));
    expect(workflow).toContain("listJobsForWorkflowRunAttempt");
    expect(workflow).toContain('!/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? "")');
    expect(workflow).toContain(`!/^[0-9a-f]{64}$/.test(expectedManifestDigest)`);
    expect(workflow).toContain('manifestArtifact.digest.slice("sha256:".length)');
    expect(workflow).toContain("artifact-ids: ${{ steps.artifacts.outputs.measurement_ids }}");
    expect(workflow).not.toContain("pattern: atomic-settlement-");
    expect(workflow).toContain("Upload exact first-attempt study artifact");
    expect(workflow).toContain(
      "- name: Upload exact first-attempt study artifact\n        if: always()",
    );
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toContain("Retain raw aggregate API census on every validation path");
    expect(workflow).toContain('if [[ -f "$RUNNER_TEMP/$name" ]]');
    expect(workflow).toContain('atomic-settlement-performance-evidence.mjs" analyze');
    expect(workflow).toContain("needs: [prepare, measure]");
    expect(workflow).toContain("if: always() && needs.prepare.result == 'success'");

    expect(evidence).toContain('["--no-replace-objects", "-C", root');
    expect(methodEvidence).toContain('["--no-replace-objects", "-C", root');
    expect(evidence).toContain("assert.equal(entries.length, 36");
    expect(evidence).toContain("assert.equal(artifactsApi.artifacts.length, 37");
    expect(evidence).toContain("assert.equal(jobsApi.jobs.length, 38");
    expect(evidence).toContain("Upload exact first-attempt study artifact");
    expect(evidence).toContain('finalRun.status, "completed"');
    expect(evidence).toContain('finalRun.conclusion, "success"');
    expect(evidence).toContain("finalArtifactsApi.artifacts.length, 38");
    expect(evidence).toContain('"Upload aggregate decision"');
    expect(evidence).toContain("analysis-artifact-id");
    expect(evidence).toContain('"analysis-archive"');
    expect(evidence).toContain("analysisArchiveCapture.receipt.size");
    expect(evidence).toContain("analysisArchiveCapture.receipt.sha256");
    expect(evidence).toContain("assertExactZipExtraction(analysisArchiveCapture.bytes");
    expect(evidence.match(/assertArtifactUploadBinding\(/g)).toHaveLength(6);
    expect(evidence).toContain("fs-safe-atomic-settlement-performance-final-seal-v1");
    expect(evidence).toContain("function exactKeys(value, expected, context)");
    expect(evidence).toContain("function assertReceipt(value, context)");
    expect(campaign).toContain("campaign binding must be finalized");
    expect(evidence).not.toContain("binding.harnessCommit");
    expect(methodPlan).toContain(
      '".github/workflows/atomic-settlement-performance.yml"',
    );
    expect(zipEvidence).toContain("analysis artifact ZIP entries overlap");
    expect(zipEvidence).toContain("extracted aggregate evidence differs from the selected archive");
  });

  it("admits only the fixed service-clock tolerance inside hard producer-job bounds", () => {
    expect(ATOMIC_SETTLEMENT_ARTIFACT_CLOCK_TOLERANCE_MS).toBe(5_000);
    const actualActionsShape = {
      jobStartedAt: "2026-09-17T08:50:00Z",
      uploadStartedAt: "2026-09-17T08:51:50Z",
      uploadCompletedAt: "2026-09-17T08:51:52Z",
      artifactCreatedAt: "2026-09-17T08:51:53Z",
      artifactUpdatedAt: "2026-09-17T08:51:53Z",
      jobCompletedAt: "2026-09-17T08:52:01Z",
    };
    expect(validateAtomicSettlementArtifactUploadWindow(actualActionsShape)).toBe(
      actualActionsShape,
    );
    expect(() => validateAtomicSettlementArtifactUploadWindow({
      ...actualActionsShape,
      artifactCreatedAt: "2026-09-17T08:51:58Z",
      artifactUpdatedAt: "2026-09-17T08:51:58Z",
    })).toThrow("tolerated producer-upload window");
    expect(() => validateAtomicSettlementArtifactUploadWindow({
      ...actualActionsShape,
      jobCompletedAt: "2026-09-17T08:51:52Z",
    })).toThrow("hard producer-job window");
  });

  it("binds the dedicated workflow and campaign manifest into each method plan", () => {
    const inputs = validateDispatchInputs({
      platform: "linux",
      compare_ref: B,
      candidate_ref: C,
      iterations: "200",
      samples: "9",
      filter: "settlement/success",
      order: "abba",
      blocks: "5",
      native_mode: "both",
      node_version: "22",
      control: "rebuild",
      timeout_minutes: "120",
      expected_harness_sha: H,
    });
    const resolution = (commit: string, requestedRef: string) => ({
      requestedRef,
      matchedRef: null,
      commit,
      tree: commit,
      manifestHash: HASH,
      lockfileHash: HASH,
      filenameSourceBlob: commit,
      filenameSourceHash: HASH,
      filenameFallbackProfile: "sanitized",
    });
    const create = (workflowPath: string) => attachPlanHash(createMethodAuditPlan({
      inputs,
      harness: {
        workflowRef: `openclaw/fs-safe/${workflowPath}@${SEAL}`,
        workflowPath,
        sha: H,
        tree: H,
        workflowFileHash: HASH,
        benchmarkHash: HASH,
        manifestHash: HASH,
        lockfileHash: HASH,
      },
      candidate: resolution(C, C),
      baseline: resolution(B, B),
      context: {
        repository: "openclaw/fs-safe",
        runId: "123",
        runAttempt: "1",
        campaignManifestSha256: HASH,
      },
    }));
    const plan = create(".github/workflows/atomic-settlement-performance.yml");
    expect(plan.harness.workflowPath)
      .toBe(".github/workflows/atomic-settlement-performance.yml");
    expect(plan.campaignManifestSha256).toBe(HASH);
    expect(plan.reports).toHaveLength(40);
    expect(() => create(".github/workflows/unreviewed.yml"))
      .toThrow("unsupported method-audit workflow path");
  });

  it("documents strict gates, full replacement, and final external sealing", async () => {
    const readme = await readFile("benchmarks/README.md", "utf8");
    const prose = readme.replace(/\s+/g, " ");
    expect(prose).toContain("five complete ABBA or BAAB blocks");
    expect(prose).toContain("median regression exceeds 10 percent **or** 50 microseconds");
    expect(prose).toContain("maximum sample-average regression exceeds 20 percent **or** 100 microseconds");
    expect(prose).toContain("There is no workflow-level concurrency group");
    expect(prose).toContain("a release rule covering only `v*` does not satisfy");
    expect(prose).toContain("requires all 1,440 raw report processes");
    expect(prose).toContain("selective reruns are inadmissible");
    expect(prose).toContain("require separate post-run verification");
    expect(prose).toContain("all 38 completed first-attempt jobs");
    expect(prose).toContain("all 38 exact artifacts");
  });
});
