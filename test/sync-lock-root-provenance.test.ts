import { describe, expect, it } from "vitest";
import {
  SYNC_LOCK_ROOT_BASE_SHA,
  SYNC_LOCK_ROOT_CAMPAIGN_SCHEMA,
} from "../benchmarks/sync-lock-root-contract.mjs";
import {
  SYNC_LOCK_ROOT_CAPTURE_PATH,
  SYNC_LOCK_ROOT_LANE_PATH,
  SYNC_LOCK_ROOT_REQUIRED_HARNESS_PATHS,
  validateCampaignCellSet,
  validateReportExecutionWindow,
  validateWsl2CaptureCohort,
} from "../benchmarks/sync-lock-root-provenance.mjs";
import { SYNC_LOCK_ROOT_TAR_LIMITS } from "../benchmarks/sync-lock-root-tar.mjs";

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
const captureScriptSha256 = "8".repeat(64);
const laneScriptSha256 = "9".repeat(64);
const harnessIntegrity = {
  schema: "fs-safe-sync-lock-root-harness-integrity-v1",
  harnessSha,
  files: [...SYNC_LOCK_ROOT_REQUIRED_HARNESS_PATHS].sort().map((relative, index) => ({
    path: relative,
    blob: (index + 1).toString(16).padStart(40, "0"),
    sha256: relative === SYNC_LOCK_ROOT_CAPTURE_PATH ? captureScriptSha256
      : relative === SYNC_LOCK_ROOT_LANE_PATH ? laneScriptSha256
        : relative === ".github/workflows/sync-lock-root-performance-proof.yml"
          ? campaign.actions.workflowFileSha256 : "7".repeat(64),
    size: relative === SYNC_LOCK_ROOT_CAPTURE_PATH ? 100
      : relative === SYNC_LOCK_ROOT_LANE_PATH ? 200 : 300 + index,
  })),
  executedCapture: {
    sourcePath: SYNC_LOCK_ROOT_CAPTURE_PATH, sha256: captureScriptSha256, size: 100,
  },
};

function iso(second: number) {
  return `2026-09-16T00:00:${String(second).padStart(2, "0")}.000Z`;
}

function artifactNames(node: "22" | "24") {
  return ["abba", "baab"].flatMap((order) => [
    "source-comparison", "same-source-rebuild", "same-artifact",
  ].map((control) =>
    `sync-lock-root-wsl2-node-${node}-${order}-${control}-${campaign.captures[node]}-1`));
}

function capture(node: "22" | "24", start: number) {
  const captureToken = campaign.captures[node];
  const clock = {
    schema: "fs-safe-sync-lock-root-capture-clock-v1",
    campaign,
    node,
    captureToken,
    startedAt: iso(start),
    finishedAt: iso(start + 9),
    wrapperExitCode: 0,
    validationExitCode: 0,
    extractionExitCode: 0,
  };
  // This is the ordinary SSH TimingReport JSON shape emitted by the inspected
  // Crabbox schema: false `syncDelegated` is omitted by its Go `omitempty` tag.
  const timing = JSON.parse(
    '{"provider":"ssh","leaseId":"controlled-wsl2-host",' +
      '"exitCode":0,"commandMs":7000,"totalMs":8000}',
  );
  const remote = {
    schema: "fs-safe-sync-lock-root-crabbox-remote-v2",
    campaign,
    candidateSha,
    baselineSha: SYNC_LOCK_ROOT_BASE_SHA,
    harnessSha,
    node,
    captureToken,
    startedAt: iso(start + 1),
    finishedAt: iso(start + 8),
    host: {
      identityHash: "c".repeat(64),
      kernelRelease: "6.6.0-microsoft-standard-WSL2",
      versionReceiptHash: "d".repeat(64),
      filesystemDevice: "42",
      filesystemType: "ext2/ext3",
      tempRoot: {
        path: `/tmp/campaign-${node}/worker-tmp`,
        realPath: `/tmp/campaign-${node}/worker-tmp`,
        device: "42",
        filesystemType: "ext2/ext3",
        statfsType: "61267",
        environment: {
          TMPDIR: `/tmp/campaign-${node}/worker-tmp`,
          TMP: `/tmp/campaign-${node}/worker-tmp`,
          TEMP: `/tmp/campaign-${node}/worker-tmp`,
        },
      },
    },
    laneScriptSha256,
    artifacts: artifactNames(node),
  };
  const campaignStateReceipt = { sha256: "1".repeat(64), size: 100 };
  const consumptionReceipt = { sha256: node.repeat(32), size: 101 };
  const node22ResultReceipt = { sha256: "2".repeat(64), size: 102 };
  const resultFileReceipt = node === "22"
    ? node22ResultReceipt : { sha256: "4".repeat(64), size: 103 };
  const archiveReceipt = { sha256: "5".repeat(64), size: 104 };
  const archiveValidation = {
    schema: "fs-safe-sync-lock-root-tar-validation-v1",
    accepted: true,
    archive: archiveReceipt,
    entries: 10,
    totalFileBytes: 1_000,
    limits: { ...SYNC_LOCK_ROOT_TAR_LIMITS },
  };
  const outer = {
    schema: "fs-safe-sync-lock-root-crabbox-outer-v1",
    accepted: true,
    campaign,
    node,
    captureToken,
    candidateSha,
    baselineSha: SYNC_LOCK_ROOT_BASE_SHA,
    harnessSha,
    crabboxVersion: campaign.crabbox.version,
    timingSchema: campaign.crabbox.timingSchema,
    archiveValidation,
    clock,
    crabbox: {
      provider: timing.provider,
      id: timing.leaseId,
      syncDelegated: false,
      exitCode: timing.exitCode,
      commandMs: timing.commandMs,
      totalMs: timing.totalMs,
    },
    files: { archive: archiveReceipt },
    state: { campaign: campaignStateReceipt, consumption: consumptionReceipt },
    tempRoot: remote.host.tempRoot,
    captureScriptSha256,
    harnessIntegrity,
  };
  const state = {
    campaign: {
      schema: "fs-safe-sync-lock-root-campaign-state-v1",
      stateRootPolicy: "repository/artifacts-sync-lock-root-state-v1",
      campaign,
      candidateSha,
      baselineSha: SYNC_LOCK_ROOT_BASE_SHA,
      harnessSha,
      createdAt: iso(0),
    },
    consumption: {
      schema: "fs-safe-sync-lock-root-capture-consumption-v1",
      stateRootPolicy: "repository/artifacts-sync-lock-root-state-v1",
      campaign,
      candidateSha,
      baselineSha: SYNC_LOCK_ROOT_BASE_SHA,
      harnessSha,
      node,
      captureToken,
      startedAt: iso(start),
      outputRootHash: "6".repeat(64),
      campaignState: campaignStateReceipt,
      priorNode22Result: node === "22" ? null : node22ResultReceipt,
    },
    result: {
      schema: "fs-safe-sync-lock-root-capture-state-v1",
      stateRootPolicy: "repository/artifacts-sync-lock-root-state-v1",
      campaign,
      node,
      captureToken,
      accepted: true,
      campaignState: campaignStateReceipt,
      consumption: consumptionReceipt,
      outerReceipt: { sha256: "7".repeat(64), size: 105 },
      finishedAt: iso(start + 9),
    },
    resultFileReceipt,
  };
  return { archiveValidation, outer, timing, clock, remote, state };
}

