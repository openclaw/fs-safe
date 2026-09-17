import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ATOMIC_SETTLEMENT_NAMES = Object.freeze([
  "replaceFileAtomic/settlement/success",
  "replaceFileAtomicSync/settlement/success",
  "FileStoreSync.write/settlement/success",
]);

export const ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN = Object.freeze({
  schema: "fs-safe-atomic-settlement-performance-v1",
  platforms: Object.freeze(["linux", "macos", "windows"]),
  nodeVersions: Object.freeze(["22", "24"]),
  orders: Object.freeze(["abba", "baab"]),
  studies: Object.freeze([
    "source-comparison",
    "same-source-rebuild",
    "same-artifact",
  ]),
  modes: Object.freeze(["off", "require"]),
  blocks: 5,
  positionsPerBlock: 4,
  configuredIterations: 200,
  iterationsPerSample: 10,
  samples: 9,
  warmup: 3,
  matrixJobs: 36,
  rawReportProcesses: 1440,
  cells: Object.freeze({ ordered: 216, combinedOrders: 108, total: 324 }),
  gates: Object.freeze({
    median: Object.freeze({ relativePercent: 10, absoluteUs: 50 }),
    maximumSampleAverage: Object.freeze({ relativePercent: 20, absoluteUs: 100 }),
    operator: "relative OR absolute",
  }),
  replacementPolicy: "A failed, incomplete, or rerun campaign may be replaced only in full.",
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const ATOMIC_SETTLEMENT_DESCRIPTOR = Object.freeze({
  campaign: ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN,
  rows: Object.freeze(ATOMIC_SETTLEMENT_NAMES.map((name, index) => Object.freeze({
    name,
    async: index === 0,
    divisor: 20,
    workloadSemantics:
      "successful replacement of an existing regular file; fixture setup and verification are untimed",
    workloadDetails: Object.freeze({
      bytes: 28,
      destination: "existing",
      durable: false,
      settlement: "publication-then-retained-handle-close",
    }),
  }))),
});

export const ATOMIC_SETTLEMENT_PERFORMANCE_DESCRIPTOR_SHA256 = createHash("sha256")
  .update(stableJson(ATOMIC_SETTLEMENT_DESCRIPTOR)).digest("hex");

export function validateAtomicSettlementPerformanceResult(result) {
  if (!ATOMIC_SETTLEMENT_NAMES.includes(result?.name)) return;
  const expected = ATOMIC_SETTLEMENT_DESCRIPTOR.rows.find(({ name }) => name === result.name);
  assert.equal(result.skipped, undefined, `${result.name} must be measured`);
  assert.equal(result.workloadSemantics, expected.workloadSemantics,
    `${result.name} workload semantics changed`);
  assert.deepEqual(result.workloadDetails, expected.workloadDetails,
    `${result.name} workload descriptor changed`);
}

export function validateAtomicSettlementPerformanceReport(
  report,
  filter = "",
  configuredIterations = ATOMIC_SETTLEMENT_PERFORMANCE_CAMPAIGN.configuredIterations,
) {
  const results = (report?.results ?? []).filter(({ name }) =>
    ATOMIC_SETTLEMENT_NAMES.includes(name));
  if (results.length === 0 && filter !== "settlement/success") return;
  const expectedNames = ATOMIC_SETTLEMENT_NAMES.filter((name) =>
    !filter || name.includes(filter));
  assert.deepEqual(results.map(({ name }) => name), expectedNames,
    "atomic settlement report result set or order changed");
  if (filter === "settlement/success") {
    assert.deepEqual(report.results.map(({ name }) => name), ATOMIC_SETTLEMENT_NAMES,
      "atomic settlement campaign contains an unrelated workload");
  }
  const expectedIterations = Math.max(1, Math.floor(configuredIterations / 20));
  for (const result of results) {
    validateAtomicSettlementPerformanceResult(result);
    assert.equal(result.iterations, expectedIterations,
      `${result.name} calls per sample changed`);
    assert.equal(result.samplesUs?.length, report.metadata?.samples,
      `${result.name} sample count changed`);
  }
}

export function registerAtomicSettlement({ api, workspace, register }) {
  const fixture = path.join(workspace, "atomic-settlement");
  const atomicTarget = path.join(fixture, "atomic-target");
  const storeRoot = path.join(fixture, "store");
  const storeTarget = path.join(storeRoot, "value");
  const content = Buffer.from("atomic settlement benchmark\n");
  fs.mkdirSync(storeRoot, { recursive: true });
  const store = api.fileStoreSync({ rootDir: storeRoot, durable: false });
  const options = {
    divisor: 20,
    workloadSemantics:
      "successful replacement of an existing regular file; fixture setup and verification are untimed",
    workloadDetails: {
      bytes: content.byteLength,
      destination: "existing",
      durable: false,
      settlement: "publication-then-retained-handle-close",
    },
  };

  register(
    ATOMIC_SETTLEMENT_NAMES[0],
    () => api.replaceFileAtomic({ filePath: atomicTarget, content }),
    {
      ...options,
      before: () => fs.writeFileSync(atomicTarget, "previous"),
      verify: result => {
        assert.deepEqual(result, { method: "rename" });
        assert.deepEqual(fs.readFileSync(atomicTarget), content);
      },
    },
  );
  register(
    ATOMIC_SETTLEMENT_NAMES[1],
    () => api.replaceFileAtomicSync({ filePath: atomicTarget, content }),
    {
      ...options,
      sync: true,
      before: () => fs.writeFileSync(atomicTarget, "previous"),
      verify: result => {
        assert.deepEqual(result, { method: "rename" });
        assert.deepEqual(fs.readFileSync(atomicTarget), content);
      },
    },
  );
  register(
    ATOMIC_SETTLEMENT_NAMES[2],
    () => store.write("value", content, { durable: false }),
    {
      ...options,
      sync: true,
      before: () => fs.writeFileSync(storeTarget, "previous"),
      verify: result => {
        assert.equal(result, storeTarget);
        assert.deepEqual(fs.readFileSync(storeTarget), content);
      },
    },
  );
}
