import { sidecarPathSnapshotCases } from "../../benchmarks/sidecar-path-snapshot.mjs";
import { copyFallbackSuccessDescriptors } from "../../benchmarks/copy-fallback-success.mjs";
import { syncCopyFallbackAdmissionDescriptors } from "../../benchmarks/sync-copy-fallback-admission.mjs";
import {
  PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME,
  PUBLIC_ZIP_EXTRACTION_DIVISOR,
  PUBLIC_ZIP_EXTRACTION_FIXTURE,
  PUBLIC_ZIP_EXTRACTION_WORKLOAD,
} from "../../benchmarks/public-zip-extraction-contract.mjs";
import { ATOMIC_TEMP_SETTLEMENT_CASES } from "../../benchmarks/atomic-temp-settlement.mjs";
import {
  copyTreeSuccessDescriptors,
  copyTreeSuccessFixtureReceipt,
  PROBE_TREE_SUCCESS_WORKLOAD,
  probeTreeSuccessFixtureReceipt,
} from "../../benchmarks/copy-tree-success.mjs";

function measured(row: object, sampleCount: number, iterations: number) {
  return {
    ...row,
    iterations,
    samplesUs: Array.from({ length: sampleCount }, () => 1),
    minUs: 1,
    medianUs: 1,
    maxUs: 1,
  };
}

export function completeSyntheticBenchmarkResults(
  sampleCount: number,
  iterations: number,
  nativeMode = "off",
) {
  const sidecarRows = sidecarPathSnapshotCases({
    platform: "win32",
    cwd: "C:\\work",
    workspace: "C:\\temp\\fixture",
  });
  const syncAdmissionRows = syncCopyFallbackAdmissionDescriptors();
  return [
    measured({ name: "root" }, sampleCount, iterations),
    measured({
      name: "probeTreeClone",
      workloadSemantics: "equivalent-output",
      workloadDetails: PROBE_TREE_SUCCESS_WORKLOAD,
      fixturePlacement: probeTreeSuccessFixtureReceipt(null, nativeMode),
    }, sampleCount, iterations),
    ...sidecarRows.map((row) => measured(row, sampleCount, iterations)),
    ...copyFallbackSuccessDescriptors().map((row) => measured({
      name: row.name,
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
    }, sampleCount, Math.max(1, Math.floor(iterations / row.divisor)))),
    ...syncAdmissionRows.map((row) => measured(row, sampleCount,
      Math.max(1, Math.floor(iterations / 10)))),
    measured({
      name: PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME,
      workloadSemantics: "equivalent-output",
      workloadDetails: PUBLIC_ZIP_EXTRACTION_WORKLOAD,
      fixturePlacement: PUBLIC_ZIP_EXTRACTION_FIXTURE,
    }, sampleCount, Math.max(1, Math.floor(iterations / PUBLIC_ZIP_EXTRACTION_DIVISOR))),
    ...ATOMIC_TEMP_SETTLEMENT_CASES.map((row) => measured({
      ...row,
      fixturePlacement: "unique child directory on the runner workspace filesystem",
    }, sampleCount, iterations)),
    ...copyTreeSuccessDescriptors().map((row) => measured({
      name: row.name,
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
      fixturePlacement: copyTreeSuccessFixtureReceipt(row, { nativeMode }),
    }, sampleCount, Math.max(1, Math.floor(iterations / row.divisor)))),
  ];
}
