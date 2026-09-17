import { describe, expect, it } from "vitest";
import {
  createAtomicSettlementPerformanceManifest,
  expectedAtomicSettlementRawReports,
  atomicSettlementPerformanceGate,
  validateAtomicSettlementPerformanceCampaign as validateCampaign,
} from "../benchmarks/atomic-settlement-performance-campaign.mjs";
import {
  ATOMIC_SETTLEMENT_NAMES,
  ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN,
  ATOMIC_SETTLEMENT_PERFORMANCE_DESCRIPTOR_SHA256,
} from "../benchmarks/atomic-settlement.mjs";

const H = "a".repeat(40);
const C = "b".repeat(40);
const B = "c".repeat(40);
const R = "d".repeat(40);
const HASH = "1".repeat(64);
const STUB_HASH = "2".repeat(64);
const NATIVE = "3".repeat(64);
const DEPENDENCIES = "4".repeat(64);
const SEAL = `refs/tags/atomic-settlement-performance-h-${H}`;
const CREATED = "2026-09-17T00:00:00.000Z";
const OBSERVED = "2026-09-17T00:00:10.000Z";
const STARTED = "2026-09-17T00:01:00.000Z";
const MEASURED = "2026-09-17T00:02:00.000Z";
const UPLOAD_STARTED = "2026-09-17T00:03:00.000Z";
const ARTIFACT_CREATED = "2026-09-17T00:03:10.000Z";
const ARTIFACT_UPDATED = "2026-09-17T00:03:20.000Z";
const UPLOAD_COMPLETED = "2026-09-17T00:03:30.000Z";
const COMPLETED = "2026-09-17T00:04:00.000Z";
const ROW = ATOMIC_SETTLEMENT_NAMES[0];
const RUNTIME_PLATFORMS: Record<string, string> = {
  linux: "linux",
  macos: "darwin",
  windows: "win32",
};

const TEST_BINDING = Object.freeze({
  schema: "fs-safe-atomic-settlement-campaign-binding-v1",
  state: "reviewed-registration-baseline-and-candidate",
  registrationWorkflowPath: ".github/workflows/atomic-settlement-performance.yml",
  registrationCommit: R,
  registrationWorkflowSha256: STUB_HASH,
  baselineCommit: B,
  candidateCommit: C,
});

const REQUIRED_HARNESS_FILES = [
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
] as const;

type SharedIdentity = {
  artifact: {
    id: string;
    name: string;
    archiveDigest: string;
    directoryHashSchema: string;
    directorySha256: string;
    size: number;
    createdAt: string;
    updatedAt: string;
  };
  job: {
    id: string;
    name: string;
    displayName: string;
    runId: string;
    runAttempt: number;
    startedAt: string;
    completedAt: string;
    upload: { name: string; number: number; startedAt: string; completedAt: string };
  };
};

function digest(number: number): string {
  return number.toString(16).padStart(64, "0").slice(-64);
}

function source(commit: string) {
  return { commit, tree: commit, manifestSha256: HASH, lockfileSha256: HASH };
}

function createManifest() {
  return createAtomicSettlementPerformanceManifest({
    repository: "openclaw/fs-safe",
    run: { id: "123", number: 77, attempt: 1, createdAt: CREATED },
    binding: TEST_BINDING,
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
      fileInventory: REQUIRED_HARNESS_FILES.map((path) => ({
        path,
        sha256: HASH,
        size: 1,
      })),
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
    candidate: source(C),
    baseline: source(B),
  });
}

function benchmarkResults(value = 100) {
  return ATOMIC_SETTLEMENT_NAMES.map((name) => ({
    name,
    iterations: ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.iterationsPerSample,
    samplesUs: Array(ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.samples).fill(value),
    minUs: value,
    medianUs: value,
    maxUs: value,
    workloadSemantics:
      "successful replacement of an existing regular file; fixture setup and verification are untimed",
    workloadDetails: {
      bytes: 28,
      destination: "existing",
      durable: false,
      settlement: "publication-then-retained-handle-close",
    },
  }));
}

