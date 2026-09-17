import { sidecarPathSnapshotCases } from "../../benchmarks/sidecar-path-snapshot.mjs";
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
  return [
    measured({ name: "root" }, sampleCount, iterations),
    measured({
      name: "probeTreeClone",
      workloadSemantics: "equivalent-output",
      workloadDetails: PROBE_TREE_SUCCESS_WORKLOAD,
      fixturePlacement: probeTreeSuccessFixtureReceipt(null, nativeMode),
    }, sampleCount, iterations),
    ...sidecarRows.map((row) => measured(row, sampleCount, iterations)),
    ...copyTreeSuccessDescriptors().map((row) => measured({
      name: row.name,
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
      fixturePlacement: copyTreeSuccessFixtureReceipt(row, { nativeMode }),
    }, sampleCount, Math.max(1, Math.floor(iterations / row.divisor)))),
  ];
}
