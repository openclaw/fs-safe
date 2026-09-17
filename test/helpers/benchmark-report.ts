import { sidecarPathSnapshotCases } from "../../benchmarks/sidecar-path-snapshot.mjs";
import { ATOMIC_TEMP_SETTLEMENT_CASES } from "../../benchmarks/atomic-temp-settlement.mjs";

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

export function completeSyntheticBenchmarkResults(sampleCount: number, iterations: number) {
  const sidecarRows = sidecarPathSnapshotCases({
    platform: "win32",
    cwd: "C:\\work",
    workspace: "C:\\temp\\fixture",
  });
  return [
    measured({ name: "root" }, sampleCount, iterations),
    ...sidecarRows.map((row) => measured(row, sampleCount, iterations)),
    ...ATOMIC_TEMP_SETTLEMENT_CASES.map((row) => measured({
      ...row,
      fixturePlacement: "unique child directory on the runner workspace filesystem",
    }, sampleCount, iterations)),
  ];
}