function syntheticCampaign() {
  const manifest = createManifest();
  const artifacts = new Map<string, SharedIdentity>();
  const captures = expectedAtomicSettlementRawReports().map((entry, index) => {
    const artifactKey = `${entry.study}/${entry.platform}/${entry.node}/${entry.order}`;
    let shared = artifacts.get(artifactKey);
    if (!shared) {
      const id = artifacts.size + 1;
      shared = {
        artifact: {
          id: String(id),
          name:
            `atomic-settlement-${entry.platform}-node-${entry.node}-${entry.order}-${entry.study}-123-1`,
          archiveDigest: `sha256:${digest(id)}`,
          directoryHashSchema: "typed-path-size-content-v1",
          directorySha256: digest(1_000 + id),
          size: 4096,
          createdAt: ARTIFACT_CREATED,
          updatedAt: ARTIFACT_UPDATED,
        },
        job: {
          id: String(id),
          name: "measure",
          displayName:
            `Measure atomic settlement (${entry.platform}, ${entry.node}, ${entry.order}, ${entry.study})`,
          runId: "123",
          runAttempt: 1,
          startedAt: STARTED,
          completedAt: COMPLETED,
          upload: {
            name: "Upload exact first-attempt study artifact",
            number: 15,
            startedAt: UPLOAD_STARTED,
            completedAt: UPLOAD_COMPLETED,
          },
        },
      };
      artifacts.set(artifactKey, shared);
    }
    const candidateBuild = entry.role === "candidate" || entry.study === "same-artifact";
    const measuredBuild = candidateBuild ? "candidate" : "baseline";
    const measuredSource = candidateBuild
      ? manifest.sources.candidate
      : entry.study === "source-comparison"
        ? manifest.sources.baseline
        : manifest.sources.candidate;
    const roles = entry.order === "abba"
      ? ["baseline", "candidate", "candidate", "baseline"]
      : ["candidate", "baseline", "baseline", "candidate"];
    const occurrence = roles.slice(0, entry.position)
      .filter((role) => role === entry.role).length;
    const nativeHash = entry.mode === "require" ? NATIVE : null;
    const planHash = digest(10_000 + artifacts.size);
    return {
      ...entry,
      artifact: shared.artifact,
      job: shared.job,
      raw: {
        sha256: digest(20_000 + index),
        size: 1,
        dev: String(index + 1),
        ino: String(30_000 + index),
        mtimeNs: "1700000000000000000",
      },
      manifestSha256: manifest.manifestSha256,
      planHash,
      report: {
        schemaVersion: 1,
        metadata: {
          date: MEASURED,
          mode: entry.mode,
          samples: ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.samples,
          node: `v${entry.node}.0.0`,
          platform: RUNTIME_PLATFORMS[entry.platform],
          native: entry.mode === "require",
          nativeHash,
        },
        results: benchmarkResults(),
        methodAuditEvidence: {
          planHash,
          harness: {
            workflowRef:
              `openclaw/fs-safe/.github/workflows/atomic-settlement-performance.yml@${SEAL}`,
            workflowSha: H,
            workflowTree: H,
            workflowFile: ".github/workflows/atomic-settlement-performance.yml",
            workflowFileHash: HASH,
            benchmarkHash: HASH,
            manifestBlobHash: HASH,
            lockfileBlobHash: HASH,
          },
          source: {
            role: entry.role,
            commit: measuredSource.commit,
            tree: measuredSource.tree,
            manifestBlobHash: HASH,
            lockfileBlobHash: HASH,
          },
          measurement: {
            reportId:
              `block-${entry.block}-${entry.role}-${occurrence === 1 ? "a" : "b"}-${entry.mode}`,
            buildId: `${measuredBuild}-build`,
            artifactPathId: `${measuredBuild}/dist`,
            controlKind: entry.study,
            order: entry.order,
            block: entry.block,
            position: entry.position,
            sequence: (entry.block - 1) * 4 + entry.position,
            mode: entry.mode,
            iterations: ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.configuredIterations,
            samples: ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.samples,
            warmup: ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.warmup,
            filter: "settlement/success",
          },
          installation: {
            distTreeHash: { hash: digest(candidateBuild ? 9_001 : 9_002) },
            dependencySnapshot: { hash: DEPENDENCIES },
            nativeArtifacts: [{
              path: "packages/host/fs-safe-native.node",
              sha256: NATIVE,
              size: 1,
            }],
            loadedNativeHash: nativeHash,
            identityStableThroughStudy: true,
          },
          runtime: {
            platformSelection: entry.platform,
            runnerEnvironment: "github-hosted",
            runnerOS: entry.platform === "windows" ? "Windows"
              : entry.platform === "macos" ? "macOS" : "Linux",
            runnerArch: "X64",
            githubRunId: "123",
            githubRunAttempt: "1",
            githubJob: "measure",
          },
        },
      },
    };
  });
  return { manifest, captures };
}

type Campaign = ReturnType<typeof syntheticCampaign>;
type Capture = Campaign["captures"][number];

const frozen = syntheticCampaign();

function validate(campaign: Campaign) {
  return validateCampaign(campaign, TEST_BINDING);
}

function clone(): Campaign {
  return structuredClone(frozen);
}

function selected(
  campaign: Campaign,
  study: string,
  role: string,
  block = 1,
): Capture[] {
  return campaign.captures.filter((capture) =>
    capture.study === study &&
    capture.role === role &&
    capture.platform === "linux" &&
    capture.node === "22" &&
    capture.order === "abba" &&
    capture.mode === "off" &&
    capture.block === block);
}

