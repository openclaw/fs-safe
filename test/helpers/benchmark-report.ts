import { sidecarPathSnapshotCases } from "../../benchmarks/sidecar-path-snapshot.mjs";
import {
  LIVE_PERMISSION_CONTROL_NAME,
  WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME,
  WINDOWS_OWNER_DIAGNOSTIC_FIXTURE,
  WINDOWS_OWNER_DIAGNOSTIC_WORKLOAD,
} from "../../benchmarks/windows-owner-diagnostic.mjs";

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
    measured({ name: LIVE_PERMISSION_CONTROL_NAME }, sampleCount, iterations),
    measured({
      name: WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME,
      workloadSemantics: "equivalent-output",
      workloadDetails: WINDOWS_OWNER_DIAGNOSTIC_WORKLOAD,
      fixturePlacement: WINDOWS_OWNER_DIAGNOSTIC_FIXTURE,
    }, sampleCount, Math.max(1, Math.floor(iterations / 20))),
  ];
}