function exactCells(surfaces = ["linux", "macos", "windows", "wsl2"]) {
  return surfaces.flatMap((surface) => ["22", "24"].flatMap((node) =>
    ["abba", "baab"].flatMap((order) =>
      ["source-comparison", "same-source-rebuild", "same-artifact"].map((control) =>
        `${surface}|${node}|${order}|${control}`))));
}

describe("sync lockRoot campaign provenance", () => {
  it("accepts exactly two ordered captures from one controlled Crabbox WSL2 host", () => {
    const captures = [capture("22", 0), capture("24", 10)];
    expect(captures.every(({ timing }) => !("syncDelegated" in timing))).toBe(true);
    const accepted = validateWsl2CaptureCohort(
      captures, campaign, candidateSha, harnessSha, harnessIntegrity,
    );
    expect(accepted.map(({ actual }) => [actual.provider, actual.id])).toEqual([
      ["ssh", "controlled-wsl2-host"],
      ["ssh", "controlled-wsl2-host"],
    ]);
    expect(accepted.every(({ actual }) => actual.syncDelegated === false)).toBe(true);
  });

  it("rejects outer-receipt substitution and failed wrapper evidence", () => {
    for (const mutate of [
      (captures: ReturnType<typeof capture>[]) => { captures[0]!.outer.accepted = false; },
      (captures: ReturnType<typeof capture>[]) => { captures[0]!.clock.wrapperExitCode = 1; },
      (captures: ReturnType<typeof capture>[]) => { captures[0]!.clock.validationExitCode = 1; },
      (captures: ReturnType<typeof capture>[]) => {
        captures[0]!.archiveValidation = {
          ...captures[0]!.archiveValidation,
          archive: {
            ...captures[0]!.archiveValidation.archive,
            sha256: "9".repeat(64),
          },
        };
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[0]!.outer.crabboxVersion = "unbound-version";
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[0]!.outer.tempRoot = {
          ...captures[0]!.outer.tempRoot,
          path: "/tmp/substituted-worker-tmp",
        };
      },
      (captures: ReturnType<typeof capture>[]) => {
        Object.assign(captures[0]!.timing, { syncDelegated: true });
      },
      (captures: ReturnType<typeof capture>[]) => {
        Object.assign(captures[0]!.timing, { syncDelegated: "false" });
      },
      (captures: ReturnType<typeof capture>[]) => { captures[0]!.outer.crabbox.id = "substitute"; },
      (captures: ReturnType<typeof capture>[]) => {
        captures[0]!.outer.clock = { ...captures[0]!.outer.clock, finishedAt: iso(7) };
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[0]!.outer.harnessIntegrity = {
          ...captures[0]!.outer.harnessIntegrity,
          executedCapture: {
            ...captures[0]!.outer.harnessIntegrity.executedCapture,
            sha256: "0".repeat(64),
          },
        };
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[0]!.remote.laneScriptSha256 = "0".repeat(64);
      },
      (captures: ReturnType<typeof capture>[]) => {
        const helper = captures[0]!.outer.harnessIntegrity.files.find(
          ({ path: relative }) => relative.endsWith("sync-lock-root-analysis.mjs"),
        )!;
        helper.sha256 = "0".repeat(64);
      },
    ]) {
      const captures = structuredClone([capture("22", 0), capture("24", 10)]);
      mutate(captures);
      expect(() => validateWsl2CaptureCohort(
        captures, campaign, candidateSha, harnessSha, harnessIntegrity,
      )).toThrow();
    }
  });

  it("rejects cross-campaign, provider, host, filesystem, and time mixing", () => {
    for (const mutate of [
      (captures: ReturnType<typeof capture>[]) => {
        captures[1]!.remote.campaign = {
          ...captures[1]!.remote.campaign,
          id: "00000000-0000-4000-8000-000000000004",
        };
      },
      (captures: ReturnType<typeof capture>[]) => { captures[1]!.timing.provider = "other"; },
      (captures: ReturnType<typeof capture>[]) => { captures[1]!.timing.leaseId = "other-host"; },
      (captures: ReturnType<typeof capture>[]) => {
        captures[1]!.remote.host.identityHash = "e".repeat(64);
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[1]!.remote.host.filesystemDevice = "43";
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[1]!.remote.host.tempRoot.device = "43";
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[1]!.remote.host.tempRoot.environment.TMPDIR = "/tmp/inherited";
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[1]!.remote.host.tempRoot.statfsType = "999";
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[1]!.state.result.stateRootPolicy = "operator-selected";
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[1]!.state.consumption.outputRootHash = "8".repeat(64);
      },
      (captures: ReturnType<typeof capture>[]) => {
        captures[1]!.clock.startedAt = iso(8);
        captures[1]!.outer.clock.startedAt = iso(8);
      },
    ]) {
      const captures = structuredClone([capture("22", 0), capture("24", 10)]);
      mutate(captures);
      expect(() => validateWsl2CaptureCohort(
        captures, campaign, candidateSha, harnessSha, harnessIntegrity,
      )).toThrow();
    }
  });

  it("requires every hosted and WSL2 campaign cell exactly once", () => {
    const cells = exactCells();
    expect(validateCampaignCellSet(cells, ["linux", "macos", "windows", "wsl2"]))
      .toHaveLength(48);
    expect(() => validateCampaignCellSet(cells.slice(1), [
      "linux", "macos", "windows", "wsl2",
    ])).toThrow();
    expect(() => validateCampaignCellSet([...cells, cells[0]!], [
      "linux", "macos", "windows", "wsl2",
    ])).toThrow();
  });

  it("binds report dates to admitted producer and remote execution windows", () => {
    const hostedReport = {
      metadata: { date: "2026-09-15T17:00:03.123456789-07:00" },
      methodAuditEvidence: {
        runtime: { jobApi: { id: "7", name: "producer", startedAt: iso(1) } },
      },
    };
    const hostedAdmission = {
      kind: "github-actions",
      job: {
        id: 7,
        name: "producer",
        startedAt: iso(1),
        upload: { startedAt: iso(5) },
      },
    };
    for (const date of [
      "2026-09-15T17:00:03.123456789-07:00",
      "2026-09-16T02:00:03.1+02:00",
      "2026-09-16T00:00:03Z",
    ]) {
      hostedReport.metadata.date = date;
      expect(() => validateReportExecutionWindow(hostedReport, hostedAdmission)).not.toThrow();
    }
    hostedReport.methodAuditEvidence.runtime.jobApi.id = "8";
    expect(() => validateReportExecutionWindow(hostedReport, hostedAdmission)).toThrow();
    hostedReport.methodAuditEvidence.runtime.jobApi.id = "7";
    hostedReport.metadata.date = iso(6);
    expect(() => validateReportExecutionWindow(hostedReport, hostedAdmission)).toThrow();

    const acceptedCapture = capture("22", 10);
    const wslReport = {
      metadata: { date: iso(12) },
      methodAuditEvidence: {
        runtime: {
          jobApi: null,
          wsl2: {
            captureToken: acceptedCapture.remote.captureToken,
            filesystemDevice: acceptedCapture.remote.host.filesystemDevice,
            filesystemType: acceptedCapture.remote.host.filesystemType,
            hostIdentityHash: acceptedCapture.remote.host.identityHash,
            kernelRelease: acceptedCapture.remote.host.kernelRelease,
            versionReceiptHash: acceptedCapture.remote.host.versionReceiptHash,
            tempRoot: acceptedCapture.remote.host.tempRoot,
          },
        },
      },
    };
    const wslAdmission = { kind: "wsl2", remote: acceptedCapture.remote };
    expect(() => validateReportExecutionWindow(wslReport, wslAdmission)).not.toThrow();
    wslReport.metadata.date = iso(19);
    expect(() => validateReportExecutionWindow(wslReport, wslAdmission)).toThrow();
  });
});
