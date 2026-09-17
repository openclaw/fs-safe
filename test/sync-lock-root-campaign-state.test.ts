import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeWsl2CampaignCapture,
  consumeWsl2CampaignCapture,
  initializeWsl2CampaignState,
  stateFileReceipt,
  WSL2_STATE_ROOT_DIRECTORY,
} from "../benchmarks/sync-lock-root-campaign-state.mjs";
import { SYNC_LOCK_ROOT_BASE_SHA } from "../benchmarks/sync-lock-root-contract.mjs";

const roots: string[] = [];
const source = {
  candidateSha: "a".repeat(40),
  harnessSha: "b".repeat(40),
  campaignId: "00000000-0000-4000-8000-000000000001",
  node22Capture: "00000000-0000-4000-8000-000000000002",
  node24Capture: "00000000-0000-4000-8000-000000000003",
  crabboxVersion: "crabbox test-version",
  workflowDatabaseId: "12345",
  workflowFileSha256: "f".repeat(64),
  expectedActionsRunNumber: "321",
  campaignInitializedAt: "2026-09-16T00:00:00.123456Z",
};

function fixture() {
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-campaign-state-"));
  roots.push(createdRoot);
  const repositoryRoot = fs.realpathSync.native(createdRoot);
  const outputA = path.join(repositoryRoot, "capture-a");
  const outputB = path.join(repositoryRoot, "capture-b");
  fs.mkdirSync(outputA, { mode: 0o700 });
  fs.mkdirSync(outputB, { mode: 0o700 });
  const paths = initializeWsl2CampaignState({
    ...source, repositoryRoot, now: "2026-09-16T00:00:00.123456Z",
  });
  return { repositoryRoot, outputA, outputB, paths };
}

