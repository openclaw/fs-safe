import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  registerTempWorkspaceCoverage,
  registerTempWorkspaceFallbackCleanup,
  TEMP_WORKSPACE_COVERAGE_NAMES,
  TEMP_WORKSPACE_FALLBACK_CLEANUP_NAMES,
  validateTempWorkspaceWorkloadResult,
} from "../benchmarks/temp-workspace-fixtures.mjs";

type CleanupOutcome = "removed" | "missing" | "identity-mismatch" | "indeterminate";
type BenchmarkWorkspace = {
  readonly dir: string;
  cleanup(): CleanupOutcome | Promise<CleanupOutcome>;
};
type FallbackCleanupOptions = Record<string, unknown> & {
  before(): BenchmarkWorkspace | Promise<BenchmarkWorkspace>;
  after(result: unknown, workspace: BenchmarkWorkspace): unknown;
};
type FallbackCleanupRow = {
  readonly name: string;
  readonly run: (workspace: BenchmarkWorkspace) => unknown;
  readonly options: FallbackCleanupOptions;
};

function benchmarkWorkspace(params: {
  readonly asynchronous: boolean;
  readonly prefix: string;
  readonly removePath: boolean;
  readonly root: string;
  readonly seedEntry: boolean;
  readonly status: CleanupOutcome;
}): BenchmarkWorkspace {
  const dir = fs.mkdtempSync(path.join(params.root, params.prefix));
  if (params.seedEntry) fs.writeFileSync(path.join(dir, "unexpected"), "entry");
  const cleanup = () => {
    if (params.removePath) fs.rmSync(dir, { recursive: true, force: true });
    return params.status;
  };
  return {
    dir,
    cleanup: params.asynchronous ? async () => cleanup() : cleanup,
  };
}

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

  it("registers and enforces successful compatible-fallback cleanup rows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-temp-cleanup-benchmark-"));
    const rows: FallbackCleanupRow[] = [];
    let status: CleanupOutcome = "removed";
    let removePath = true;
    let seedEntry = false;
    const create = (asynchronous: boolean) => benchmarkWorkspace({
      asynchronous,
      prefix: asynchronous ? "async-" : "sync-",
      removePath,
      root,
      seedEntry,
      status,
    });
    const api = {
      tempWorkspace: async () => create(true),
      tempWorkspaceSync: () => create(false),
    };
    const register = (
      name: string,
      run: FallbackCleanupRow["run"],
      options: FallbackCleanupOptions,
    ) => {
      rows.push({ name, run, options });
    };
    try {
      for (const suffix of ["", "Sync"]) {
        registerTempWorkspaceFallbackCleanup({
          api,
          nativeMode: "off",
          register,
          suffix,
          tempOptions: { rootDir: "fixture", prefix: "workspace-" },
        });
      }

      const names = rows.map(({ name }) => name);
      expect(names).toEqual(TEMP_WORKSPACE_FALLBACK_CLEANUP_NAMES);
      expect(names.filter((name) => name.includes("cleanup/compatible-js-fallback")))
        .toEqual(TEMP_WORKSPACE_FALLBACK_CLEANUP_NAMES);
      for (const row of rows) {
        const { name, options } = row;
        expect(options.before).toBeTypeOf("function");
        expect(options.after).toBeTypeOf("function");
        expect(options.skip).toBeUndefined();
        expect(options.sync).toBe(name.startsWith("TempWorkspaceSync"));
        expect(options.workloadSemantics)
          .toBe("temp-workspace-compatible-js-fallback-success-v1");
        expect(options.workloadDetails).toEqual({
          cleanupSafety: "compatible",
          nativeMode: "off",
          expectedRoute: "javascript-recursive-rm",
          workspaceEntries: 0,
        });
        expect(() => validateTempWorkspaceWorkloadResult({
          name,
          workloadSemantics: options.workloadSemantics,
          workloadDetails: options.workloadDetails,
        })).not.toThrow();

        const workspace = await options.before();
        const result = await row.run(workspace);
        expect(() => options.after(result, workspace)).not.toThrow();
        expect(fs.existsSync(workspace.dir)).toBe(false);
      }

      for (status of ["missing", "identity-mismatch", "indeterminate"] as const) {
        removePath = true;
        for (const row of rows) {
          const workspace = await row.options.before();
          const result = await row.run(workspace);
          expect(() => row.options.after(result, workspace))
            .toThrow("compatible-fallback cleanup did not remove its workspace");
        }
      }

      status = "removed";
      removePath = false;
      for (const row of rows) {
        const workspace = await row.options.before();
        const result = await row.run(workspace);
        expect(() => row.options.after(result, workspace))
          .toThrow("compatible-fallback cleanup left its public path");
        fs.rmSync(workspace.dir, { recursive: true, force: true });
      }

      removePath = true;
      seedEntry = true;
      await expect(rows[0]!.options.before()).rejects
        .toThrow("compatible-fallback cleanup fixture is not empty");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("rejects a tampered compatible-fallback cleanup receipt", () => {
    const result = {
      name: "TempWorkspace.cleanup/compatible-js-fallback",
      workloadSemantics: "temp-workspace-compatible-js-fallback-success-v1",
      workloadDetails: {
        cleanupSafety: "compatible",
        nativeMode: "off",
        expectedRoute: "javascript-recursive-rm",
        workspaceEntries: 0,
      },
    };
    expect(() => validateTempWorkspaceWorkloadResult(result)).not.toThrow();
    expect(() => validateTempWorkspaceWorkloadResult({
      ...result,
      workloadDetails: { ...result.workloadDetails, nativeMode: "auto" },
    })).toThrow("native mode mismatch");
  });
});
