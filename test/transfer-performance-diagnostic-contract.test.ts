import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachPlanHash,
  createMethodAuditPlan,
  createRunnerArguments,
  validateDispatchInputs,
} from "../benchmarks/method-audit-plan.mjs";
import { measuredSourceBinding } from "../benchmarks/measured-distribution.mjs";
import {
  DIAGNOSTIC_FLAGS,
  DIAGNOSTIC_LIMITS,
  TRANSFER_ROWS,
  diagnosticArguments,
  selectDiagnosticReports,
  validateDiagnosticRows,
} from "../scripts/transfer-performance-diagnostic.mjs";

const H = "1".repeat(40);
const C = "2".repeat(40);
const B = "3".repeat(40);
const HASH = "a".repeat(64);
const source = (commit: string) => ({
  requestedRef: commit, matchedRef: null, commit, tree: commit,
  manifestHash: HASH, lockfileHash: HASH, filenameSourceBlob: commit,
  filenameSourceHash: HASH, filenameFallbackProfile: "legacy",
});
function planFor(overrides: Record<string, string> = {}) {
  const inputs = validateDispatchInputs({
    platform: "windows", candidate_ref: C, compare_ref: B,
    iterations: "50", samples: "9", filter: "copyFileHandle", order: "abba", blocks: "1",
    native_mode: "off", node_version: "24", expected_harness_sha: H, ...overrides,
  });
  return attachPlanHash(createMethodAuditPlan({
    inputs,
    harness: {
      workflowRef: "openclaw/fs-safe/.github/workflows/benchmarks.yml@refs/heads/main",
      sha: H, tree: H, workflowFileHash: HASH, benchmarkHash: HASH,
      manifestHash: HASH, lockfileHash: HASH,
    },
    candidate: source(C), baseline: source(inputs.compareRef),
    context: { repository: "openclaw/fs-safe", runId: "123", runAttempt: "1" },
  }));
}
const fileText = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");

