import { sidecarPathSnapshotCases } from "../../benchmarks/sidecar-path-snapshot.mjs";
import { copyFallbackSuccessDescriptors } from "../../benchmarks/copy-fallback-success.mjs";

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
    ...copyFallbackSuccessDescriptors().map((row) => measured({
      name: row.name,
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
    }, sampleCount, Math.max(1, Math.floor(iterations / row.divisor)))),
  ];
}
