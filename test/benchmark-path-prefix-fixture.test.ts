import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pathPrefixRawComponentCount,
  pathPrefixRawRoot,
  pathPrefixRootDescription,
} from "../benchmarks/path-prefix-campaign-fixture.mjs";
import {
  PATH_PREFIX_CAMPAIGN_ROWS,
  registerPathPrefixCampaign,
  validatePathPrefixCampaignReport,
} from "../benchmarks/path-prefix-campaign.mjs";
import { resolvePathPrefixSync } from "../src/path-prefix.js";

type RegisteredCase = {
  name: string;
  run: () => unknown;
  verify: (result: unknown) => void;
  skip?: string;
  workloadSemantics?: string;
  workloadDetails?: Record<string, unknown>;
  pathPrefixFixtureReceipt?: Record<string, any>;
  inspectPathPrefixFixture?: (phase: string) => Record<string, any>;
};

const temporaryDirectories: string[] = [];

function temporaryWorkspace(): string {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(
    path.join(os.tmpdir(), "fs-safe-path-prefix-campaign-"),
  ));
  temporaryDirectories.push(workspace);
  fs.writeFileSync(path.join(workspace, "input.json"), "generic fixture\n");
  return workspace;
}

function registerFixture(filter: string, api: Record<string, unknown> = { resolvePathPrefixSync }) {
  const workspace = temporaryWorkspace();
  const registered: RegisteredCase[] = [];
  const metadata = registerPathPrefixCampaign({
    api,
    workspace,
    filter,
    register: (name: string, run: () => unknown, options: Omit<RegisteredCase, "name" | "run">) => {
      registered.push({ name, run, ...options });
    },
  });
  return { workspace, registered, metadata };
}

function executionReceipt(row: typeof PATH_PREFIX_CAMPAIGN_ROWS[number], samplesUs: number[], fixture: object) {
  const samples = samplesUs.length;
  return {
    schemaVersion: 1,
    campaign: "resolve-path-prefix-cursor-v1",
    effectiveIterations: row.effectiveIterations,
    fixtureReceipt: fixture,
    fixtureObservations: { before: structuredClone(fixture), after: structuredClone(fixture) },
    warmupBatches: 1,
    warmupBatchIds: ["warmup-1"],
    warmupInvocations: row.effectiveIterations,
    warmupVerifiedResults: row.effectiveIterations,
    warmupInvocationCounts: [row.effectiveIterations],
    warmupVerifiedResultCounts: [row.effectiveIterations],
    timedBatches: samples,
    timedBatchIds: Array.from({ length: samples }, (_, index) => `timed-${index + 1}`),
    timedInvocations: row.effectiveIterations * samples,
    timedVerifiedResults: row.effectiveIterations * samples,
    timedInvocationCounts: Array(samples).fill(row.effectiveIterations),
    timedVerifiedResultCounts: Array(samples).fill(row.effectiveIterations),
    sampleDurationsUs: samplesUs,
  };
}

