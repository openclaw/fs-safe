import { describe, expect, it } from "vitest";
import {
  PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME,
  PUBLIC_ZIP_EXTRACTION_DIVISOR,
  PUBLIC_ZIP_EXTRACTION_FIXTURE,
  PUBLIC_ZIP_EXTRACTION_WORKLOAD,
  validatePublicZipExtractionReport,
  validatePublicZipExtractionWorkloadResult,
} from "../benchmarks/public-zip-extraction-contract.mjs";
import {
  SAMPLE_SEMANTICS,
  validateMeasuredDistribution,
} from "../benchmarks/measured-distribution.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_TREE = "b".repeat(40);
const FILENAME_BLOB = "c".repeat(40);
const FILENAME_HASH = "d".repeat(64);
const DIST_HASH = "e".repeat(64);

function validRow() {
  return {
    name: PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME,
    iterations: 2,
    samplesUs: [1],
    minUs: 1,
    medianUs: 1,
    maxUs: 1,
    workloadSemantics: "equivalent-output",
    workloadDetails: PUBLIC_ZIP_EXTRACTION_WORKLOAD,
    fixturePlacement: PUBLIC_ZIP_EXTRACTION_FIXTURE,
  };
}

function ordinaryArchiveRow() {
  return {
    name: "extractArchive/tar",
    iterations: 2,
    samplesUs: [1],
    minUs: 1,
    medianUs: 1,
    maxUs: 1,
  };
}

function measuredFixture(results = [validRow(), ordinaryArchiveRow()]) {
  const source = {
    commit: SOURCE_COMMIT,
    tree: SOURCE_TREE,
    filenameSourceBlob: FILENAME_BLOB,
    filenameSourceHash: FILENAME_HASH,
    filenameFallbackProfile: "sanitized",
  };
  const plan = {
    settings: { filter: "extractArchive", iterations: 20, samples: 1 },
    builds: [{ id: "candidate-build", sourceRole: "candidate" }],
    sources: { candidate: source },
  };
  const reportPlan = { buildId: "candidate-build", file: "candidate.json" };
  const report = {
    metadata: {
      distHash: DIST_HASH,
      measuredDistribution: {
        binding: "method-audit-plan-v1",
        buildId: "candidate-build",
        sourceRole: "candidate",
        sourceCommit: SOURCE_COMMIT,
        sourceTree: SOURCE_TREE,
        filenameSourceBlob: FILENAME_BLOB,
        filenameSourceHash: FILENAME_HASH,
        expectedFilenameFallbackProfile: "sanitized",
        observedFilenameFallbackProfile: "sanitized",
        distHash: DIST_HASH,
      },
      sampleSemantics: SAMPLE_SEMANTICS,
    },
    results,
  };
  return { plan, reportPlan, report };
}

