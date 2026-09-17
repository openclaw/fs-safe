import { sidecarPathSnapshotCases } from "../../benchmarks/sidecar-path-snapshot.mjs";
import {
  WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE,
  WINDOWS_OWNER_CAUGHT_FAILURE_NAMES,
  WINDOWS_OWNER_CAUGHT_FAILURE_RECEIPT,
  windowsOwnerCaughtFailureIterations,
} from "../../benchmarks/windows-owner-caught-failure.mjs";

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
    ...WINDOWS_OWNER_CAUGHT_FAILURE_NAMES.map((name) => measured({
      name,
      workloadSemantics: "equivalent-output",
      workloadDetails: {
        ...WINDOWS_OWNER_CAUGHT_FAILURE_RECEIPT,
        cohort: name.split("/").at(-1),
      },
      fixturePlacement: WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE,
    }, sampleCount, windowsOwnerCaughtFailureIterations(name, iterations))),
  ];
}
