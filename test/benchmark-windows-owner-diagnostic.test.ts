import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_PERMISSION_CONTROL_NAME,
  WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME,
  WINDOWS_OWNER_DIAGNOSTIC_FIXTURE,
  WINDOWS_OWNER_DIAGNOSTIC_WORKLOAD,
  registerWindowsOwnerDiagnostic,
  validateWindowsOwnerDiagnosticReport,
  validateWindowsOwnerDiagnosticWorkloadResult,
  verifyLivePermissionControl,
} from "../benchmarks/windows-owner-diagnostic.mjs";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import { inspectPathPermissions } from "../src/permissions.js";

type WindowsOwnerBenchmarkOptions = {
  divisor: number;
  skip?: string;
  before: () => void;
  after: (result: unknown) => void;
  workloadSemantics: string;
  workloadDetails: Record<string, unknown>;
  fixturePlacement: Record<string, unknown>;
};

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
});

describe("Windows owner diagnostic benchmark receipt", () => {
  it("executes and verifies the public injected-success fallback outside timing", async () => {
    configureFsSafeNative({ mode: "off" });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-owner-diagnostic-bench-"));
    const cleanups: Array<() => void> = [];
    const rows: Array<{
      name: string;
      run: () => Promise<unknown>;
      options: WindowsOwnerBenchmarkOptions;
    }> = [];
    try {
      registerWindowsOwnerDiagnostic({
        api: { inspectPathPermissions },
        workspace,
        native: false,
        register: (
          name: string,
          run: () => Promise<unknown>,
          options: WindowsOwnerBenchmarkOptions,
        ) => rows.push({ name, run, options }),
        onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
      });

      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.name).toBe(WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME);
      expect(row.options.skip).toBeUndefined();
      expect(row.options.workloadSemantics).toBe("equivalent-output");
      expect(row.options.workloadDetails).toBe(WINDOWS_OWNER_DIAGNOSTIC_WORKLOAD);
      expect(row.options.fixturePlacement).toBe(WINDOWS_OWNER_DIAGNOSTIC_FIXTURE);
      expect(Object.isFrozen(row.options.workloadDetails)).toBe(true);
      expect(Object.isFrozen(row.options.fixturePlacement)).toBe(true);

      row.options.before();
      const result = await row.run();
      expect(() => row.options.after(result)).not.toThrow();
    } finally {
      cleanups.reverse().forEach((cleanup) => cleanup());
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("executes and verifies the native Windows route without calling the fallback", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-owner-diagnostic-bench-"));
    const cleanups: Array<() => void> = [];
    const rows: Array<{
      run: () => Promise<unknown>;
      options: WindowsOwnerBenchmarkOptions;
    }> = [];
    const inspect = async () => ({
      ok: true,
      source: "windows-acl",
      ownerSid: "s-1-5-21-42",
      ownerTrusted: true,
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: false,
    });
    try {
      registerWindowsOwnerDiagnostic({
        api: { inspectPathPermissions: inspect },
        workspace,
        native: true,
        platform: "win32",
        register: (
          _name: string,
          run: () => Promise<unknown>,
          options: WindowsOwnerBenchmarkOptions,
        ) => rows.push({ run, options }),
        onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
      });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      row.options.before();
      const result = await row.run();
      expect(() => row.options.after(result)).not.toThrow();
      for (const unsafe of [
        { ...(result as object), ownerSid: undefined },
        { ...(result as object), ownerSid: "invalid" },
        { ...(result as object), errorDetail: { code: "EIO" } },
        { ...(result as object), worldWritable: true },
        { ...(result as object), groupWritable: true },
        { ...(result as object), worldReadable: true },
        { ...(result as object), groupReadable: true },
      ]) {
        expect(() => row.options.after(unsafe)).toThrow();
      }
    } finally {
      cleanups.reverse().forEach((cleanup) => cleanup());
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an unknown-source live control", () => {
    expect(() => verifyLivePermissionControl({
      ok: true,
      source: "unknown",
      worldWritable: false,
      groupWritable: false,
    }, "win32")).toThrow("live permission control used an unverified source");
  });

  it("rejects a populated diagnostic detail from an otherwise safe live control", () => {
    expect(() => verifyLivePermissionControl({
      ok: true,
      source: "posix",
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: false,
      errorDetail: { code: "EIO" },
    }, "linux")).toThrow("live permission control retained an error detail");
  });

  it("requires the exact unskipped row, receipt, mode, and iteration count", () => {
    const valid = {
      name: WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME,
      iterations: 1,
      samplesUs: [1],
      minUs: 1,
      medianUs: 1,
      maxUs: 1,
      workloadSemantics: "equivalent-output",
      workloadDetails: WINDOWS_OWNER_DIAGNOSTIC_WORKLOAD,
      fixturePlacement: WINDOWS_OWNER_DIAGNOSTIC_FIXTURE,
    };
    const live = {
      name: LIVE_PERMISSION_CONTROL_NAME,
      iterations: 20,
      samplesUs: [1],
      minUs: 1,
      medianUs: 1,
      maxUs: 1,
    };
    const report = { metadata: { mode: "off" }, results: [live, valid] };

    expect(() => validateWindowsOwnerDiagnosticWorkloadResult(valid)).not.toThrow();
    expect(() => validateWindowsOwnerDiagnosticReport(
      report,
      "inspectPathPermissions",
      20,
    )).not.toThrow();
    expect(() => validateWindowsOwnerDiagnosticReport(
      { ...report, results: [live] },
      "inspectPathPermissions",
      20,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerDiagnosticReport(
      { ...report, results: [live, valid, valid] },
      "inspectPathPermissions",
      20,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerDiagnosticReport(
      { ...report, metadata: { mode: "auto" } },
      "inspectPathPermissions",
      20,
    )).toThrow("native mode mismatch");
    expect(() => validateWindowsOwnerDiagnosticReport(
      { ...report, results: [{ ...live, iterations: 19 }, valid] },
      "inspectPathPermissions",
      20,
    )).toThrow("live permission control iteration count mismatch");
    expect(() => validateWindowsOwnerDiagnosticReport(
      { ...report, results: [live, { ...valid, iterations: 2 }] },
      "inspectPathPermissions",
      20,
    )).toThrow("iteration count mismatch");
    expect(() => validateWindowsOwnerDiagnosticWorkloadResult({
      ...valid,
      skipped: "not run",
    })).toThrow("must execute rather than skip");
    expect(() => validateWindowsOwnerDiagnosticWorkloadResult({
      ...valid,
      workloadDetails: { ...WINDOWS_OWNER_DIAGNOSTIC_WORKLOAD, query: "changed" },
    })).toThrow("workload details mismatch");
    expect(() => validateWindowsOwnerDiagnosticWorkloadResult({
      ...valid,
      fixturePlacement: { ...WINDOWS_OWNER_DIAGNOSTIC_FIXTURE, setup: "timed" },
    })).toThrow("fixture placement mismatch");
    expect(() => validateWindowsOwnerDiagnosticReport(
      { ...report, results: [valid] },
      "inspectPathPermissions",
      20,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerDiagnosticReport(
      { ...report, results: [{ ...live, skipped: "not run" }, valid] },
      "inspectPathPermissions",
      20,
    )).toThrow("control must execute rather than skip");
    expect(() => validateWindowsOwnerDiagnosticReport(
      { metadata: { mode: "require" }, results: [valid] },
      WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME,
      20,
    )).not.toThrow();
    expect(() => validateWindowsOwnerDiagnosticReport(
      { metadata: { mode: "off" }, results: [] },
      "unrelated-filter",
      20,
    )).not.toThrow();
  });
});