describe("unscored hosted transfer diagnostics", () => {
  it("accepts only the bounded full-family profile and complete balanced orders", () => {
    expect(selectDiagnosticReports(planFor()).map(row => row.role)).toEqual(["baseline", "candidate", "candidate", "baseline"]);
    expect(selectDiagnosticReports(planFor({ order: "baab" })).map(row => row.role)).toEqual(["candidate", "baseline", "baseline", "candidate"]);
    const unsupported: Array<Record<string, string>> = [
      { platform: "linux" }, { native_mode: "require" }, { node_version: "22" },
      { iterations: "51" }, { samples: "10" }, { blocks: "2" },
      { filter: "copyFileHandle/observer" }, { order: "baseline-candidate" },
      { expected_harness_sha: "" },
    ];
    for (const override of unsupported) expect(() => selectDiagnosticReports(planFor(override))).toThrow();
    const valid = planFor();
    expect(() => selectDiagnosticReports({ ...valid, planHash: "0".repeat(64) })).toThrow();
    const { planHash: _hash, ...body } = valid;
    expect(() => selectDiagnosticReports(attachPlanHash({ ...body, reports: [...body.reports].reverse() }))).toThrow();
    expect(() => selectDiagnosticReports(attachPlanHash({ ...body, reports: body.reports.slice(1) }))).toThrow();
    expect(() => selectDiagnosticReports(attachPlanHash({
      ...body, sources: { ...body.sources, baseline: { ...body.sources.baseline, requestedRef: "main" } },
    }))).toThrow();
  });

  it("prepends only fixed diagnostic flags to the unchanged plan-bound runner arguments", () => {
    const plan = planFor();
    const report = selectDiagnosticReports(plan)[0];
    const roots = { harness: path.resolve("harness"), candidate: path.resolve("candidate"), baseline: path.resolve("baseline") };
    const directory = path.resolve("diagnostic-output", report.label);
    const args = diagnosticArguments(plan, report, roots, directory);
    const runnerFile = path.join(roots.harness, "benchmarks", "runner.mjs");
    expect(args.slice(0, DIAGNOSTIC_FLAGS.length)).toEqual(DIAGNOSTIC_FLAGS);
    expect(args.slice(args.indexOf(runnerFile))).toEqual(createRunnerArguments({
      runnerFile, distRoot: path.join(roots.baseline, "dist"), reportFile: path.join(directory, "report.json"),
      mode: "off", settings: plan.settings, measuredSource: measuredSourceBinding(plan, report),
    }));
    expect(args[args.indexOf("--warmup") + 1]).toBe("3");
    expect(args[args.indexOf("--filter") + 1]).toBe("copyFileHandle");
    expect(args).toContain(`--trace-event-file-pattern=${path.join(directory, "trace.${rotation}.json")}`);
    expect(args.some(arg => /heap|jitless|expose-gc|allow-natives|no-opt/u.test(arg))).toBe(false);
    const control = planFor({ control: "same-artifact", compare_ref: C });
    const controlReport = selectDiagnosticReports(control)[0];
    const controlArgs = diagnosticArguments(control, controlReport, roots, directory);
    expect(controlArgs[controlArgs.indexOf("--dist") + 1]).toBe(path.join(roots.candidate, "dist"));
    expect(controlArgs[controlArgs.indexOf("--measured-source-commit") + 1]).toBe(C);
  });

  it("requires all eleven rows, original call counts, and nine finite samples", () => {
    const report = () => ({ results: TRANSFER_ROWS.map((name: string, index: number) => ({
      name, iterations: index < 3 ? 50 : 5, samplesUs: [1, 9, 1, 1, 1, 1, 1, 1, 1],
    })) });
    expect(validateDiagnosticRows(report())).toBe(2);
    const missing = report();
    missing.results.pop();
    expect(() => validateDiagnosticRows(missing)).toThrow();
    const reordered = report();
    reordered.results.reverse();
    expect(() => validateDiagnosticRows(reordered)).toThrow();
    const calls = report();
    calls.results[5]!.iterations = 50;
    expect(() => validateDiagnosticRows(calls)).toThrow();
    for (const samples of [[1], [1, NaN, 1, 1, 1, 1, 1, 1, 1], new Array<number>(9)]) {
      const invalid = report();
      invalid.results[5]!.samplesUs = samples;
      expect(() => validateDiagnosticRows(invalid)).toThrow();
    }
  });

  it("keeps the ordinary workflow and scored reports separate from diagnostic publication", () => {
    const workflow = fileText("../.github/workflows/benchmarks.yml");
    const launcher = fileText("../scripts/transfer-performance-diagnostic.mjs");
    expect(workflow).toMatch(/transfer_diagnostics:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/u);
    expect(workflow.indexOf("Collect unscored transfer diagnostics")).toBeGreaterThan(workflow.indexOf("Upload method measurements"));
    expect(workflow).toContain("if: success() && inputs.transfer_diagnostics");
    expect(workflow).toContain("steps.transfer_diagnostics.outcome != 'skipped'");
    expect(workflow).toContain("unscored-transfer-diagnostics-${{ matrix.platform }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(workflow).toContain("transfer-performance-diagnostics/receipt.json");
    expect(launcher).toContain('schema: "fs-safe-transfer-diagnostics-v1", scored: false');
    expect(launcher).toContain('receipt.status = "collected"');
    expect(launcher).toContain('receipt.status = "failed"');
    expect(launcher).toContain('"NODE_OPTIONS", "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE"');
    expect(launcher).not.toMatch(/process\.env\.(NODE_OPTIONS|NODE_V8_COVERAGE|NODE_COMPILE_CACHE)\s*=/u);
    expect(launcher).not.toContain("createReportEvidence");
    expect(launcher).toContain("assertStableSnapshots(study.after, before)");
    expect(launcher).toContain("assertStableSnapshots(before, after)");
    expect(launcher).toContain("validateCompleteReportSet(plan, scored, study.before, study.after)");
    expect(launcher).toContain('"scored-runtime-drift"');
    expect(launcher).toContain('assertStableReportReceipt("Node executable"');
    expect(launcher).toContain('spawn(process.execPath, args, {');
    expect(launcher).toContain('"/PID", String(child.pid), "/T", "/F"');
    expect(DIAGNOSTIC_LIMITS).toMatchObject({ childMs: 180_000, totalMs: 900_000, terminationMs: 10_000 });
    expect(DIAGNOSTIC_LIMITS.logBytes).toBeLessThan(DIAGNOSTIC_LIMITS.fileBytes);
    expect(DIAGNOSTIC_LIMITS.fileBytes).toBeLessThan(DIAGNOSTIC_LIMITS.totalBytes);
  });
});
