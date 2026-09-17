import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYNC_LOCK_ROOT_BASE_SHA,
  SYNC_LOCK_ROOT_CAMPAIGN_SCHEMA,
  SYNC_LOCK_ROOT_FILTER,
  SYNC_LOCK_ROOT_ROWS,
  SYNC_LOCK_ROOT_SCHEMA,
  validateSyncLockRootBenchmarkReport,
} from "../benchmarks/sync-lock-root-contract.mjs";
import {
  SYNC_LOCK_ROOT_GATES,
  analyzeSyncLockRootStudy,
  validateSyncLockRootPlanSources,
  validateSyncLockRootArtifactManifest,
} from "../benchmarks/sync-lock-root-analysis.mjs";
import { registerCase } from "../benchmarks/sync-lock-root.mjs";

const candidateSha = "a".repeat(40);
const harnessSha = "b".repeat(40);
const campaign = {
  schema: SYNC_LOCK_ROOT_CAMPAIGN_SCHEMA,
  id: "00000000-0000-4000-8000-000000000001",
  actions: {
    repository: "openclaw/fs-safe",
    workflowDatabaseId: "12345",
    workflowPath: ".github/workflows/sync-lock-root-performance-proof.yml",
    harnessSha,
    workflowFileSha256: "f".repeat(64),
    expectedActionsRunNumber: 321,
    runAttempt: 1,
    initializedAt: "2026-09-16T00:00:00.000Z",
    clockPolicy: "campaign-initialized-no-later-than-actions-run-v1",
  },
  captures: {
    "22": "00000000-0000-4000-8000-000000000002",
    "24": "00000000-0000-4000-8000-000000000003",
  },
  crabbox: {
    timingSchema: "crabbox-go-TimingReport-syncDelegated-omitempty-v1",
    version: "crabbox test-version",
  },
};

function workerReport(sourceCommit = candidateSha) {
  const samples = 9;
  const warmup = 3;
  const iterations = 100;
  const candidate = sourceCommit !== SYNC_LOCK_ROOT_BASE_SHA;
  return {
    metadata: {
      measuredDistribution: { sourceCommit },
      samples,
      syncLockRootProof: {
        schema: SYNC_LOCK_ROOT_SCHEMA,
        processId: 123,
        processToken: "12345678-1234-4234-8234-123456789abc",
        configuredIterations: iterations,
        configuredSamples: samples,
        configuredWarmup: warmup,
        tempRoot: null,
        sourceCommit,
        fixtureReceipts: Object.fromEntries(SYNC_LOCK_ROOT_ROWS.map((row) => [row.name, {
          domain: row.details.authority === "raw" || !candidate ? "raw" : "root",
          depth: row.details.layout === "flat" ? 0 : 16,
          fdObserved: true,
          layout: row.details.layout,
          missingParentCreated: row.details.layout === "deep-missing-16" ? !candidate : null,
          mutationAssertions: row.details.mutationAssertion === "noop" && candidate ? 1 : 0,
          lockPathRelative: row.details.sidecar === "default" ? "state.json.lock" : "sidecar.lock",
          policySize: row.details.policySize,
          rootCanonical: row.details.authority === "root" ? true : null,
          sidecar: row.details.sidecar,
          timerObserved: row.details.monitor === "armed",
        }])),
        observations: Object.fromEntries(SYNC_LOCK_ROOT_ROWS.map((row) => {
          const effective = Math.max(1, Math.floor(iterations / row.divisor));
          return [row.name, {
            invocations: warmup + 1 + effective * samples,
            mutationAssertions: row.details.mutationAssertion === "noop" && candidate ? 1 : 0,
          }];
        })),
      },
    },
    results: SYNC_LOCK_ROOT_ROWS.map((row) => ({
      name: row.name,
      iterations: Math.max(1, Math.floor(iterations / row.divisor)),
      workloadDetails: { ...row.details },
    })),
  };
}

function syntheticStudy(candidateUs: number, baselineUs: number, control = "source-comparison") {
  const reports: Array<{
    plan: { block: number; position: number; role: string };
    report: { results: Array<{ name: string; samplesUs: number[] }> };
  }> = [];
  const roles = ["baseline", "candidate", "candidate", "baseline"];
  for (let block = 1; block <= 5; block += 1) {
    for (let position = 1; position <= 4; position += 1) {
      const role = roles[position - 1]!;
      reports.push({
        plan: { block, position, role },
        report: {
          results: SYNC_LOCK_ROOT_ROWS.map(({ name }) => ({
            name,
            samplesUs: Array(9).fill(role === "candidate" ? candidateUs : baselineUs),
          })),
        },
      });
    }
  }
  return {
    control,
    node: "24",
    order: "abba",
    reports,
    surface: "linux",
  };
}

