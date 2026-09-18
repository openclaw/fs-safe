import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ATOMIC_TEMP_SETTLEMENT_CASES,
  validateAtomicTempSettlementReport,
  validateAtomicTempSettlementWorkloadResult,
} from "../benchmarks/atomic-temp-settlement.mjs";

function resultFor(row: (typeof ATOMIC_TEMP_SETTLEMENT_CASES)[number]) {
  return {
    name: row.name,
    iterations: 1,
    samplesUs: [1],
    medianUs: 1,
    minUs: 1,
    maxUs: 1,
    workloadSemantics: row.workloadSemantics,
    workloadDetails: row.workloadDetails,
    fixturePlacement: "unique child directory on the runner workspace filesystem",
  };
}

describe("atomic temp settlement benchmark receipts", () => {
  it("predeclares every API, payload, durability, and target-state combination", () => {
    expect(ATOMIC_TEMP_SETTLEMENT_CASES).toHaveLength(24);
    expect(new Set(ATOMIC_TEMP_SETTLEMENT_CASES.map(({ name }) => name)).size).toBe(24);

    for (const api of ["replaceFileAtomic", "replaceFileAtomicSync", "FileStoreSync.write"]) {
      const rows = ATOMIC_TEMP_SETTLEMENT_CASES.filter(
        ({ workloadDetails }) => workloadDetails.api === api,
      );
      expect(rows).toHaveLength(8);
      expect(new Set(rows.map(({ workloadDetails }) => workloadDetails.payloadBytes)))
        .toEqual(new Set([32, 1024 * 1024]));
      expect(new Set(rows.map(({ workloadDetails }) => workloadDetails.targetState)))
        .toEqual(new Set(["missing", "existing"]));
      expect(new Set(rows.map(({ workloadDetails }) => workloadDetails.durable)))
        .toEqual(new Set([false, true]));
      expect(rows.every(({ workloadSemantics }) => workloadSemantics === "equivalent-output"))
        .toBe(true);
      expect(rows.every(({ workloadDetails }) =>
        workloadDetails.cleanupContract === "no-owned-temp-remains")).toBe(true);
    }
  });

  it("requires the complete predeclared row set selected by a performance filter", () => {
    const selected = ATOMIC_TEMP_SETTLEMENT_CASES
      .filter(({ name }) => name.includes("replaceFileAtomicSync/temp-settlement"))
      .map(resultFor);
    expect(() => validateAtomicTempSettlementReport(
      { results: selected },
      "replaceFileAtomicSync/temp-settlement",
    )).not.toThrow();
    expect(() => validateAtomicTempSettlementReport(
      { results: selected.slice(1) },
      "replaceFileAtomicSync/temp-settlement",
    )).toThrow("atomic temp settlement row set is incomplete");
  });

  it("rejects tampered semantics, details, fixture placement, and skips", () => {
    const expected = resultFor(ATOMIC_TEMP_SETTLEMENT_CASES[0]!);
    expect(() => validateAtomicTempSettlementWorkloadResult(expected)).not.toThrow();
    expect(() => validateAtomicTempSettlementWorkloadResult({
      ...expected,
      workloadSemantics: "changed-output",
    })).toThrow("workload semantics mismatch");
    expect(() => validateAtomicTempSettlementWorkloadResult({
      ...expected,
      workloadDetails: { ...expected.workloadDetails, payloadBytes: 1 },
    })).toThrow("workload details mismatch");
    expect(() => validateAtomicTempSettlementWorkloadResult({
      ...expected,
      fixturePlacement: "unknown",
    })).toThrow("fixture placement mismatch");
    expect(() => validateAtomicTempSettlementWorkloadResult({
      ...expected,
      skipped: "not run",
    })).toThrow("must execute rather than skip");
  });

  it("replaces the weak lifecycle/store rows and wires report validation", () => {
    const lifecycle = fs.readFileSync("benchmarks/lifecycle.mjs", "utf8");
    const core = fs.readFileSync("benchmarks/core.mjs", "utf8");
    const evidence = fs.readFileSync("benchmarks/measured-distribution.mjs", "utf8");
    expect(lifecycle).toContain("registerAtomicTempSettlementCoverage({");
    expect(lifecycle).not.toContain(
      'for (const name of ["replaceFileAtomic", "replaceFileAtomicSync"])',
    );
    expect(core).toContain('if (type === "FileStoreSync" && method === "write") continue;');
    expect(evidence).toContain("validateAtomicTempSettlementWorkloadResult(result);");
    expect(evidence).toContain("validateAtomicTempSettlementReport(report, plan.settings.filter);");
  });
});
