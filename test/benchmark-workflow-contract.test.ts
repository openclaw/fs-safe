import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("benchmark workflow contract", () => {
  it("keeps raw dispatch values in the preflight job and uses fixed measured paths", async () => {
    const workflow = (await readFile(".github/workflows/benchmarks.yml", "utf8")).replaceAll("\r\n", "\n");
    const methodJobStart = workflow.indexOf("  method-audit:");
    const methodJobEnd = workflow.indexOf("  windows-native-pair:");
    const methodStepsStart = workflow.indexOf("    steps:", methodJobStart);
    const methodJob = workflow.slice(methodJobStart, methodJobEnd);
    const methodJobHeader = workflow.slice(methodJobStart, methodStepsStart);
    const prepareJob = workflow.slice(workflow.indexOf("  prepare_method_audit:"), workflow.indexOf("  method-audit:"));
    const evidenceDriver = await readFile("benchmarks/method-audit-evidence.mjs", "utf8");
    const runner = await readFile("benchmarks/runner.mjs", "utf8");
    const configureStepStart = methodJob.indexOf("      - name: Configure byte-exact checkouts");
    const downloadStepStart = methodJob.indexOf("      - name: Download resolved method-audit plan");
    const configureStep = methodJob.slice(configureStepStart, downloadStepStart);
    const planPathExport =
      "printf 'PLAN_PATH=%s/method-audit-plan/method-audit-plan.json\\n' " +
      '"$METHOD_RUNNER_TEMP" >> "$GITHUB_ENV"';
    const evidenceRootExport =
      "printf 'EVIDENCE_ROOT=%s/method-audit-evidence\\n' " +
      '"$METHOD_RUNNER_TEMP" >> "$GITHUB_ENV"';
    expect(workflow).toContain("timeout-minutes: 5");
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(methodJob).not.toContain("${{ inputs.");
    expect(methodJobHeader).not.toContain("${{ runner.");
    expect(methodJobHeader).not.toContain("PLAN_PATH:");
    expect(methodJobHeader).not.toContain("EVIDENCE_ROOT:");
    expect(configureStepStart).toBe(methodJob.indexOf("      - name:", methodJob.indexOf("    steps:")));
    expect(downloadStepStart).toBeGreaterThan(configureStepStart);
    expect(configureStep).toContain("METHOD_RUNNER_TEMP: ${{ runner.temp }}");
    expect(configureStep).toContain('if [[ -z "$METHOD_RUNNER_TEMP" ]]; then');
    expect(configureStep).toContain('echo "runner temp directory is unavailable" >&2');
    expect(configureStep).toContain("exit 2");
    expect(configureStep).toContain(planPathExport);
    expect(configureStep).toContain(evidenceRootExport);
    expect(configureStep.indexOf(planPathExport))
      .toBeLessThan(configureStep.indexOf("git config --global core.autocrlf false"));
    expect(configureStep.indexOf(evidenceRootExport))
      .toBeLessThan(configureStep.indexOf("git config --global core.autocrlf false"));
    expect(methodJob).toContain("path: ${{ runner.temp }}/method-audit-plan");
    expect(methodJob.indexOf('--plan "$PLAN_PATH"')).toBeGreaterThan(downloadStepStart);
    expect(methodJob.indexOf('mkdir -p "$EVIDENCE_ROOT"')).toBeGreaterThan(downloadStepStart);
    expect(prepareJob.indexOf("git config --global core.autocrlf false"))
      .toBeLessThan(prepareJob.indexOf("uses: actions/checkout@"));
    expect(methodJob.indexOf("git config --global core.autocrlf false"))
      .toBeLessThan(methodJob.indexOf("uses: actions/checkout@"));
    expect(evidenceDriver).toContain('distRoot: path.join(roots[build.checkout], "dist")');
    expect(evidenceDriver).toContain("exists before its benchmark process starts");
    expect(runner).toContain("fs.readdirSync(dist)");
    expect(runner).not.toContain("candidateDistHash");
    expect(methodJob).toContain("verify-harness");
    expect(methodJob).toContain("MSYS2_ARG_CONV_EXCL: \"*\"");
    expect(workflow).toContain('options: ["22", "24"]');
    expect(workflow).toContain('options: ["rebuild", "same-artifact"]');
    expect(workflow).toContain('options: ["45", "90", "120"]');
  });

  it("leaves the ordinary benchmark body unchanged behind the build-only guard", async () => {
    const workflow = (await readFile(".github/workflows/benchmarks.yml", "utf8")).replaceAll("\r\n", "\n");
    const expected = (await readFile("test/fixtures/benchmark-job.yml", "utf8")).replaceAll("\r\n", "\n");
    expect(workflow.slice(workflow.indexOf("  benchmark:")).replace(
      "    if: github.event_name != 'workflow_dispatch' || !inputs.build_only\n", "",
    )).toBe(expected);
  });

  it("isolates the fixed native pair from every timed job and always retains cleanup evidence", async () => {
    const workflow = (await readFile(".github/workflows/benchmarks.yml", "utf8")).replaceAll("\r\n", "\n");
    const job = (name: string) => {
      const start = workflow.indexOf(`  ${name}:\n`);
      expect(start).toBeGreaterThan(-1);
      const remaining = workflow.slice(start + 1);
      const next = remaining.search(/\n  [a-zA-Z0-9_-]+:\n/);
      return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
    };
    expect(job("prepare_method_audit")).toContain("inputs.method_audit && !inputs.build_only");
    expect(job("method-audit")).toContain("if: ${{ !inputs.build_only }}");
    expect(job("benchmark")).toContain("if: github.event_name != 'workflow_dispatch' || !inputs.build_only");
    const pair = job("windows-native-pair");
    expect(pair).toContain("if: github.event_name == 'workflow_dispatch' && inputs.build_only");
    expect(pair).toContain("runs-on: fs-safe-windows-16core");
    expect(pair).not.toContain("matrix:");
    expect(pair).not.toMatch(/pnpm benchmark|method-audit-evidence|benchmarks\/runner/);
    expect(pair).toContain("ref: b7beb3e429973ce023a7e78faccf5f58adbcc934");
    expect(pair).toContain("ref: f938c7ac9a5e755d78f72a41c26a57d662002bfd");
    expect(pair).toContain("$env:PAIR_EXPECTED_HARNESS_SHA -cne $env:PAIR_HARNESS_SHA");
    expect(pair).toContain("node-version: 24.21.0");
    expect(pair).toContain("rustup toolchain install 1.98.1 --profile minimal --no-self-update");
    expect(pair).toContain("Ensure owned VHD is dismounted and removed\n        if: always()");
    expect(pair).toContain("Upload native pair and receipts\n        if: always()");
    expect(pair).toContain("path: ${{ runner.temp }}/fs-safe-native-pair/artifacts/");
    expect(pair).not.toContain("path: ${{ runner.temp }}/fs-safe-native-pair/\n");
  });
});
