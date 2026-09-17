import { describe, expect, it } from "vitest";
import {
  createRunnerArguments,
  pathPrefixMeasurementProvenance,
} from "../benchmarks/method-audit-plan.mjs";
import {
  PATH_PREFIX_CAMPAIGN_NAMES,
  PATH_PREFIX_CAMPAIGN_ROWS,
  measurePathPrefixCampaignCase,
  pathPrefixCampaignMetadata,
} from "../benchmarks/path-prefix-campaign.mjs";

const fixtureReceipt = Object.freeze({ schemaVersion: 1, fixture: "synthetic" });

function executionReceipt(
  effectiveIterations: number,
  samplesUs: number[],
  receipt: object = fixtureReceipt,
) {
  const samples = samplesUs.length;
  return {
    schemaVersion: 1,
    campaign: "resolve-path-prefix-cursor-v1",
    effectiveIterations,
    fixtureReceipt: receipt,
    fixtureObservations: { before: receipt, after: receipt },
    warmupBatches: 1,
    warmupBatchIds: ["warmup-1"],
    warmupInvocations: effectiveIterations,
    warmupVerifiedResults: effectiveIterations,
    warmupInvocationCounts: [effectiveIterations],
    warmupVerifiedResultCounts: [effectiveIterations],
    timedBatches: samples,
    timedBatchIds: Array.from({ length: samples }, (_, index) => `timed-${index + 1}`),
    timedInvocations: effectiveIterations * samples,
    timedVerifiedResults: effectiveIterations * samples,
    timedInvocationCounts: Array(samples).fill(effectiveIterations),
    timedVerifiedResultCounts: Array(samples).fill(effectiveIterations),
    sampleDurationsUs: samplesUs,
  };
}

function measuredCase(name: string, effectiveIterations: number, expectedSamplesUs: number[]) {
  const runIds: number[] = [];
  const verifiedIds: number[] = [];
  const fixturePhases: string[] = [];
  const clockPhases: string[] = [];
  const phaseEvents: string[] = [];
  let nextId = 0;
  const clockValues = [
    0,
    100,
    ...expectedSamplesUs.flatMap((sample, index) => [
      1_000 + index * 1_000,
      1_000 + index * 1_000 + sample * effectiveIterations / 1_000,
    ]),
  ];
  let clockIndex = 0;
  const measured = measurePathPrefixCampaignCase({
    name,
    sync: true,
    pathPrefixFixtureReceipt: fixtureReceipt,
    inspectPathPrefixFixture: (phase: string) => {
      fixturePhases.push(phase);
      phaseEvents.push(`fixture:${phase}`);
      return fixtureReceipt;
    },
    run: () => {
      const id = ++nextId;
      runIds.push(id);
      return { id };
    },
    verify: (result: { id: number }) => {
      verifiedIds.push(result.id);
      if (result.id === 1 || result.id % effectiveIterations === 0 ||
          result.id % effectiveIterations === 1) {
        phaseEvents.push(`verify:${result.id}`);
      }
    },
  }, expectedSamplesUs.length, ({ phase, batchId, edge }: {
    phase: string;
    batchId: string;
    edge: string;
  }) => {
    clockPhases.push(`${phase}:${batchId}:${edge}`);
    phaseEvents.push(`clock:${phase}:${batchId}:${edge}`);
    return clockValues[clockIndex++]!;
  });

  expect(runIds).toEqual(Array.from({ length: nextId }, (_, index) => index + 1));
  expect(verifiedIds).toEqual(runIds);
  expect(new Set(verifiedIds).size).toBe(verifiedIds.length);
  expect(nextId).toBe(effectiveIterations * (expectedSamplesUs.length + 1));
  expect(fixturePhases).toEqual(["before", "after"]);
  expect(phaseEvents[0]).toBe("fixture:before");
  expect(phaseEvents.at(-1)).toBe("fixture:after");
  expect(phaseEvents.indexOf("clock:warmup:warmup-1:end"))
    .toBeLessThan(phaseEvents.indexOf("verify:1"));
  expect(phaseEvents.indexOf(`verify:${effectiveIterations}`))
    .toBeLessThan(phaseEvents.indexOf("clock:timed:timed-1:start"));
  expect(phaseEvents.indexOf("clock:timed:timed-1:end"))
    .toBeLessThan(phaseEvents.indexOf(`verify:${effectiveIterations + 1}`));
  expect(clockPhases).toEqual([
    "warmup:warmup-1:start",
    "warmup:warmup-1:end",
    ...expectedSamplesUs.flatMap((_, index) => [
      `timed:timed-${index + 1}:start`,
      `timed:timed-${index + 1}:end`,
    ]),
  ]);
  expect(measured.iterations).toBe(effectiveIterations);
  expect(measured.samplesUs).toEqual(expectedSamplesUs);
  expect(measured.receipt).toEqual(executionReceipt(effectiveIterations, expectedSamplesUs));
}

