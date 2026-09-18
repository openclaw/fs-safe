import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COPY_FALLBACK_SUCCESS_NAMES,
  copyFallbackSuccessDescriptors,
  registerCopyFallbackSuccess,
  validateCopyFallbackSuccessReport,
  validateCopyFallbackSuccessWorkloadResult,
} from "../benchmarks/copy-fallback-success.mjs";

function measuredRows(requestedIterations: number) {
  return copyFallbackSuccessDescriptors().map((row) => ({
    name: row.name,
    workloadSemantics: row.workloadSemantics,
    workloadDetails: row.workloadDetails,
    iterations: Math.max(1, Math.floor(requestedIterations / row.divisor)),
    samplesUs: [1],
    minUs: 1,
    medianUs: 1,
    maxUs: 1,
  }));
}

describe("copy-fallback success benchmark receipt", () => {
  it("freezes the existing twelve public success rows and their workload receipts", () => {
    expect(COPY_FALLBACK_SUCCESS_NAMES).toEqual([
      "replaceFileAtomic/copy-fallback/none/128",
      "replaceFileAtomicSync/copy-fallback/none/128",
      "replaceFileAtomic/copy-fallback/restore-original/128",
      "replaceFileAtomicSync/copy-fallback/restore-original/128",
      "replaceFileAtomic/copy-fallback/none/1048576",
      "replaceFileAtomicSync/copy-fallback/none/1048576",
      "replaceFileAtomic/copy-fallback/restore-original/1048576",
      "replaceFileAtomicSync/copy-fallback/restore-original/1048576",
      "replaceFileAtomic/copy-fallback/none/16777216",
      "replaceFileAtomicSync/copy-fallback/none/16777216",
      "replaceFileAtomic/copy-fallback/restore-original/16777216",
      "replaceFileAtomicSync/copy-fallback/restore-original/16777216",
    ]);
    expect(new Set(COPY_FALLBACK_SUCCESS_NAMES).size).toBe(12);
    const descriptors = copyFallbackSuccessDescriptors();
    expect(Object.isFrozen(descriptors)).toBe(true);
    for (const row of descriptors) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.workloadDetails)).toBe(true);
      expect(Object.isFrozen(row.workloadDetails.timedOperations)).toBe(true);
      expect(Object.isFrozen(row.workloadDetails.untimedOperations)).toBe(true);
      expect(row.divisor).toBe(100);
      expect(row.workloadSemantics).toBe("equivalent-output");
      expect(row.workloadDetails).toMatchObject({
        publicMethod: row.publicMethod,
        fallbackTrigger: "injected-rename-EPERM",
        destinationLayout: "existing-regular-file",
        restorePolicy: row.restorePolicy,
        payloadBytes: row.payloadBytes,
        syncTempFile: false,
        syncParentDir: false,
      });
      expect(() => validateCopyFallbackSuccessWorkloadResult(row)).not.toThrow();
    }
  });

  it("registers unchanged public calls with setup and complete verification outside timing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-copy-benchmark-"));
    type Options = {
      filePath: string;
      content: Uint8Array;
      copyFallbackOnPermissionError: boolean;
      copyFallbackRestore: string;
      syncTempFile: boolean;
      syncParentDir: boolean;
    };
    type Registration = {
      name: string;
      run: () => unknown;
      options: {
        sync: boolean;
        divisor: number;
        workloadSemantics: string;
        workloadDetails: object;
        before: () => void;
        after: (result: unknown) => void;
      };
    };
    const calls: Options[] = [];
    const invoke = (options: Options) => {
      calls.push(options);
      fs.writeFileSync(options.filePath, options.content);
      return { method: "copy-fallback" };
    };
    const rows: Registration[] = [];
    try {
      registerCopyFallbackSuccess({
        api: {
          replaceFileAtomic: async (options: Options) => invoke(options),
          replaceFileAtomicSync: invoke,
        },
        workspace,
        register: (name: string, run: () => unknown, options: Registration["options"]) => {
          rows.push({ name, run, options });
        },
      });
      expect(rows.map(({ name }) => name)).toEqual(COPY_FALLBACK_SUCCESS_NAMES);
      for (const row of [rows[0], rows[1], rows.at(-1)!]) {
        row.options.before();
        const result = row.options.sync ? row.run() : await row.run();
        row.options.after(result);
      }
      expect(calls).toHaveLength(3);
      expect(calls[0]).toMatchObject({
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "none",
        syncTempFile: false,
        syncParentDir: false,
      });
      expect(calls.at(-1)).toMatchObject({ copyFallbackRestore: "restore-original" });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects missing, duplicate, skipped, mutated, mis-sized, and mis-filtered reports", () => {
    const requestedIterations = 500;
    const rows = measuredRows(requestedIterations);
    const report = { results: rows };
    expect(() => validateCopyFallbackSuccessReport(report, "", requestedIterations)).not.toThrow();
    expect(() => validateCopyFallbackSuccessReport({ results: rows.slice(0, -1) }, "", requestedIterations))
      .toThrow("report row set mismatch");
    expect(() => validateCopyFallbackSuccessReport({ results: [...rows, rows[0]] }, "", requestedIterations))
      .toThrow("report row set mismatch");
    expect(() => validateCopyFallbackSuccessReport({
      results: rows.map((row, index) => index === 0 ? { ...row, skipped: "unavailable" } : row),
    }, "", requestedIterations)).toThrow("row was not measured");
    expect(() => validateCopyFallbackSuccessReport({
      results: rows.map((row, index) => index === 0
        ? { ...row, workloadDetails: { ...row.workloadDetails, syncTempFile: true } } : row),
    }, "", requestedIterations)).toThrow("workload receipt mismatch");
    expect(() => validateCopyFallbackSuccessReport({
      results: rows.map((row, index) => index === 0 ? { ...row, iterations: 500 } : row),
    }, "", requestedIterations)).toThrow("iteration count mismatch");

    const filter = COPY_FALLBACK_SUCCESS_NAMES[0];
    expect(() => validateCopyFallbackSuccessReport({ results: [rows[0]] }, filter, requestedIterations))
      .not.toThrow();
    expect(() => validateCopyFallbackSuccessReport({ results: rows.slice(0, 2) }, filter, requestedIterations))
      .toThrow("report row set mismatch");
    expect(() => validateCopyFallbackSuccessReport({ results: [] }, "unrelated-workload", requestedIterations))
      .not.toThrow();
  });

  it("rejects unknown rows and validates runner reports during finalization", () => {
    expect(() => validateCopyFallbackSuccessWorkloadResult({
      name: "replaceFileAtomic/copy-fallback/unknown/128",
    })).toThrow("Unknown copy-fallback success row");
    const evidence = fs.readFileSync("benchmarks/measured-distribution.mjs", "utf8");
    const runner = fs.readFileSync("benchmarks/runner.mjs", "utf8").replace(/\r\n/g, "\n");
    expect(evidence).toContain("validateCopyFallbackSuccessWorkloadResult(result);");
    expect(evidence).toContain(
      "validateCopyFallbackSuccessReport(report, plan.settings.filter, plan.settings.iterations);",
    );
    const imports = runner.slice(0, runner.indexOf("const args ="));
    expect(imports).toContain(
      'import { validateCopyFallbackSuccessReport } from "./copy-fallback-success.mjs";',
    );
    const guestAdmission = runner.indexOf("validateGuestBenchmarkReport(completedReport, args.filter);");
    const fallbackAdmission = runner.indexOf(
      "validateCopyFallbackSuccessReport(completedReport, args.filter, args.iterations);",
    );
    const finalization = runner.indexOf("await finalizeBenchmarkReport({");
    const validation = runner.indexOf("validateReport: () => {", finalization);
    const cleanup = runner.indexOf("\n  cleanup,", validation);
    const emission = runner.indexOf("process.stdout.write(completionMessage);", cleanup);
    expect(finalization).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(finalization);
    expect(guestAdmission).toBeGreaterThan(validation);
    expect(fallbackAdmission).toBeGreaterThan(guestAdmission);
    expect(fallbackAdmission).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(emission);
    const once = runner.slice(runner.indexOf("const once = async"), runner.indexOf("const samplesUs = []"));
    expect(once.indexOf("await c.before?.()")).toBeLessThan(once.indexOf("const start = performance.now()"));
    expect(once.indexOf("elapsed = performance.now() - start"))
      .toBeLessThan(once.indexOf("c.after?.(output, input)"));
  });
});
