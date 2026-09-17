import assert from "node:assert/strict";

export const PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME = "extractArchive/zip";
export const PUBLIC_ZIP_EXTRACTION_WORKLOAD = Object.freeze({
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
export const PUBLIC_ZIP_EXTRACTION_FIXTURE = Object.freeze({
  archiveCreation: "registration-outside-invocations",
  beforeEach: "assert-empty-destination",
  afterEach: "verify-publication-and-remove-entry",
  timed: "extractArchive-call-only",
});

export const PUBLIC_ZIP_EXTRACTION_DIVISOR = 10;

export function validatePublicZipExtractionWorkloadResult(result) {
  if (result.name !== PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME) return;
  assert.equal(result.skipped, undefined, `${result.name} must execute rather than skip`);
  assert.equal(
    result.workloadSemantics,
    "equivalent-output",
    `${result.name} workload semantics mismatch`,
  );
  assert.deepEqual(
    result.workloadDetails,
    PUBLIC_ZIP_EXTRACTION_WORKLOAD,
    `${result.name} workload details mismatch`,
  );
  assert.deepEqual(
    result.fixturePlacement,
    PUBLIC_ZIP_EXTRACTION_FIXTURE,
    `${result.name} fixture placement mismatch`,
  );
}

export function validatePublicZipExtractionReport(
  report,
  filter = "",
  configuredIterations,
) {
  const selected = !filter || PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME.includes(filter);
  const rows = (report.results ?? [])
    .filter(({ name }) => name === PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME);
  assert.deepEqual(
    rows.map(({ name }) => name),
    selected ? [PUBLIC_ZIP_EXTRACTION_BENCHMARK_NAME] : [],
    "public ZIP extraction benchmark row set mismatch",
  );
  if (!selected) return;
  assert(
    Number.isSafeInteger(configuredIterations) && configuredIterations > 0,
    "public ZIP extraction planned iterations are invalid",
  );
  const row = rows[0];
  validatePublicZipExtractionWorkloadResult(row);
  assert.equal(
    row.iterations,
    Math.max(1, Math.floor(configuredIterations / PUBLIC_ZIP_EXTRACTION_DIVISOR)),
    "public ZIP extraction iteration count mismatch",
  );
}
