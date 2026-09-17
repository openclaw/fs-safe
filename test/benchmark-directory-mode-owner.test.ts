import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DIRECTORY_MODE_OWNER_BENCHMARK_NAME,
  registerDirectoryModeOwnerBenchmark,
  validateDirectoryModeOwnerWorkloadResult,
} from "../benchmarks/directory-mode-owner.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const workloadSemantics =
  "successful public directory-mode finalization through owner post-dispatch checks";
const workloadDetails = {
  sourceDirectoryMode: "0555",
  destinationLayout: "missing-empty-directory",
  ownerCheckCallbackSupplied: true,
  postDispatchCheck: true,
};

describe("directory-mode owner benchmark", () => {
  it("registers a checked successful public merge with setup and cleanup outside timing", async () => {
    const workspace = await tempRoot("fs-safe-mode-owner-benchmark-");
    const merge = vi.fn(async (params: {
      sourceDir: string;
      destinationDir: string;
      destinationRealDir: string;
    }) => {
      expect(params.destinationRealDir).toBe(params.destinationDir);
      const source = path.join(params.sourceDir, "nested");
      const destination = path.join(params.destinationDir, "nested");
      fs.mkdirSync(destination);
      if (process.platform !== "win32") fs.chmodSync(destination, fs.lstatSync(source).mode & 0o7777);
    });
    const rows: Array<{
      name: string;
      run: () => Promise<void>;
      options: {
        before: () => void;
        verify: () => void;
        after: () => void;
        workloadSemantics: string;
        workloadDetails: typeof workloadDetails;
      };
    }> = [];
    registerDirectoryModeOwnerBenchmark({
      api: { mergeExtractedTreeIntoDestination: merge },
      workspace,
      register: (name: string, run: () => Promise<void>, options: (typeof rows)[number]["options"]) => {
        rows.push({ name, run, options });
      },
    });

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      name: DIRECTORY_MODE_OWNER_BENCHMARK_NAME,
      options: { divisor: 10, workloadSemantics, workloadDetails },
    });
    row!.options.before();
    await row!.run();
    row!.options.verify();
    row!.options.after();
    expect(merge).toHaveBeenCalledOnce();
  });

  it("rejects tampered post-dispatch workload receipts", () => {
    const result = { name: DIRECTORY_MODE_OWNER_BENCHMARK_NAME, workloadSemantics, workloadDetails };
    expect(() => validateDirectoryModeOwnerWorkloadResult(result)).not.toThrow();
    expect(() => validateDirectoryModeOwnerWorkloadResult({
      ...result,
      workloadDetails: { ...workloadDetails, postDispatchCheck: false },
    })).toThrow("directory-mode owner workload details mismatch");
    expect(() => validateDirectoryModeOwnerWorkloadResult({
      ...result,
      workloadSemantics: "unbound",
    })).toThrow("directory-mode owner workload semantics mismatch");
  });

  it("wires registration and receipt validation into the method harness", async () => {
    const [archives, measured] = await Promise.all([
      readFile("benchmarks/archives.mjs", "utf8"),
      readFile("benchmarks/measured-distribution.mjs", "utf8"),
    ]);
    expect(archives).toContain("registerDirectoryModeOwnerBenchmark(context);");
    expect(measured).toContain("validateDirectoryModeOwnerWorkloadResult(result);");
  });
});