function setSamples(capture: Capture, values: number[]): void {
  const result = capture.report.results.find(({ name }) => name === ROW)!;
  result.samplesUs = values;
  const sorted = [...values].sort((left, right) => left - right);
  result.minUs = sorted[0];
  result.medianUs = sorted[4];
  result.maxUs = sorted[8];
}

describe("atomic settlement performance campaign", () => {
  it("accepts the exact complete 1,440-report campaign", () => {
    expect(validate(frozen)).toMatchObject({
      accepted: true,
      rawReportProcesses: 1440,
      comparisonCells: 216,
      controlFailures: 0,
      sourceFailures: 0,
    });
  });

  it("rejects missing, duplicate, and replacement report identities", () => {
    expect(() => validate({
      manifest: frozen.manifest,
      captures: frozen.captures.slice(1),
    })).toThrow("incomplete");
    expect(() => validate({
      manifest: frozen.manifest,
      captures: [frozen.captures[0], ...frozen.captures.slice(0, -1)],
    })).toThrow("duplicate");
    const replacement = clone();
    replacement.captures[0].raw.ino = replacement.captures[1].raw.ino;
    replacement.captures[0].raw.dev = replacement.captures[1].raw.dev;
    expect(() => validate(replacement)).toThrow("reused");
  });

  it("binds every source median and maximum gate with relative OR absolute semantics", () => {
    const relativeMedian = clone();
    for (const capture of selected(relativeMedian, "source-comparison", "candidate")) {
      setSamples(capture, Array(9).fill(111));
    }
    const medianDecision = validate(relativeMedian);
    expect(medianDecision.accepted).toBe(false);
    expect(medianDecision.sourceFailures).toBeGreaterThan(0);

    const maximum = clone();
    for (const capture of selected(maximum, "source-comparison", "candidate")) {
      setSamples(capture, [100, 100, 100, 100, 100, 100, 100, 100, 121]);
    }
    const maximumCell = validate(maximum).cells.find((cell) =>
      cell.study === "source-comparison" &&
      cell.platform === "linux" &&
      cell.node === "22" &&
      cell.mode === "off" &&
      cell.order === "abba" &&
      cell.rowName === ROW)!;
    expect(maximumCell.blocks[0].maximumSampleAverage.failed).toBe(true);

    expect(atomicSettlementPerformanceGate(1_051, 1_000, "source-comparison", 50, 10))
      .toMatchObject({ absoluteUs: 51, relativePercent: 5.1, failed: true });
    expect(atomicSettlementPerformanceGate(110, 100, "source-comparison", 50, 10))
      .toMatchObject({ absoluteUs: 10, relativePercent: 10, failed: false });
  });

  it("treats both control directions as failures and never lets controls waive source results", () => {
    for (const [study, value] of [
      ["same-source-rebuild", 89],
      ["same-artifact", 111],
    ] as const) {
      const campaign = clone();
      for (const capture of selected(campaign, study, "candidate")) {
        setSamples(capture, Array(9).fill(value));
      }
      const decision = validate(campaign);
      expect(decision.accepted).toBe(false);
      expect(decision.controlFailures).toBeGreaterThan(0);
    }

    const mixed = clone();
    for (const capture of selected(mixed, "source-comparison", "candidate")) {
      setSamples(capture, Array(9).fill(111));
    }
    for (const capture of selected(mixed, "same-artifact", "candidate")) {
      setSamples(capture, Array(9).fill(100));
    }
    expect(validate(mixed)).toMatchObject({ accepted: false, controlFailures: 0 });
  });

  it.each([
    ["archive digest", (capture: Capture) => { capture.artifact.archiveDigest = "invalid"; }],
    ["upload window", (capture: Capture) => {
      capture.job.upload.startedAt = "2026-09-17T00:00:30.000Z";
    }],
    ["dependency", (capture: Capture) => {
      capture.report.methodAuditEvidence.installation.dependencySnapshot = null as never;
    }],
    ["native", (capture: Capture) => {
      capture.report.metadata.nativeHash = HASH;
    }],
    ["source", (capture: Capture) => {
      capture.report.methodAuditEvidence.source.commit = H;
    }],
  ])("rejects changed %s provenance", (_name, mutate) => {
    const campaign = clone();
    mutate(campaign.captures[0]);
    expect(() => validate(campaign)).toThrow();
  });

  it("binds the descriptor, dimensions, and all five blocks", () => {
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_DESCRIPTOR_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(expectedAtomicSettlementRawReports()).toHaveLength(1440);
    expect(new Set(expectedAtomicSettlementRawReports().map(({ block }) => block)))
      .toEqual(new Set([1, 2, 3, 4, 5]));
    expect(ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN).toMatchObject({
      configuredIterations: 200,
      iterationsPerSample: 10,
      samples: 9,
      matrixJobs: 36,
      rawReportProcesses: 1440,
    });
  });
});
