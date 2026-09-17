import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COPY_TREE_SUCCESS_NAMES,
  PROBE_TREE_SUCCESS_WORKLOAD,
  copyTreeSuccessDescriptors,
  copyTreeSuccessFixtureReceipt,
  probeTreeSuccessFixtureReceipt,
  registerCopyTreeSuccess,
  validateCopyTreeSuccessReport,
  validateCopyTreeSuccessWorkloadResult,
  validateProbeTreeSuccessReport,
  validateProbeTreeSuccessWorkloadResult,
} from "../benchmarks/copy-tree-success.mjs";
import { configureFsSafeNative } from "../src/config.js";
import { copyTree } from "../src/copy.js";

afterEach(() => configureFsSafeNative({ mode: "auto" }));

function measuredCopyRows(requestedIterations: number, nativeMode = "off") {
  return copyTreeSuccessDescriptors().map(row => ({
    name: row.name,
    workloadSemantics: row.workloadSemantics,
    workloadDetails: row.workloadDetails,
    fixturePlacement: copyTreeSuccessFixtureReceipt(row, { nativeMode }),
    iterations: Math.max(1, Math.floor(requestedIterations / row.divisor)),
    samplesUs: [1],
    minUs: 1,
    medianUs: 1,
    maxUs: 1,
  }));
}

function measuredProbeRow(requestedIterations: number, nativeMode = "off") {
  return {
    name: "probeTreeClone",
    workloadSemantics: "equivalent-output",
    workloadDetails: PROBE_TREE_SUCCESS_WORKLOAD,
    fixturePlacement: probeTreeSuccessFixtureReceipt(null, nativeMode),
    iterations: requestedIterations,
    samplesUs: [1],
    minUs: 1,
    medianUs: 1,
    maxUs: 1,
  };
}