function outerFile(
  directory: string,
  paths: ReturnType<typeof initializeWsl2CampaignState>,
  node: "22" | "24",
  accepted: boolean,
  baselineSha = SYNC_LOCK_ROOT_BASE_SHA,
) {
  const file = path.join(directory, "outer-receipt.json");
  const campaign = JSON.parse(fs.readFileSync(paths.campaign, "utf8")).campaign;
  fs.writeFileSync(file, `${JSON.stringify({
    schema: "fs-safe-sync-lock-root-crabbox-outer-v1",
    accepted,
    campaign,
    node,
    captureToken: campaign.captures[node],
    ...(accepted ? {
      candidateSha: source.candidateSha,
      baselineSha,
      harnessSha: source.harnessSha,
    } : {}),
    state: {
      campaign: stateFileReceipt(paths.campaign),
      consumption: stateFileReceipt(paths.consumption(node)),
    },
  })}\n`, { mode: 0o600 });
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sync lockRoot fixed WSL2 campaign state", () => {
  it("uses one repository-fixed state root and refuses campaign reinitialization", () => {
    const value = fixture();
    expect(value.paths.root).toBe(path.join(value.repositoryRoot, WSL2_STATE_ROOT_DIRECTORY));
    const original = fs.readFileSync(value.paths.campaign);
    expect(() => initializeWsl2CampaignState({
      ...source, repositoryRoot: value.repositoryRoot, now: source.campaignInitializedAt,
    })).toThrow();
    expect(() => initializeWsl2CampaignState({
      ...source,
      repositoryRoot: value.repositoryRoot,
      expectedActionsRunNumber: "322",
      now: source.campaignInitializedAt,
    })).toThrow();
    expect(fs.readFileSync(value.paths.campaign)).toEqual(original);
  });

  it.each(["direct", "ancestor"] as const)(
    "rejects a %s output-root alias before consuming a capture token",
    (kind) => {
      const value = fixture();
      let outputRoot: string;
      if (kind === "direct") {
        outputRoot = path.join(value.repositoryRoot, "capture-alias");
        fs.symlinkSync(
          value.outputA,
          outputRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      } else {
        const realParent = path.join(value.repositoryRoot, "real-parent");
        const aliasParent = path.join(value.repositoryRoot, "parent-alias");
        outputRoot = path.join(aliasParent, "capture");
        fs.mkdirSync(path.join(realParent, "capture"), { recursive: true, mode: 0o700 });
        fs.symlinkSync(
          realParent,
          aliasParent,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      expect(() => consumeWsl2CampaignCapture({
        ...source,
        repositoryRoot: value.repositoryRoot,
        node: "22",
        outputRoot,
        now: "2026-09-16T00:00:01Z",
      })).toThrow(kind === "direct" ? /not real/u : /aliased/u);
      expect(fs.existsSync(value.paths.consumption("22"))).toBe(false);
    },
  );

  it("consumes Node 22 before invocation and retains failure across a fresh output root", () => {
    const value = fixture();
    const first = consumeWsl2CampaignCapture({
      ...source,
      repositoryRoot: value.repositoryRoot,
      node: "22",
      outputRoot: value.outputA,
      now: "2026-09-16T00:00:01Z",
    });
    const consumed = stateFileReceipt(first.consumptionFile);
    const retryWithFreshOutput = () => consumeWsl2CampaignCapture({
      ...source,
      repositoryRoot: value.repositoryRoot,
      node: "22",
      outputRoot: value.outputB,
      now: "2026-09-16T00:00:03Z",
    });
    expect(retryWithFreshOutput).toThrow();
    completeWsl2CampaignCapture({
      repositoryRoot: value.repositoryRoot,
      campaignId: source.campaignId,
      node: "22",
      outerFile: outerFile(value.outputA, value.paths, "22", false),
      now: "2026-09-16T00:00:02Z",
      finalizerStatus: 1,
    });
    expect(retryWithFreshOutput).toThrow();
    expect(stateFileReceipt(first.consumptionFile)).toEqual(consumed);
  });

  it("admits Node 24 only after successful Node 22 and consumes each token once", () => {
    const value = fixture();
    const node24 = () => consumeWsl2CampaignCapture({
      ...source,
      repositoryRoot: value.repositoryRoot,
      node: "24",
      outputRoot: value.outputB,
      now: "2026-09-16T00:00:03Z",
    });
    expect(node24).toThrow();
    consumeWsl2CampaignCapture({
      ...source,
      repositoryRoot: value.repositoryRoot,
      node: "22",
      outputRoot: value.outputA,
      now: "2026-09-16T00:00:01Z",
    });
    completeWsl2CampaignCapture({
      repositoryRoot: value.repositoryRoot,
      campaignId: source.campaignId,
      node: "22",
      outerFile: outerFile(value.outputA, value.paths, "22", true),
      now: "2026-09-16T00:00:02Z",
      finalizerStatus: 0,
    });
    expect(node24).not.toThrow();
    expect(node24).toThrow();
  });

  it("rejects a substituted Node 22 terminal receipt before consuming Node 24", () => {
    const value = fixture();
    consumeWsl2CampaignCapture({
      ...source, repositoryRoot: value.repositoryRoot, node: "22",
      outputRoot: value.outputA, now: "2026-09-16T00:00:01Z",
    });
    const completed = completeWsl2CampaignCapture({
      repositoryRoot: value.repositoryRoot,
      campaignId: source.campaignId,
      node: "22",
      outerFile: outerFile(value.outputA, value.paths, "22", true),
      now: "2026-09-16T00:00:02Z",
      finalizerStatus: 0,
    });
    const substituted = JSON.parse(fs.readFileSync(completed.resultFile, "utf8"));
    substituted.consumption.sha256 = "f".repeat(64);
    fs.writeFileSync(completed.resultFile, `${JSON.stringify(substituted)}\n`);
    expect(() => consumeWsl2CampaignCapture({
      ...source, repositoryRoot: value.repositoryRoot, node: "24",
      outputRoot: value.outputB, now: "2026-09-16T00:00:03Z",
    })).toThrow();
    expect(fs.existsSync(value.paths.consumption("24"))).toBe(false);
  });

  it("rejects an accepted receipt bound to the historical comparator", () => {
    const value = fixture();
    consumeWsl2CampaignCapture({
      ...source, repositoryRoot: value.repositoryRoot, node: "22",
      outputRoot: value.outputA, now: "2026-09-16T00:00:01Z",
    });
    expect(() => completeWsl2CampaignCapture({
      repositoryRoot: value.repositoryRoot,
      campaignId: source.campaignId,
      node: "22",
      outerFile: outerFile(
        value.outputA, value.paths, "22", true,
        "6404191fd6e73bf34bcfacaefe2f113a2b8f6d99",
      ),
      now: "2026-09-16T00:00:02Z",
      finalizerStatus: 0,
    })).toThrow(/baseline mismatch/u);
  });

  it("rejects hosted-identity rebinding before consuming a capture token", () => {
    for (const changed of [
      { workflowDatabaseId: "12346" },
      { workflowFileSha256: "e".repeat(64) },
      { expectedActionsRunNumber: "322" },
      { campaignInitializedAt: "2026-09-16T00:00:00.123457Z" },
      { harnessSha: "c".repeat(40) },
    ]) {
      const value = fixture();
      expect(() => consumeWsl2CampaignCapture({
        ...source,
        ...changed,
        repositoryRoot: value.repositoryRoot,
        node: "22",
        outputRoot: value.outputA,
        now: "2026-09-16T00:00:01Z",
      })).toThrow();
      expect(fs.existsSync(value.paths.consumption("22"))).toBe(false);
    }
  });
});