function completeReport(fixture: ReturnType<typeof registerFixture>, samplesUs = [1, 2]) {
  const results = fixture.registered.map((registered, index) => {
    const row = PATH_PREFIX_CAMPAIGN_ROWS[index]!;
    const sorted = [...samplesUs].sort((a, b) => a - b);
    return {
      name: registered.name,
      iterations: row.effectiveIterations,
      samplesUs: [...samplesUs],
      minUs: sorted[0],
      medianUs: (sorted[Math.floor((sorted.length - 1) / 2)]! +
        sorted[Math.floor(sorted.length / 2)]!) / 2,
      maxUs: sorted.at(-1),
      workloadSemantics: registered.workloadSemantics,
      workloadDetails: registered.workloadDetails,
      pathPrefixFixtureReceipt: registered.pathPrefixFixtureReceipt,
      pathPrefixCampaignReceipt: executionReceipt(
        row,
        [...samplesUs],
        registered.pathPrefixFixtureReceipt!,
      ),
    };
  });
  return {
    metadata: {
      platform: process.platform,
      samples: samplesUs.length,
      pathPrefixCampaign: fixture.metadata,
    },
    results,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("path-prefix campaign root and queue accounting", () => {
  it.each([
    ["POSIX", "linux", "/one/two", "/", "posix", 2],
    ["drive", "win32", "C:\\one\\two", "C:\\", "drive", 2],
    ["namespace drive", "win32", "\\\\?\\C:\\one\\two", "\\\\?\\C:\\", "namespace-drive", 2],
    ["UNC", "win32", "\\\\server\\share\\one\\two", "\\\\server\\share\\", "unc", 2],
    [
      "extended UNC spelling",
      "win32",
      "\\\\?\\uNc\\Server\\Share\\one\\two",
      "\\\\?\\uNc\\Server\\Share\\",
      "extended-unc",
      2,
    ],
  ] as const)("matches production raw-root semantics for %s", (
    _label,
    platform,
    input,
    root,
    kind,
    count,
  ) => {
    expect(pathPrefixRawRoot(input, platform)).toBe(root);
    expect(pathPrefixRawComponentCount(input, platform)).toBe(count);
    expect(pathPrefixRootDescription(input, platform)).toEqual({ kind, spelling: root });
  });

  it("constructs and verifies all genuine fixtures on the current OS", () => {
    const fixture = registerFixture("resolvePathPrefixSync/");
    expect(fixture.registered.map(({ name }) => name))
      .toEqual(PATH_PREFIX_CAMPAIGN_ROWS.map(({ name }) => name));
    expect(Object.isFrozen(fixture.metadata)).toBe(true);
    expect(Object.isFrozen(fixture.metadata!.fixtureReceipts)).toBe(true);
    expect(new Set(fixture.metadata!.fixtureReceipts
      .map(({ workspace }: Record<string, any>) => workspace.depth)).size).toBe(1);

    for (const registered of fixture.registered) {
      expect(registered.skip).toBeUndefined();
      expect(Object.isFrozen(registered.pathPrefixFixtureReceipt)).toBe(true);
      expect(Object.isFrozen(registered.pathPrefixFixtureReceipt!.queue)).toBe(true);
      expect(registered.inspectPathPrefixFixture!("test"))
        .toEqual(registered.pathPrefixFixtureReceipt);
      registered.verify(registered.run());
    }

    const byName = new Map(fixture.metadata!.fixtureReceipts.map((receipt: Record<string, any>) => [
      receipt.row,
      receipt,
    ] as const));
    expect(byName.get("resolvePathPrefixSync/queue-boundary-32")!.queue.initial).toBe(32);
    expect(byName.get("resolvePathPrefixSync/queue-boundary-33")!.queue.initial).toBe(33);
    expect(byName.get("resolvePathPrefixSync/populated-existing-depth-32")!.queue.initial).toBe(32);
    expect(byName.get("resolvePathPrefixSync/populated-existing-depth-33")!.queue.initial).toBe(33);
    for (const transition of ["small-to-small", "small-to-large", "large-to-small", "large-to-large"]) {
      const receipt = byName.get(`resolvePathPrefixSync/symlink-${transition}`)!;
      const [sourceClass, targetClass] = transition.split("-to-");
      expect(receipt.queue.initial <= 32).toBe(sourceClass === "small");
      expect(receipt.queue.expanded <= 32).toBe(targetClass === "small");
      expect(receipt.queue.expanded).toBe(receipt.queue.target + receipt.queue.pending);
      expect(receipt.link.kind).toBe(process.platform === "win32" ? "junction" : "dir");
      expect(receipt.link.observedTarget).toEqual(expect.any(String));
    }
  });

  it.each(["", "resolvePathPrefixSync/existing", "Root.read"])(
    "builds no deep or link fixture outside the full campaign for filter %j",
    (filter) => {
      const workspace = temporaryWorkspace();
      const mkdir = vi.spyOn(fs, "mkdirSync");
      const symlink = vi.spyOn(fs, "symlinkSync");
      const registered: RegisteredCase[] = [];
      const metadata = registerPathPrefixCampaign({
        api: { resolvePathPrefixSync },
        workspace,
        filter,
        register: (name: string, run: () => unknown, options: Omit<RegisteredCase, "name" | "run">) => {
          registered.push({ name, run, ...options });
        },
      });
      expect(metadata).toBeNull();
      expect(registered.map(({ name }) => name)).toEqual([
        "resolvePathPrefixSync",
        "resolvePathPrefixSync/missing",
        "resolvePathPrefixSync/separator-heavy",
      ]);
      expect(mkdir).not.toHaveBeenCalled();
      expect(symlink).not.toHaveBeenCalled();
    },
  );

  it("preserves generic unavailable-build skips without constructing focused fixtures", () => {
    const fixture = registerFixture("", {});
    expect(fixture.metadata).toBeNull();
    expect(fixture.registered).toHaveLength(3);
    expect(fixture.registered.every(({ skip }) => skip?.includes("older comparison build"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.workspace, "path-prefix-campaign"))).toBe(false);
  });

  it("fails the whole focused cohort before construction when the owned workspace is too deep", () => {
    const root = temporaryWorkspace();
    const deep = path.join(root, ...Array.from({ length: 35 }, (_, index) => `d${index}`));
    fs.mkdirSync(deep, { recursive: true });
    expect(() => registerPathPrefixCampaign({
      api: { resolvePathPrefixSync },
      workspace: fs.realpathSync.native(deep),
      filter: "resolvePathPrefixSync/",
      register: () => undefined,
    })).toThrow("cannot exercise the 32-component boundary");
    expect(fs.existsSync(path.join(deep, "path-prefix-campaign"))).toBe(false);
  });
});

describe("path-prefix campaign receipt validation", () => {
  it("accepts complete receipts and rejects skipped, missing, and mutated evidence", () => {
    const fixture = registerFixture("resolvePathPrefixSync/");
    const report = completeReport(fixture);
    const execution = report.results[0]!.pathPrefixCampaignReceipt;
    expect(execution.fixtureObservations.before).not.toBe(execution.fixtureReceipt);
    expect(execution.fixtureObservations.after).not.toBe(execution.fixtureReceipt);
    expect(execution.fixtureObservations.after).not.toBe(execution.fixtureObservations.before);
    expect(() => validatePathPrefixCampaignReport(report, "resolvePathPrefixSync/"))
      .not.toThrow();

    const missing = structuredClone(report);
    missing.results.pop();
    expect(() => validatePathPrefixCampaignReport(missing, "resolvePathPrefixSync/"))
      .toThrow("row set mismatch");

    const metadata = structuredClone(report);
    metadata.metadata.pathPrefixCampaign!.warmupBatchesPerRow = 2;
    expect(() => validatePathPrefixCampaignReport(metadata, "resolvePathPrefixSync/"))
      .toThrow("metadata mismatch");

    const skipped = structuredClone(report);
    (skipped.results[7] as Record<string, any>).skipped = "substituted fixture";
    expect(() => validatePathPrefixCampaignReport(skipped, "resolvePathPrefixSync/"))
      .toThrow("was not measured");

    const receipt = structuredClone(report);
    receipt.results[0]!.pathPrefixCampaignReceipt.timedVerifiedResults -= 1;
    expect(() => validatePathPrefixCampaignReport(receipt, "resolvePathPrefixSync/"))
      .toThrow("execution receipt mismatch");

    const sample = structuredClone(report);
    sample.results[0]!.samplesUs[0] = 9;
    expect(() => validatePathPrefixCampaignReport(sample, "resolvePathPrefixSync/"))
      .toThrow("execution receipt mismatch");

    const count = structuredClone(report);
    count.metadata.pathPrefixCampaign!.fixtureReceipts[2]!.queue.initial = 31;
    expect(() => validatePathPrefixCampaignReport(count, "resolvePathPrefixSync/"))
      .toThrow("initial queue count mismatch");

    const transition = structuredClone(report);
    transition.metadata.pathPrefixCampaign!.fixtureReceipts[8]!.queue.expanded = 32;
    expect(() => validatePathPrefixCampaignReport(transition, "resolvePathPrefixSync/"))
      .toThrow("expanded queue count mismatch");

    const transitionLabel = structuredClone(report);
    transitionLabel.results[8]!.workloadDetails!.queueTransition = "small-to-small";
    expect(() => validatePathPrefixCampaignReport(transitionLabel, "resolvePathPrefixSync/"))
      .toThrow("workload details mismatch");

    const link = structuredClone(report);
    link.metadata.pathPrefixCampaign!.fixtureReceipts[7]!.link.kind = "file";
    expect(() => validatePathPrefixCampaignReport(link, "resolvePathPrefixSync/"))
      .toThrow("directory-link kind mismatch");

    const root = structuredClone(report);
    root.metadata.pathPrefixCampaign!.fixtureReceipts[0]!.inputRoot.spelling += "changed";
    expect(() => validatePathPrefixCampaignReport(root, "resolvePathPrefixSync/"))
      .toThrow("effective input root mismatch");

    const post = structuredClone(report);
    post.results[0]!.pathPrefixCampaignReceipt.fixtureObservations.after.input += "-changed";
    expect(() => validatePathPrefixCampaignReport(post, "resolvePathPrefixSync/"))
      .toThrow("execution receipt mismatch");
  });

  it("enforces specialized evidence presence and absence from the filter", () => {
    const fixture = registerFixture("resolvePathPrefixSync/");
    const focused = completeReport(fixture);
    const absent = structuredClone(focused);
    delete (absent.metadata as Record<string, unknown>).pathPrefixCampaign;
    expect(() => validatePathPrefixCampaignReport(absent, "resolvePathPrefixSync/"))
      .toThrow("metadata is missing");

    const generic = { metadata: { platform: process.platform, samples: 2 }, results: [] };
    expect(() => validatePathPrefixCampaignReport(generic, "")).not.toThrow();
    const stale = structuredClone(generic) as Record<string, any>;
    stale.metadata.pathPrefixCampaign = focused.metadata.pathPrefixCampaign;
    expect(() => validatePathPrefixCampaignReport(stale, ""))
      .toThrow("unexpected path-prefix campaign metadata");
  });
});
