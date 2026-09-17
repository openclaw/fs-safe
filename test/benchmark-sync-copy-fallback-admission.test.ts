import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  registerSyncCopyFallbackAdmission,
  SYNC_COPY_FALLBACK_ADMISSION_NAMES,
  syncCopyFallbackAdmissionDescriptors,
  validateSyncCopyFallbackAdmissionReport,
  validateSyncCopyFallbackAdmissionWorkloadResult,
} from "../benchmarks/sync-copy-fallback-admission.mjs";
import { replaceFileAtomicSync } from "../src/replace-file.js";

function measured(row: object, iterations = 2) {
  return {
    ...row,
    iterations,
    samplesUs: [1],
    minUs: 1,
    medianUs: 1,
    maxUs: 1,
  };
}

describe("synchronous copy-fallback admission benchmark", () => {
  it("freezes two portable, receipt-bound successful public paths", () => {
    expect(SYNC_COPY_FALLBACK_ADMISSION_NAMES).toEqual([
      "replaceFileAtomicSync/sync-destination-admission/rename",
      "replaceFileAtomicSync/sync-destination-admission/copy-fallback-restore",
    ]);
    const rows = syncCopyFallbackAdmissionDescriptors();
    expect(rows).toHaveLength(2);
    expect(rows.map(({ expectedDestinationCalls }) => expectedDestinationCalls)).toEqual([
      { lstatSync: 3, openSync: 1, fstatSync: 1, closeSync: 1 },
      { lstatSync: 4, openSync: 2, fstatSync: 3, closeSync: 2 },
    ]);
    for (const row of rows) {
      expect(row.workloadSemantics).toBe("equivalent-output");
      expect(row.workloadDetails.timedOperation).toBe("replaceFileAtomicSync");
      expect(row.workloadDetails.destinationHardlinks).toBe("reject");
      expect(row.workloadDetails.expectedDestinationCalls).toEqual(row.expectedDestinationCalls);
      expect(() => validateSyncCopyFallbackAdmissionWorkloadResult(row)).not.toThrow();
      expect(() => validateSyncCopyFallbackAdmissionWorkloadResult({
        ...row,
        workloadDetails: {},
      })).toThrow("workload receipt mismatch");
    }
    expect(() => validateSyncCopyFallbackAdmissionWorkloadResult({
      name: "replaceFileAtomicSync/sync-destination-admission/unknown",
    })).toThrow("Unknown sync destination-admission row");
  });

  it("executes both real public paths with untimed result, content, and call checks", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-sync-admission-bench-"));
    type Row = {
      name: string;
      run: () => unknown;
      options: {
        sync: boolean;
        divisor: number;
        before: () => void;
        verify: (result: unknown) => void;
        after: (result: unknown) => void;
      };
    };
    const rows: Row[] = [];
    try {
      registerSyncCopyFallbackAdmission({
        api: { replaceFileAtomicSync },
        workspace,
        register: (name: string, run: () => unknown, options: Row["options"]) => {
          rows.push({ name, run, options });
        },
      });
      expect(rows.map(({ name }) => name)).toEqual(SYNC_COPY_FALLBACK_ADMISSION_NAMES);
      for (const row of rows) {
        expect(row.options).toMatchObject({ sync: true, divisor: 10 });
        row.options.before();
        const result = row.run();
        row.options.verify(result);
        row.options.after(result);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects missing, skipped, duplicated, altered, and wrong-iteration rows", () => {
    const rows = syncCopyFallbackAdmissionDescriptors().map(row => measured(row));
    const report = { results: rows };
    expect(() => validateSyncCopyFallbackAdmissionReport(report, "", 20)).not.toThrow();
    expect(() => validateSyncCopyFallbackAdmissionReport({
      results: rows.slice(0, -1),
    }, "", 20)).toThrow("report row set mismatch");
    expect(() => validateSyncCopyFallbackAdmissionReport({
      results: [...rows, rows[0]],
    }, "", 20)).toThrow("report row set mismatch");
    expect(() => validateSyncCopyFallbackAdmissionReport({
      results: rows.map((row, index) => index === 0 ? { ...row, skipped: "not measured" } : row),
    }, "", 20)).toThrow("row was not measured");
    expect(() => validateSyncCopyFallbackAdmissionReport({
      results: rows.map((row, index) => index === 0 ? { ...row, workloadDetails: {} } : row),
    }, "", 20)).toThrow("workload receipt mismatch");
    expect(() => validateSyncCopyFallbackAdmissionReport({
      results: rows.map((row, index) => index === 0 ? { ...row, iterations: 3 } : row),
    }, "", 20)).toThrow("iteration count mismatch");
    expect(() => validateSyncCopyFallbackAdmissionReport({
      results: [rows[1]],
    }, SYNC_COPY_FALLBACK_ADMISSION_NAMES[1], 20)).not.toThrow();
    expect(() => validateSyncCopyFallbackAdmissionReport({
      results: [],
    }, "unrelated-filter", 20)).not.toThrow();
  });

  it("wires registration and actual evidence admission around the timer", () => {
    const scaling = fs.readFileSync("benchmarks/scaling.mjs", "utf8");
    const runner = fs.readFileSync("benchmarks/runner.mjs", "utf8");
    const evidence = fs.readFileSync("benchmarks/measured-distribution.mjs", "utf8");
    expect(scaling).toContain("registerSyncCopyFallbackAdmission({ api: a, workspace: w, register: add });");
    expect(runner).toContain("validateSyncCopyFallbackAdmissionReport(completedReport, args.filter");
    expect(evidence).toContain("validateSyncCopyFallbackAdmissionWorkloadResult(result);");
    expect(evidence).toContain("validateSyncCopyFallbackAdmissionReport(report, plan.settings.filter");
    const once = runner.slice(runner.indexOf("const once = async"), runner.indexOf("const samplesUs = []"));
    expect(once.indexOf("await c.before?.()"))
      .toBeLessThan(once.indexOf("const start = performance.now()"));
    expect(once.indexOf("elapsed = performance.now() - start"))
      .toBeLessThan(once.indexOf("finishBenchmarkInvocation("));
  });
});