describe("resolvePathPrefixSync benchmark campaign", () => {
  it("freezes the eleven rows and their exact effective iteration classes", () => {
    expect(PATH_PREFIX_CAMPAIGN_NAMES).toEqual([
      "resolvePathPrefixSync/existing",
      "resolvePathPrefixSync/missing",
      "resolvePathPrefixSync/queue-boundary-32",
      "resolvePathPrefixSync/queue-boundary-33",
      "resolvePathPrefixSync/separator-heavy",
      "resolvePathPrefixSync/populated-existing-depth-32",
      "resolvePathPrefixSync/populated-existing-depth-33",
      "resolvePathPrefixSync/symlink-small-to-small",
      "resolvePathPrefixSync/symlink-small-to-large",
      "resolvePathPrefixSync/symlink-large-to-small",
      "resolvePathPrefixSync/symlink-large-to-large",
    ]);
    expect(PATH_PREFIX_CAMPAIGN_ROWS.slice(0, 5).map(row => row.effectiveIterations))
      .toEqual(Array(5).fill(10_000));
    expect(PATH_PREFIX_CAMPAIGN_ROWS.slice(5).map(row => row.effectiveIterations))
      .toEqual(Array(6).fill(2_000));
  });

  it.each([
    ["resolvePathPrefixSync/existing", 10_000, [1, 3, 7]],
    ["resolvePathPrefixSync/symlink-large-to-large", 2_000, [2, 5]],
  ] as const)(
    "runs a full warmup, verifies distinct IDs in order, and retains the first sample for %s",
    (name, effectiveIterations, samplesUs) => {
      measuredCase(name, effectiveIterations, [...samplesUs]);
    },
  );

  it.each([
    ["early warmup", 1],
    ["middle warmup", 5_000],
    ["final warmup", 10_000],
    ["first timed result", 10_001],
    ["final timed result", 20_000],
  ] as const)("rejects an invalid %s", (_label, invalidId) => {
    let nextId = 0;
    const fixturePhases: string[] = [];
    expect(() => measurePathPrefixCampaignCase({
      name: "resolvePathPrefixSync/existing",
      sync: true,
      pathPrefixFixtureReceipt: fixtureReceipt,
      inspectPathPrefixFixture: (phase: string) => {
        fixturePhases.push(phase);
        return fixtureReceipt;
      },
      run: () => ({ id: ++nextId }),
      verify: ({ id }: { id: number }) => {
        if (id === invalidId) throw new Error(`invalid result ${id}`);
      },
    }, 1, (() => {
      let clock = 0;
      return () => clock++;
    })())).toThrow(`invalid result ${invalidId}`);
    expect(fixturePhases).toEqual(["before", "after"]);
  });

  it("derives specialization and warmup only from the exact full campaign filter", () => {
    const argsFor = (filter: string) => createRunnerArguments({
      runnerFile: "runner.mjs",
      distRoot: "dist",
      reportFile: "report.json",
      mode: "off",
      settings: { iterations: 20, samples: 5, filter },
    });
    const warmupFor = (filter: string) => {
      const args = argsFor(filter);
      return args[args.indexOf("--warmup") + 1];
    };
    expect(warmupFor("resolvePathPrefixSync/")).toBe("0");
    expect(warmupFor("resolvePathPrefixSync")).toBe("0");
    expect(warmupFor("resolvePathPrefixSync/existing")).toBe("3");
    expect(warmupFor("Root.read")).toBe("3");
    expect(pathPrefixCampaignMetadata("resolvePathPrefixSync/existing")).toBeNull();
    expect(pathPrefixCampaignMetadata("")).toBeNull();

    const staticMetadata = pathPrefixCampaignMetadata("resolvePathPrefixSync/")!;
    const actualMetadata = { ...staticMetadata, fixtureReceipts: [] };
    expect(pathPrefixMeasurementProvenance(
      { filter: "resolvePathPrefixSync/" },
      { pathPrefixCampaign: actualMetadata },
    )).toEqual({ warmup: 0, specializedMeasurement: actualMetadata });
    expect(pathPrefixMeasurementProvenance({ filter: "" })).toEqual({
      warmup: 3,
      specializedMeasurement: null,
    });
    expect(() => pathPrefixMeasurementProvenance(
      { filter: "" },
      { pathPrefixCampaign: actualMetadata },
    )).toThrow("unexpected path-prefix campaign provenance");
    expect(() => pathPrefixMeasurementProvenance({ filter: "resolvePathPrefixSync/" }))
      .toThrow("missing specialized measurement provenance");
  });
});