const FALSY_AFTER_FAILURES = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "zero", value: 0 },
  { label: "negative zero", value: -0 },
  { label: "bigint zero", value: 0n },
  { label: "empty string", value: "" },
  { label: "NaN", value: Number.NaN },
] as const;

function captureThrown(run: () => void) {
  let didThrow = false;
  let value: unknown;
  try {
    run();
  } catch (error) {
    didThrow = true;
    value = error;
  }
  return { didThrow, value };
}

describe("synchronous lockRoot benchmark worker contract", () => {
  it.each(FALSY_AFTER_FAILURES)("never records a falsy $label after-hook failure as success", ({ value }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-lock-root-after-"));
    const name = "syncLockRoot/falsy-after-hook";
    const lockPath = path.join(directory, "state.json.lock");
    const guardPath = `${lockPath}.reclaim`;
    const observation = { invocations: 0, mutationAssertions: 0 };
    const callbackState = { mutationAssertions: 0 };
    let after: ((output: unknown, input: Record<string, unknown>) => void) | undefined;
    try {
      fs.writeFileSync(lockPath, "occupied");
      fs.mkdirSync(guardPath);
      registerCase({
        register: (
          _name: string,
          _run: (input: unknown) => unknown,
          options: { after: (output: unknown, input: Record<string, unknown>) => void },
        ) => { after = options.after; },
      }, {
        observations: { [name]: observation },
        sourceCommit: candidateSha,
      }, {
        callbackState,
        guardPath,
        lockPath,
        missingParent: false,
        spec: { details: {}, divisor: 1, name },
        targetParent: directory,
      }, {
        after: () => { throw value; },
        run: () => true,
      });
      expect(after).toBeTypeOf("function");
      const result = captureThrown(() => after!(true, {}));
      expect(result.didThrow).toBe(true);
      expect(Object.is(result.value, value)).toBe(true);
      expect(observation).toEqual({ invocations: 0, mutationAssertions: 0 });
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(guardPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a source plan bound to the historical comparator", () => {
    const plan = {
      sources: {
        candidate: { commit: candidateSha },
        baseline: { commit: SYNC_LOCK_ROOT_BASE_SHA },
      },
    };
    expect(() => validateSyncLockRootPlanSources(plan, {
      candidateSha, control: "source-comparison",
    })).not.toThrow();
    plan.sources.baseline.commit = "6404191fd6e73bf34bcfacaefe2f113a2b8f6d99";
    expect(() => validateSyncLockRootPlanSources(plan, {
      candidateSha, control: "source-comparison",
    })).toThrow(/baseline SHA mismatch/u);
  });

  it("predeclares the complete, non-overlapping workload matrix", () => {
    expect(SYNC_LOCK_ROOT_FILTER).toBe("syncLockRoot/");
    expect(SYNC_LOCK_ROOT_ROWS).toHaveLength(16);
    expect(new Set(SYNC_LOCK_ROOT_ROWS.map(({ name }) => name)).size).toBe(16);
    expect(SYNC_LOCK_ROOT_ROWS.every(({ name }) => name.startsWith(SYNC_LOCK_ROOT_FILTER))).toBe(true);
    expect(new Set(SYNC_LOCK_ROOT_ROWS.map(({ details }) => details.timingClass))).toEqual(
      new Set(["fsync-inclusive", "metadata-only"]),
    );
    expect(new Set(SYNC_LOCK_ROOT_ROWS.map(({ details }) => details.policySize))).toEqual(
      new Set([0, 10, 100]),
    );
    expect(new Set(SYNC_LOCK_ROOT_ROWS.map(({ details }) => details.layout))).toEqual(
      new Set(["flat", "deep-existing-16", "deep-missing-16"]),
    );
    expect(new Set(SYNC_LOCK_ROOT_ROWS.map(({ details }) => details.sidecar))).toEqual(
      new Set(["default", "explicit"]),
    );
    const missingParent = SYNC_LOCK_ROOT_ROWS.find(
      ({ details }) => details.layout === "deep-missing-16",
    );
    expect(missingParent?.details.sidecar).toBe("explicit");
    for (const lifecycle of [
      "create-release", "verify", "reentrant-acquire", "release-nonfinal",
      "release-final", "stale-reclaim", "verify-compromised",
    ]) expect(SYNC_LOCK_ROOT_ROWS.some(({ details }) => details.lifecycle === lifecycle)).toBe(true);
    expect(SYNC_LOCK_ROOT_ROWS.some(({ details }) => details.authority === "raw")).toBe(true);
    expect(SYNC_LOCK_ROOT_ROWS.some(({ details }) => details.parser === "custom")).toBe(true);
    expect(SYNC_LOCK_ROOT_ROWS.some(({ details }) => details.mutationAssertion === "noop")).toBe(true);
    expect(SYNC_LOCK_ROOT_ROWS.some(({ details }) => details.monitor === "armed")).toBe(true);
  });

  it("accepts exact candidate and current-main worker receipts", () => {
    expect(() => validateSyncLockRootBenchmarkReport(
      workerReport(), SYNC_LOCK_ROOT_FILTER, 100,
    )).not.toThrow();
    expect(() => validateSyncLockRootBenchmarkReport(
      workerReport(SYNC_LOCK_ROOT_BASE_SHA), SYNC_LOCK_ROOT_FILTER, 100,
    )).not.toThrow();
  });

  it("rejects inherited temp drift in a pinned WSL2 worker receipt", () => {
    const report = workerReport();
    const tempRoot = {
      path: "/tmp/pinned",
      realPath: "/tmp/pinned",
      device: "42",
      filesystemType: "ext2/ext3",
      statfsType: "61267",
      environment: { TMPDIR: "/tmp/pinned", TMP: "/tmp/pinned", TEMP: "/tmp/pinned" },
    };
    Object.assign(report.metadata.syncLockRootProof, { tempRoot });
    Object.assign(report.metadata, { workspaceFilesystem: { type: 61_267 } });
    expect(() => validateSyncLockRootBenchmarkReport(
      report, SYNC_LOCK_ROOT_FILTER, 100,
    )).not.toThrow();
    tempRoot.environment.TMPDIR = "/tmp/inherited";
    expect(() => validateSyncLockRootBenchmarkReport(
      report, SYNC_LOCK_ROOT_FILTER, 100,
    )).toThrow();
    tempRoot.environment.TMPDIR = "/tmp/pinned";
    (report.metadata as typeof report.metadata & { workspaceFilesystem: { type: number } })
      .workspaceFilesystem.type = 61_268;
    expect(() => validateSyncLockRootBenchmarkReport(
      report, SYNC_LOCK_ROOT_FILTER, 100,
    )).toThrow();
  });

  it("rejects missing, skipped, substituted, and unbalanced receipt fields", () => {
    const mutations = [
      (report: ReturnType<typeof workerReport>) => { report.results.pop(); },
      (report: ReturnType<typeof workerReport>) => {
        Object.assign(report.results[0]!, { skipped: "unsupported" });
      },
      (report: ReturnType<typeof workerReport>) => {
        Object.assign(report.results[0]!.workloadDetails, { layout: "other" });
      },
      (report: ReturnType<typeof workerReport>) => {
        report.metadata.syncLockRootProof.observations[SYNC_LOCK_ROOT_ROWS[0]!.name]!.invocations -= 1;
      },
      (report: ReturnType<typeof workerReport>) => {
        report.metadata.syncLockRootProof.fixtureReceipts[SYNC_LOCK_ROOT_ROWS[1]!.name]!.domain = "raw";
      },
      (report: ReturnType<typeof workerReport>) => {
        report.metadata.syncLockRootProof.fixtureReceipts[SYNC_LOCK_ROOT_ROWS[9]!.name]!.timerObserved = false;
      },
      (report: ReturnType<typeof workerReport>) => {
        report.metadata.syncLockRootProof.fixtureReceipts[SYNC_LOCK_ROOT_ROWS[0]!.name]!.fdObserved = false;
      },
      (report: ReturnType<typeof workerReport>) => {
        report.metadata.syncLockRootProof.fixtureReceipts[SYNC_LOCK_ROOT_ROWS[3]!.name]!.depth = 15;
      },
      (report: ReturnType<typeof workerReport>) => {
        report.metadata.syncLockRootProof.fixtureReceipts[SYNC_LOCK_ROOT_ROWS[6]!.name]!.policySize = 99;
      },
      (report: ReturnType<typeof workerReport>) => {
        report.metadata.syncLockRootProof.fixtureReceipts[SYNC_LOCK_ROOT_ROWS[4]!.name]!.missingParentCreated = true;
      },
    ];
    for (const mutate of mutations) {
      const report = workerReport();
      mutate(report);
      expect(() => validateSyncLockRootBenchmarkReport(
        report, SYNC_LOCK_ROOT_FILTER, 100,
      )).toThrow();
    }
  });

  it("applies every median and maximum threshold with OR semantics", () => {
    expect(SYNC_LOCK_ROOT_GATES).toEqual({
      medianAbsoluteUs: 50,
      medianRelativePercent: 10,
      maxAbsoluteUs: 100,
      maxRelativePercent: 20,
    });
    const relativeOnly = analyzeSyncLockRootStudy(syntheticStudy(111, 100));
    expect(relativeOnly.failed).toBe(true);
    expect(relativeOnly.rows.every(({ blocks, pooled }) =>
      blocks.every(({ failed }) => failed) && pooled.failed)).toBe(true);
    const absoluteOnly = analyzeSyncLockRootStudy(syntheticStudy(1_051, 1_000));
    expect(absoluteOnly.failed).toBe(true);
    const boundary = analyzeSyncLockRootStudy(syntheticStudy(110, 100));
    expect(boundary.failed).toBe(false);
    expect(analyzeSyncLockRootStudy(syntheticStudy(1_050, 1_000)).failed).toBe(false);

    const isolatedBlock = syntheticStudy(100, 100);
    for (const entry of isolatedBlock.reports.filter(
      ({ plan }) => plan.role === "candidate" && plan.block === 1,
    )) {
      for (const result of entry.report.results) result.samplesUs.fill(111);
    }
    const blockFailure = analyzeSyncLockRootStudy(isolatedBlock);
    expect(blockFailure.rows.every(({ blocks, pooled }) => blocks[0]!.failed && !pooled.failed)).toBe(true);

    const maximumRelative = syntheticStudy(100, 100);
    for (const entry of maximumRelative.reports.filter(({ plan }) => plan.role === "candidate")) {
      for (const result of entry.report.results) result.samplesUs[0] = 121;
    }
    const relativeTail = analyzeSyncLockRootStudy(maximumRelative);
    expect(relativeTail.rows.every(({ pooled, maximum }) => !pooled.failed && maximum.failed)).toBe(true);

    const maximumAbsolute = syntheticStudy(1_000, 1_000);
    for (const entry of maximumAbsolute.reports.filter(({ plan }) => plan.role === "candidate")) {
      for (const result of entry.report.results) result.samplesUs[0] = 1_101;
    }
    const absoluteTail = analyzeSyncLockRootStudy(maximumAbsolute);
    expect(absoluteTail.rows.every(({ pooled, maximum }) => !pooled.failed && maximum.failed)).toBe(true);

    const maximumBoundary = syntheticStudy(1_000, 1_000);
    for (const entry of maximumBoundary.reports.filter(({ plan }) => plan.role === "candidate")) {
      for (const result of entry.report.results) result.samplesUs[0] = 1_100;
    }
    expect(analyzeSyncLockRootStudy(maximumBoundary).failed).toBe(false);

    const maskedBlockTail = syntheticStudy(100, 100);
    for (const entry of maskedBlockTail.reports.filter(
      ({ plan }) => plan.role === "candidate" && plan.block === 1,
    )) entry.report.results.forEach((result) => { result.samplesUs[0] = 201; });
    for (const entry of maskedBlockTail.reports.filter(
      ({ plan }) => plan.role === "baseline" && plan.block === 2,
    )) entry.report.results.forEach((result) => { result.samplesUs[0] = 300; });
    const maskedTail = analyzeSyncLockRootStudy(maskedBlockTail);
    expect(maskedTail.rows.every(({ blocks, maximum }) =>
      blocks[0]!.maximum.failed && !maximum.failed)).toBe(true);
    expect(maskedTail.failed).toBe(true);
  });

  it("fails controls symmetrically and never uses them to offset source regressions", () => {
    const reverseDrift = analyzeSyncLockRootStudy(
      syntheticStudy(80, 100, "same-artifact"),
    );
    expect(reverseDrift.failed).toBe(true);
    const stable = analyzeSyncLockRootStudy(
      syntheticStudy(100, 100, "same-source-rebuild"),
    );
    expect(stable.failed).toBe(false);
    const source = analyzeSyncLockRootStudy(syntheticStudy(120, 100));
    expect(source.failed).toBe(true);
  });

  it("accepts only an exact first-attempt API artifact set", () => {
    const run = { id: "123", attempt: 1, headSha: harnessSha };
    const names = [
      "sync-lock-root-linux-node-22-abba-source-comparison-123-1",
      "sync-lock-root-linux-node-24-baab-same-artifact-123-1",
    ];
    const jobs = [
      "linux / Node 22 / abba / source-comparison",
      "linux / Node 24 / baab / same-artifact",
    ].map((name, index) => ({
      name,
      id: 100 + index,
      status: "completed",
      conclusion: "success",
      runId: 123,
      runAttempt: 1,
      headSha: harnessSha,
      startedAt: `2026-09-16T00:0${index}:00.000Z`,
      completedAt: `2026-09-16T00:0${index}:30.000Z`,
      upload: {
        name: "Upload exact first-attempt study artifact",
        number: 12,
        status: "completed",
        conclusion: "success",
        startedAt: `2026-09-16T00:0${index}:20.000Z`,
        completedAt: `2026-09-16T00:0${index}:25.000Z`,
      },
    }));
    const manifest = {
      schema: "fs-safe-sync-lock-root-artifacts-v3",
      run: {
        ...run,
        campaign,
        repository: campaign.actions.repository,
        workflowDatabaseId: campaign.actions.workflowDatabaseId,
        workflowPath: campaign.actions.workflowPath,
        workflowFileSha256: campaign.actions.workflowFileSha256,
        runNumber: campaign.actions.expectedActionsRunNumber,
        createdAt: "2026-09-16T00:00:00.000Z",
      },
      jobs,
      artifacts: names.map((name, index) => ({
        name,
        id: index + 1,
        digest: `sha256:${String(index + 1).repeat(64)}`,
        size: 100 + index,
        expired: false,
        runId: "123",
        headSha: harnessSha,
        producerJobId: jobs[index]!.id,
        createdAt: `2026-09-16T00:0${index}:21.000Z`,
        updatedAt: `2026-09-16T00:0${index}:24.000Z`,
      })),
    };
    const accepted = validateSyncLockRootArtifactManifest(manifest, names, run, campaign);
    expect(accepted.artifacts).toEqual(manifest.artifacts);
    expect(accepted.run).toEqual(manifest.run);
    expect([...accepted.admissions]).toHaveLength(2);
    for (const mutate of [
      (copy: typeof manifest) => { copy.run.attempt = 2; }, // selective rerun
      (copy: typeof manifest) => { copy.run.headSha = SYNC_LOCK_ROOT_BASE_SHA; },
      (copy: typeof manifest) => { copy.run.campaign.id = campaign.captures["22"]; },
      (copy: typeof manifest) => { copy.run.campaign.actions.expectedActionsRunNumber += 1; },
      (copy: typeof manifest) => { copy.run.repository = "fork/fs-safe"; },
      (copy: typeof manifest) => { copy.run.workflowDatabaseId = "12346"; },
      (copy: typeof manifest) => { copy.run.workflowPath = ".github/workflows/other.yml"; },
      (copy: typeof manifest) => { copy.run.workflowFileSha256 = "0".repeat(64); },
      // A duplicate/intervening fresh dispatch consumes the predeclared number.
      (copy: typeof manifest) => { copy.run.runNumber += 1; },
      (copy: typeof manifest) => { copy.run.createdAt = "2026-09-15T23:59:59.999Z"; },
      (copy: typeof manifest) => { copy.artifacts.pop(); },
      (copy: typeof manifest) => { copy.artifacts[1]!.id = 1; },
      (copy: typeof manifest) => { copy.artifacts[0]!.digest = "sha256:bad"; },
      (copy: typeof manifest) => { copy.artifacts[0]!.runId = "124"; },
      (copy: typeof manifest) => { copy.artifacts[0]!.headSha = SYNC_LOCK_ROOT_BASE_SHA; },
      (copy: typeof manifest) => { copy.artifacts[0]!.expired = true; },
      (copy: typeof manifest) => { copy.artifacts[0]!.producerJobId = copy.jobs[1]!.id; },
      (copy: typeof manifest) => {
        copy.artifacts[0]!.createdAt = "2026-09-16T00:00:19.999Z";
      },
      (copy: typeof manifest) => {
        copy.jobs[0]!.upload.completedAt = "2026-09-16T00:00:19.000Z";
      },
      (copy: typeof manifest) => { copy.jobs[0]!.conclusion = "failure"; },
      (copy: typeof manifest) => { copy.jobs[0]!.runId = 124; },
      (copy: typeof manifest) => { copy.jobs[0]!.runAttempt = 2; },
      (copy: typeof manifest) => { copy.jobs[0]!.id = copy.jobs[1]!.id; },
    ]) {
      const copy = structuredClone(manifest);
      mutate(copy);
      expect(() => validateSyncLockRootArtifactManifest(copy, names, run, campaign)).toThrow();
    }
  });
});