describe("copyTree successful-settlement benchmark receipts", () => {
  it("freezes the four public nested and multichunk rows with portable receipt IDs", () => {
    expect(COPY_TREE_SUCCESS_NAMES).toEqual([
      "copyTree/settled-success/clone=never/many-small-nested",
      "copyTree/settled-success/clone=auto/many-small-nested",
      "copyTree/settled-success/clone=never/multichunk",
      "copyTree/settled-success/clone=auto/multichunk",
    ]);
    const rows = copyTreeSuccessDescriptors();
    expect(Object.isFrozen(rows)).toBe(true);
    for (const row of rows) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.workloadDetails)).toBe(true);
      expect(row.divisor).toBe(100);
      expect(row.workloadSemantics).toBe("equivalent-output");
      expect(row.workloadDetails.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.workloadDetails.verification).toContain("source-preservation");
      expect(row.workloadDetails.verification).toContain("windows-absolute-junction-spelling");
      expect(row.workloadDetails.linkPolicy).toContain("Windows directory junction");
      expect(row.workloadDetails.directories).toBe(5);
      if (row.shape === "many-small-nested") {
        expect(row.workloadDetails.files).toBe(32);
        expect(row.workloadDetails.largestFileBytes).toBe(4096);
      } else {
        expect(row.workloadDetails.files).toBe(2);
        expect(row.workloadDetails.largestFileBytes).toBe(2 * 1024 * 1024 + 17);
      }
    }
  });

  it("distinguishes forced portable execution from automatic capability evidence", () => {
    const [never, auto] = copyTreeSuccessDescriptors();
    expect(copyTreeSuccessFixtureReceipt(never, {
      cloneBackend: "xfs", nativeMode: "require",
    })).toMatchObject({
      probedCloneBackend: "xfs",
      executionPath: "portable-javascript-byte-copy",
      autoByteFallbackVerified: null,
    });
    expect(copyTreeSuccessFixtureReceipt(auto, { nativeMode: "off" })).toMatchObject({
      probedCloneBackend: null,
      executionPath: "portable-javascript-byte-copy",
      autoByteFallbackVerified: true,
    });
    for (const cloneBackend of [null, "xfs"]) {
      expect(copyTreeSuccessFixtureReceipt(auto, {
        cloneBackend, nativeMode: "require",
      })).toMatchObject({
        probedCloneBackend: cloneBackend,
        executionPath: "automatic-route-unverified",
        autoByteFallbackVerified: null,
      });
    }
  });

  it("runs genuine public clone=never and native-off auto calls with verification outside timing", async () => {
    configureFsSafeNative({ mode: "off" });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-copy-tree-benchmark-"));
    type Registration = {
      name: string;
      run: () => Promise<void>;
      options: {
        divisor: number;
        skip?: string;
        workloadDetails: object;
        fixturePlacement: { executionPath: string };
        before(): void;
        after(): void;
      };
    };
    const rows: Registration[] = [];
    try {
      await registerCopyTreeSuccess({
        api: {
          probeTreeClone: () => undefined,
          createCloneSource: async () => { throw new Error("unexpected clone source creation"); },
          copyTree,
        },
        workspace,
        binding: undefined,
        nativeMode: "off",
        register: (name: string, run: () => Promise<void>, options: Registration["options"]) => {
          rows.push({ name, run, options });
        },
      });
      expect(rows.map(({ name }) => name)).toEqual(COPY_TREE_SUCCESS_NAMES);
      for (const row of [rows[0]!, rows[3]!]) {
        expect(row.options.skip).toBeUndefined();
        expect(row.options.divisor).toBe(100);
        expect(row.options.fixturePlacement.executionPath).toBe("portable-javascript-byte-copy");
        row.options.before();
        await row.run();
        row.options.after();
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects missing, duplicate, skipped, mutated, mis-filtered, and mis-iterated copy rows", () => {
    const requestedIterations = 500;
    const rows = measuredCopyRows(requestedIterations);
    const report = { metadata: { mode: "off" }, results: rows };
    expect(() => validateCopyTreeSuccessReport(report, "", requestedIterations)).not.toThrow();
    expect(() => validateCopyTreeSuccessReport({ ...report, results: rows.slice(1) }, "", requestedIterations))
      .toThrow("row set mismatch");
    expect(() => validateCopyTreeSuccessReport({ ...report, results: [...rows, rows[0]!] }, "", requestedIterations))
      .toThrow("row set mismatch");
    expect(() => validateCopyTreeSuccessReport({
      ...report,
      results: [...rows, { ...rows[0]!, name: "copyTree/settled-success/unknown" }],
    }, "", requestedIterations)).toThrow("row set mismatch");
    const wrappedUnknown = {
      ...rows[0]!,
      name: "other/copyTree/settled-success/unknown",
    };
    expect(() => validateCopyTreeSuccessWorkloadResult(wrappedUnknown))
      .toThrow("Unknown copyTree success row");
    expect(() => validateCopyTreeSuccessReport({
      ...report,
      results: [...rows, wrappedUnknown],
    }, "copyTree/settled-success/", requestedIterations)).toThrow("row set mismatch");
    expect(() => validateCopyTreeSuccessReport({
      ...report,
      results: [...rows, { ...wrappedUnknown, skipped: "not run" }],
    }, "copyTree/settled-success/", requestedIterations)).toThrow("row set mismatch");
    expect(() => validateCopyTreeSuccessReport({
      ...report,
      results: rows.map((row, index) => index === 0 ? { ...row, skipped: "not run" } : row),
    }, "", requestedIterations)).toThrow("row was not measured");
    expect(() => validateCopyTreeSuccessReport({
      ...report,
      results: rows.map((row, index) => index === 0 ? {
        ...row,
        workloadDetails: { ...row.workloadDetails, files: 31 },
      } : row),
    }, "", requestedIterations)).toThrow("workload receipt mismatch");
    expect(() => validateCopyTreeSuccessReport({
      ...report,
      results: rows.map((row, index) => index === 0 ? {
        ...row,
        fixturePlacement: { ...row.fixturePlacement, autoByteFallbackVerified: true },
      } : row),
    }, "", requestedIterations)).toThrow("fixture receipt mismatch");
    expect(() => validateCopyTreeSuccessReport({
      ...report,
      results: rows.map((row, index) => index === 0 ? { ...row, iterations: 500 } : row),
    }, "", requestedIterations)).toThrow("iteration count mismatch");
    expect(() => validateCopyTreeSuccessReport({
      ...report,
      results: rows.map(row => ({
        ...row,
        fixturePlacement: { ...row.fixturePlacement, nativeMode: "require" },
      })),
    }, "", requestedIterations)).toThrow("report native mode mismatch");
    expect(() => validateCopyTreeSuccessReport({
      ...report,
      results: rows.map((row, index) => index === 1 ? {
        ...row,
        fixturePlacement: {
          ...row.fixturePlacement,
          executionPath: "portable-native-byte-copy",
        },
      } : row),
    }, "", requestedIterations)).toThrow("native-off execution path mismatch");

    const filter = COPY_TREE_SUCCESS_NAMES[0]!;
    expect(() => validateCopyTreeSuccessReport(
      { metadata: { mode: "off" }, results: [rows[0]!] },
      filter,
      requestedIterations,
    )).not.toThrow();
    expect(() => validateCopyTreeSuccessReport(
      { metadata: { mode: "off" }, results: rows.slice(0, 2) },
      filter,
      requestedIterations,
    )).toThrow("row set mismatch");
    expect(() => validateCopyTreeSuccessReport({ results: [] }, "unrelated", requestedIterations))
      .not.toThrow();
    expect(() => validateCopyTreeSuccessWorkloadResult({
      name: "copyTree/settled-success/clone=never/unknown",
    })).toThrow("Unknown copyTree success row");
  });

  it("admits the exact successful probe row and rejects changed close-settlement receipts", () => {
    const requestedIterations = 20;
    const row = measuredProbeRow(requestedIterations);
    const requiredRow = measuredProbeRow(requestedIterations, "require");
    expect(() => validateProbeTreeSuccessWorkloadResult(row)).not.toThrow();
    expect(requiredRow.fixturePlacement.executionPath).toBe("native-probe-parent-open-close");
    expect(() => validateProbeTreeSuccessWorkloadResult(requiredRow)).not.toThrow();
    expect(() => validateProbeTreeSuccessReport(
      { metadata: { mode: "off" }, results: [row] },
      "",
      requestedIterations,
    )).not.toThrow();
    expect(() => validateProbeTreeSuccessReport({ results: [] }, "", requestedIterations))
      .toThrow("row set mismatch");
    expect(() => validateProbeTreeSuccessReport({ results: [row, row] }, "", requestedIterations))
      .toThrow("row set mismatch");
    for (const name of [
      "probeTreeClone/unknown",
      "probeTreeClone-extra",
      "other/probeTreeClone",
    ]) {
      const unknown = { ...row, name };
      expect(() => validateProbeTreeSuccessWorkloadResult(unknown))
        .toThrow("Unknown probeTreeClone success row");
      expect(() => validateProbeTreeSuccessReport({
        results: [row, unknown],
      }, "probeTreeClone", requestedIterations)).toThrow("row set mismatch");
      expect(() => validateProbeTreeSuccessReport({
        results: [row, { ...unknown, skipped: "not run" }],
      }, "probeTreeClone", requestedIterations)).toThrow("row set mismatch");
    }
    expect(() => validateProbeTreeSuccessReport({
      results: [{ ...row, skipped: "not run" }],
    }, "", requestedIterations)).toThrow("row was not measured");
    expect(() => validateProbeTreeSuccessReport({
      results: [{ ...row, iterations: 1 }],
    }, "", requestedIterations)).toThrow("iteration count mismatch");
    expect(() => validateProbeTreeSuccessReport({
      metadata: { mode: "require" },
      results: [row],
    }, "", requestedIterations)).toThrow("report native mode mismatch");
    expect(() => validateProbeTreeSuccessWorkloadResult({
      ...row,
      fixturePlacement: { ...row.fixturePlacement, executionPath: "native-probe-parent-open-close" },
    })).toThrow("fixture receipt mismatch");
    expect(() => validateProbeTreeSuccessWorkloadResult({
      ...row,
      workloadDetails: { ...PROBE_TREE_SUCCESS_WORKLOAD, timedBoundary: "probe-only" },
    })).toThrow("workload receipt mismatch");
    expect(() => validateProbeTreeSuccessReport({ results: [] }, "copyTree", requestedIterations))
      .not.toThrow();
  });

  it("admits both receipt families in the runner and measured-distribution gate before emission", () => {
    const runner = fs.readFileSync("benchmarks/runner.mjs", "utf8").replaceAll("\r\n", "\n");
    const distribution = fs.readFileSync("benchmarks/measured-distribution.mjs", "utf8");
    const lifecycle = fs.readFileSync("benchmarks/lifecycle.mjs", "utf8");
    expect(lifecycle).toContain("await registerCopyTreeSuccess({");
    expect(lifecycle).toContain("fixturePlacement: probeTreeSuccessFixtureReceipt");
    expect(lifecycle).toContain("after: (backend) => assert.equal(backend, cloneBackend)");
    expect(distribution).toContain("validateProbeTreeSuccessWorkloadResult(result);");
    expect(distribution).toContain("validateCopyTreeSuccessWorkloadResult(result);");
    const probeAdmission = runner.indexOf("validateProbeTreeSuccessReport(completedReport");
    const copyAdmission = runner.indexOf("validateCopyTreeSuccessReport(completedReport");
    const completion = runner.indexOf("completionMessage =", probeAdmission);
    const emission = runner.indexOf("if (args.json) fs.writeFileSync");
    expect(probeAdmission).toBeGreaterThan(-1);
    expect(copyAdmission).toBeGreaterThan(probeAdmission);
    expect(copyAdmission).toBeLessThan(completion);
    expect(completion).toBeLessThan(emission);
  });

  it("freezes the serialized final-study cells, controls, and rejection thresholds", () => {
    const readme = fs.readFileSync("benchmarks/README.md", "utf8").replace(/\s+/g, " ");
    for (const text of [
      "exact filter `copyTree/settled-success/`",
      "native mode `off`, and `iterations=900`",
      "exact filter `probeTreeClone`",
      "native mode `require`, and `iterations=1000`",
      "Linux, macOS, and Windows with Node 22 and 24",
      "three blocks",
      "nine samples",
      "`order=abba` and `order=baab`",
      "separate same-source rebuilds",
      "one shared same-artifact build",
      "In every\ncomplete block",
      "greater than\n10% or 50 microseconds fails",
      "greater\nthan 20% or 100 microseconds",
      "A control failure blocks the source result",
      "in the pooled distribution",
      "No samples or rows are excluded or subtracted",
      "no\nselective reruns",
      "Every matrix job and selected row must\nfinish",
    ]) expect(readme).toContain(text.replace(/\s+/g, " "));
  });
});
