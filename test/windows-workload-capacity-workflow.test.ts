import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n?/gu, "\n");
const coverage = readFileSync(new URL("../.github/workflows/coverage.yml", import.meta.url), "utf8").replace(/\r\n?/gu, "\n");
function jobs(source: string): Record<string, string> {
  return Object.fromEntries([...source.slice(source.indexOf("jobs:\n")).matchAll(
    /^  ([a-z][a-z0-9-]*):\n((?: {4,}[^\n]*\n|\n)*)/gmu,
  )].map((match) => [match[1]!, match[2]!]));
}
const ciJobs = jobs(ci);
const coverageJobs = jobs(coverage);
type Context = { event?: string; workload?: string; standard?: boolean; package?: boolean; secure?: boolean;
  coverageProof?: boolean; node?: number; os?: string; cancelled?: boolean };
function evaluate(expression: string, context: Context = {}): any {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(/matrix\.no-openat2/gu, 'matrix["no-openat2"]'), {
    github: { event_name: context.event ?? "workflow_dispatch", ref: "refs/heads/qualification",
      event: { pull_request: {} } },
    inputs: { windows_workload_capacity_proof: context.workload ?? "none",
      windows_workload_standard_runner: context.standard ?? false,
      windows_package_capacity_proof: context.package ?? false,
      secure_file_credential_proof: context.secure ?? false,
      windows_capacity_proof: context.coverageProof ?? false,
      windows_standard_runner: context.standard ?? false },
    matrix: { os: context.os ?? "windows-latest", node: context.node ?? 24 },
    runner: { os: "Windows" }, fromJSON: JSON.parse,
    steps: { appcontainer: { outcome: "success" } },
    always: () => true, success: () => true, cancelled: () => context.cancelled ?? false,
    startsWith: (value: string, prefix: string) => value.startsWith(prefix),
  }, { timeout: 100 });
}
function field(job: string, key: string): string {
  return job.match(new RegExp(`^    ${key}: (.+)$`, "mu"))?.[1] ?? "true";
}
function axis(job: string, key: string, context: Context): any {
  return evaluate(job.match(new RegExp(`^        ${key}: (.+)$`, "mu"))![1]!, context);
}
function stepPlan(job: string, context: Context): string[] {
  return [...job.matchAll(/^      - name: ([^\n]+)\n([\s\S]*?)(?=^      - |(?![\s\S]))/gmu)]
    .filter((match) => !["Record exact-source workload admission", "Upload workload admission proof"].includes(match[1]!))
    .filter((match) => Boolean(evaluate(match[2]!.match(/^        if: (.+)$/mu)?.[1] ?? "true", context)))
    .map((match) => match[1]! + "\n" + [...match[2]!.matchAll(/^        (?:run|uses): (.+)$/gmu)].map((row) => row[1]).join("\n"));
}