describe("public ZIP extraction benchmark receipt", () => {
  it("freezes the literal workload and fixture receipts", () => {
    expect(PUBLIC_ZIP_EXTRACTION_DIVISOR).toBe(10);
    expect(PUBLIC_ZIP_EXTRACTION_WORKLOAD).toEqual({
      schemaVersion: 1,
      publicOperation: "extractArchive",
      outcome: "success",
      archiveKind: "zip",
      destinationState: "existing-empty-directory",
      entryCount: 1,
      extractedBytes: 11,
      durable: false,
      timeoutMs: 30_000,
      timedBoundary: "public-call-only",
      verification: "exact-entry-set+parsed-json-payload",
    });
    expect(PUBLIC_ZIP_EXTRACTION_FIXTURE).toEqual({
      archiveCreation: "registration-outside-invocations",
      beforeEach: "assert-empty-destination",
      afterEach: "verify-publication-and-remove-entry",
      timed: "extractArchive-call-only",
    });
    expect(Object.isFrozen(PUBLIC_ZIP_EXTRACTION_WORKLOAD)).toBe(true);
    expect(Object.isFrozen(PUBLIC_ZIP_EXTRACTION_FIXTURE)).toBe(true);
  });

  it.each(["", "zip", PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME])(
    "admits the exact selected workload for filter %j",
    (filter) => {
      const row = validRow();
      expect(() => validatePublicZipExtractionWorkloadResult(row)).not.toThrow();
      expect(() => validatePublicZipExtractionReport(
        { results: [row] },
        filter,
        20,
      )).not.toThrow();
    },
  );

  it("rejects missing, duplicate, skipped, mutated, or miscounted rows", () => {
    const row = validRow();
    expect(() => validatePublicZipExtractionReport(
      { results: [] },
      "extractArchive",
      20,
    )).toThrow("row set mismatch");
    expect(() => validatePublicZipExtractionReport(
      { results: [row, row] },
      "extractArchive",
      20,
    )).toThrow("row set mismatch");
    for (const name of ["extractArchive/zip-renamed", "extractArchive/tar"]) {
      expect(() => validatePublicZipExtractionReport(
        { results: [{ ...row, name }] },
        "extractArchive",
        20,
      )).toThrow("row set mismatch");
    }
    expect(() => validatePublicZipExtractionReport(
      { results: [{ ...row, skipped: "not run" }] },
      "extractArchive",
      20,
    )).toThrow("must execute rather than skip");
    expect(() => validatePublicZipExtractionReport(
      { results: [{ ...row, iterations: 1 }] },
      "extractArchive",
      20,
    )).toThrow("iteration count mismatch");
    expect(() => validatePublicZipExtractionWorkloadResult({
      ...row,
      workloadSemantics: "changed-output",
    })).toThrow("workload semantics mismatch");
    expect(() => validatePublicZipExtractionWorkloadResult({
      ...row,
      workloadSemantics: undefined,
    })).toThrow("workload semantics mismatch");
    const missingWorkload: Record<string, unknown> = { ...PUBLIC_ZIP_EXTRACTION_WORKLOAD };
    delete missingWorkload.outcome;
    expect(() => validatePublicZipExtractionWorkloadResult({
      ...row,
      workloadDetails: missingWorkload,
    })).toThrow("workload details mismatch");
    expect(() => validatePublicZipExtractionWorkloadResult({
      ...row,
      workloadDetails: { ...PUBLIC_ZIP_EXTRACTION_WORKLOAD, outcome: "failure" },
    })).toThrow("workload details mismatch");
    expect(() => validatePublicZipExtractionWorkloadResult({
      ...row,
      workloadDetails: { ...PUBLIC_ZIP_EXTRACTION_WORKLOAD, unexpected: true },
    })).toThrow("workload details mismatch");
    const missingFixture: Record<string, unknown> = { ...PUBLIC_ZIP_EXTRACTION_FIXTURE };
    delete missingFixture.timed;
    expect(() => validatePublicZipExtractionWorkloadResult({
      ...row,
      fixturePlacement: missingFixture,
    })).toThrow("fixture placement mismatch");
    expect(() => validatePublicZipExtractionWorkloadResult({
      ...row,
      fixturePlacement: { ...PUBLIC_ZIP_EXTRACTION_FIXTURE, timed: "setup+call" },
    })).toThrow("fixture placement mismatch");
    expect(() => validatePublicZipExtractionWorkloadResult({
      ...row,
      fixturePlacement: { ...PUBLIC_ZIP_EXTRACTION_FIXTURE, unexpected: true },
    })).toThrow("fixture placement mismatch");
  });

  it.each(["root", "extractArchive/zip-512"])(
    "admits filter %j without a ZIP row",
    (filter) => {
      expect(() => validatePublicZipExtractionReport(
        { results: [] },
        filter,
        undefined,
      )).not.toThrow();
    },
  );

  it("rejects an exact ZIP row under an excluding filter", () => {
    expect(() => validatePublicZipExtractionReport(
      { results: [validRow()] },
      "root",
      20,
    )).toThrow("row set mismatch");
  });

  it.each([
    [1, 1],
    [9, 1],
    [10, 1],
    [19, 1],
    [20, 2],
    [25, 2],
  ])("binds %i planned iterations to %i measured iterations", (planned, measured) => {
    expect(() => validatePublicZipExtractionReport(
      { results: [{ ...validRow(), iterations: measured }] },
      PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME,
      planned,
    )).not.toThrow();
  });

  it.each([undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "20"])(
    "rejects invalid planned iterations %j",
    (planned) => {
      expect(() => validatePublicZipExtractionReport(
        { results: [validRow()] },
        PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME,
        planned,
      )).toThrow("planned iterations are invalid");
    },
  );

  it("connects ZIP row and receipt admission to measured-distribution validation", () => {
    const { plan, reportPlan, report } = measuredFixture();
    expect(() => validateMeasuredDistribution(plan, reportPlan, report, DIST_HASH)).not.toThrow();

    expect(() => validateMeasuredDistribution(
      plan,
      reportPlan,
      { ...report, results: [ordinaryArchiveRow()] },
      DIST_HASH,
    )).toThrow("row set mismatch");
    expect(() => validateMeasuredDistribution(
      plan,
      reportPlan,
      {
        ...report,
        results: [
          { ...validRow(), workloadDetails: { ...PUBLIC_ZIP_EXTRACTION_WORKLOAD, outcome: "failure" } },
          ordinaryArchiveRow(),
        ],
      },
      DIST_HASH,
    )).toThrow("workload details mismatch");
    expect(() => validateMeasuredDistribution(
      plan,
      reportPlan,
      { ...report, results: [{ ...validRow(), skipped: "not run" }, ordinaryArchiveRow()] },
      DIST_HASH,
    )).toThrow("must execute rather than skip");
  });
});
