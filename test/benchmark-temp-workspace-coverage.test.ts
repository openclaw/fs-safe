import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  registerTempWorkspaceCoverage,
  TEMP_WORKSPACE_COVERAGE_NAMES,
  validateTempWorkspaceWorkloadResult,
} from "../benchmarks/temp-workspace-fixtures.mjs";

describe("temp-workspace benchmark coverage", () => {
  it("keeps the exact ordered ordinary, correction, and depth matrix", () => {
    expect(TEMP_WORKSPACE_COVERAGE_NAMES).toEqual([
      "tempWorkspace",
      "tempWorkspace/mode-correction",
      "tempWorkspace/existing-root/depth=4",
      "tempWorkspace/missing-root/depth=4",
      "tempWorkspace/existing-root/depth=8",
      "tempWorkspace/missing-root/depth=8",
      "tempWorkspace/existing-root/depth=32",
      "tempWorkspace/missing-root/depth=32",
      "tempWorkspaceSync",
      "tempWorkspaceSync/mode-correction",
      "tempWorkspaceSync/forced-mode-correction",
      "tempWorkspaceSync/existing-root/depth=4",
      "tempWorkspaceSync/missing-root/depth=4",
      "tempWorkspaceSync/existing-root/depth=8",
      "tempWorkspaceSync/missing-root/depth=8",
      "tempWorkspaceSync/existing-root/depth=32",
      "tempWorkspaceSync/missing-root/depth=32",
    ]);
    expect(new Set(TEMP_WORKSPACE_COVERAGE_NAMES).size).toBe(17);
    expect(TEMP_WORKSPACE_COVERAGE_NAMES.filter((name) => name.includes("tempWorkspace")))
      .toHaveLength(17);
  });

  it("records actual canonical depth and keeps setup and cleanup outside timing", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-temp-benchmark-contract-"));
    const rows: Array<{ name: string; options: Record<string, unknown> }> = [];
    const register = (name: string, _run: unknown, options: Record<string, unknown>) =>
      rows.push({ name, options });
    try {
      for (const suffix of ["", "Sync"]) {
        registerTempWorkspaceCoverage({
          api: {},
          workspace,
          register,
          tempOptions: { rootDir: workspace, prefix: "fixture" },
          suffix,
        });
      }
      expect(rows.map(({ name }) => name)).toEqual(TEMP_WORKSPACE_COVERAGE_NAMES);
      const depthRows = rows.filter(({ name }) => name.includes("-root/depth="));
      expect(depthRows).toHaveLength(12);
      for (const { name, options } of depthRows) {
        const requestedDepth = Number(name.match(/depth=(\d+)$/u)?.[1]);
        expect(options.before).toBeTypeOf("function");
        expect(options.after).toBeTypeOf("function");
        expect(options.workloadDetails).toMatchObject({
          requestedDepth,
          canonicalComponentCount: expect.any(Number),
        });
        expect((options.workloadDetails as { canonicalComponentCount: number })
          .canonicalComponentCount).toBeGreaterThan(requestedDepth);
      }
      expect(rows.find(({ name }) => name.endsWith("forced-mode-correction"))?.options.before)
        .toBeTypeOf("function");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("retains fail-safe umask restoration and final workspace verification", async () => {
    const source = await readFile("benchmarks/temp-workspace-fixtures.mjs", "utf8");
    expect(source.match(/reset\(\);/gu)).toHaveLength(2);
    expect(source).toContain("await verifyAndCleanup(created, 0o750)");
    expect(source).toContain('cleanupResult, "removed"');
    expect(source).toContain("fs.existsSync(workspace.dir)");
    expect(source).toContain("stat.mode & 0o7777, expectedMode");
    expect(source).toContain('typeof process.geteuid === "function"');
  });

  it("rejects missing or tampered canonical depth receipts", () => {
    const result = {
      name: "tempWorkspaceSync/missing-root/depth=32",
      workloadDetails: {
        rootLayout: "missing-root",
        requestedDepth: 32,
        canonicalComponentCount: 38,
      },
    };
    expect(() => validateTempWorkspaceWorkloadResult(result)).not.toThrow();
    expect(() => validateTempWorkspaceWorkloadResult({
      ...result,
      workloadDetails: { ...result.workloadDetails, canonicalComponentCount: 32 },
    })).toThrow("canonical component count mismatch");
  });
});
