import { sidecarPathSnapshotCases } from "../../benchmarks/sidecar-path-snapshot.mjs";
import { syncCopyFallbackAdmissionDescriptors } from "../../benchmarks/sync-copy-fallback-admission.mjs";

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
  const syncAdmissionRows = syncCopyFallbackAdmissionDescriptors();
  return [
    measured({ name: "root" }, sampleCount, iterations),
    ...sidecarRows.map((row) => measured(row, sampleCount, iterations)),
    ...syncAdmissionRows.map((row) => measured(row, sampleCount,
      Math.max(1, Math.floor(iterations / 10)))),
  ];
}
