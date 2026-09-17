import { sidecarPathSnapshotCases } from "../../benchmarks/sidecar-path-snapshot.mjs";
import {
  PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME,
  PUBLIC_ZIP_EXTRACTION_DIVISOR,
  PUBLIC_ZIP_EXTRACTION_FIXTURE,
  PUBLIC_ZIP_EXTRACTION_WORKLOAD,
} from "../../benchmarks/public-zip-extraction-contract.mjs";

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
    measured({
      name: PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME,
      workloadSemantics: "equivalent-output",
      workloadDetails: PUBLIC_ZIP_EXTRACTION_WORKLOAD,
      fixturePlacement: PUBLIC_ZIP_EXTRACTION_FIXTURE,
    }, sampleCount, Math.max(1, Math.floor(iterations / PUBLIC_ZIP_EXTRACTION_DIVISOR))),
  ];
}