describe("isolated Windows workload qualification", () => {
  it.each(["pull_request", "push", "workflow_dispatch"])("retains the normal %s runner and matrix contracts", (event) => {
    const context = { event, standard: true };
    expect(axis(ciJobs.check!, "os", context)).toEqual(["ubuntu-latest", "xcode-27", "windows-latest"]);
    expect(axis(ciJobs["native-check"]!, "include", context)).toEqual([
      { os: "ubuntu-latest" }, { os: "xcode-27" }, { os: "windows-latest" }, { os: "ubuntu-24.04-arm" },
      { os: "xcode-27", label: "xcode-27-x64", architecture: "x64" }, { os: "windows-2022" },
      { os: "linux-x64-no-openat2", runner: "ubuntu-latest", "no-openat2": true },
    ]);
    for (const job of [ciJobs.check!, ciJobs["native-check"]!, coverageJobs.coverage!]) {
      expect(evaluate(field(job, "runs-on"), context)).toBe("fs-safe-windows-16core");
      const floor = job.match(/minimum-logical-processors: (.+)$/mu)![1]!;
      expect(evaluate(floor, context)).toBe("16");
    }
    expect(evaluate(field(ciJobs["package-smoke"]!, "if"), context)).toBe(true);
    expect(evaluate(field(ciJobs["package-smoke"]!, "if"), { ...context, cancelled: true })).toBe(false);
  });

  it.each(["fallback", "native"])("selects only the complete %s workload and preserves its executed steps", (workload) => {
    const selected = workload === "fallback" ? "check" : "native-check";
    for (const standard of [false, true]) {
      const context = { workload, standard };
      expect(Object.entries(ciJobs).filter(([, job]) => Boolean(evaluate(field(job, "if"), context)))
        .map(([name]) => name).sort()).toEqual(["lint-workflows", selected].sort());
      expect(evaluate(field(ciJobs[selected]!, "runs-on"), context))
        .toBe(standard ? "windows-latest" : "fs-safe-windows-16core");
      expect(evaluate(ciJobs[selected]!.match(/minimum-logical-processors: (.+)$/mu)![1]!, context))
        .toBe(standard ? "4" : "16");
      if (workload === "fallback") expect(axis(ciJobs.check!, "os", context)).toEqual(["windows-latest"]);
      else expect(axis(ciJobs["native-check"]!, "include", context)).toEqual([{ os: "windows-latest" }]);
      for (const node of workload === "fallback" ? [22, 24, 26] : [24]) {
        expect(stepPlan(ciJobs[selected]!, { ...context, node }))
          .toEqual(stepPlan(ciJobs[selected]!, { event: "pull_request", node }));
      }
    }
    expect(ciJobs[selected]).toContain(`timeout-minutes: ${workload === "fallback" ? 20 : 30}`);
    expect(ciJobs[selected]).not.toContain("continue-on-error");
  });

  it("denies unknown or mixed workload requests instead of producing an empty green proof", () => {
    const code = ciJobs["lint-workflows"]!.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/u)![1]!
      .replace(/^\s*import assert[^\n]*\n/u, "");
    for (const [workload, pkg, secure, accepted] of [
      ["fallback", "false", "false", true], ["native", "false", "false", true],
      ["other", "false", "false", false], ["fallback", "true", "false", false],
      ["native", "false", "true", false],
    ] as const) {
      expect(Boolean(evaluate(field(ciJobs["lint-workflows"]!, "if"), { workload, package: pkg === "true" }))).toBe(true);
      const validate = () => runInNewContext(code, { assert, process: { env: {
        FS_SAFE_WORKLOAD: workload, FS_SAFE_PACKAGE_PROOF: pkg, FS_SAFE_CREDENTIAL_PROOF: secure,
      } } });
      if (accepted) expect(validate).not.toThrow();
      else expect(validate).toThrow();
    }
  });

  it("keeps independent coverage inputs, merged thresholds, deadlines, and Windows test concurrency", () => {
    expect(coverageJobs.coverage).toContain("- ubuntu-latest\n          - xcode-27\n          - windows-latest");
    expect(coverageJobs.coverage).toContain("timeout-minutes: ${{ matrix.os == 'windows-latest' && 20 || 15 }}");
    expect(coverageJobs.report).toContain("needs: coverage");
    expect(coverageJobs.report).toContain("run: pnpm test:coverage:merge");
    expect(coverageJobs.report).toContain("pattern: coverage-*");
    expect(coverageJobs.coverage).toContain("name: windows-coverage-admission");
    expect(coverageJobs["rust-coverage"]).toContain("run: bash scripts/native-coverage.sh");
    for (const standard of [false, true]) {
      const context = { coverageProof: true, standard };
      expect(evaluate(field(coverageJobs.coverage!, "runs-on"), context))
        .toBe(standard ? "windows-latest" : "fs-safe-windows-16core");
      expect(stepPlan(coverageJobs.coverage!, context))
        .toEqual(stepPlan(coverageJobs.coverage!, { event: "pull_request" }));
    }
    const config = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
    expect(config).toContain('maxWorkers: process.platform === "win32" || process.env.FS_SAFE_TEST_SERIAL === "1" ? 1 : 4');
    expect(config).toContain("requireAssertions: true");
  });
});
