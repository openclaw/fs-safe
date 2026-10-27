import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
  .replace(/\r\n?/gu, "\n");
const consumer = workflow.match(/^  package-smoke:\n((?: {4,}[^\n]*\n|\n)*)/mu)?.[1];
const producer = workflow.match(/^  package-smoke-build:\n((?: {4,}[^\n]*\n|\n)*)/mu)?.[1];
const runnerCheck = readFileSync(new URL("../.github/actions/verify-windows-ci-runner/action.yml", import.meta.url), "utf8")
  .replace(/\r\n?/gu, "\n");

describe("required package consumer proof", () => {
  it("preserves raw build and staged package bindings for both consumer paths", () => {
    expect(producer).toBeDefined();
    expect(producer).toContain("            native/*.node\n");
    expect(producer).toContain("            packages/*/fs-safe-native.node\n");
    expect(producer).toContain("            src/windows-security-helper.exe\n");
  });

  it("runs after a producer failure instead of silently skipping required checks", () => {
    expect(consumer).toBeDefined();
    expect(consumer).toMatch(/^    needs: package-smoke-build$/mu);
    // A status predicate overrides the implicit success() dependency gate.
    expect(consumer).toMatch(/^    if: \$\{\{ !cancelled\(\) \}\}$/mu);
    expect(consumer).not.toMatch(/^    continue-on-error:/mu);
    expect(consumer).toContain("name: Bundled package smoke (${{ matrix.os == 'xcode-27' && 'macos-15' || matrix.os }}, Node ${{ matrix.node }})");
    expect(consumer).toMatch(/        node:\n          - 22\n          - 24\n/u);
  });

  it("fails a missing artifact before any native or installed-package proof", () => {
    const download = consumer?.match(
      /      - name: Download exact-source package build\n([\s\S]*?)(?=      - name:)/u,
    )?.[1];
    expect(download).toBeDefined();
    expect(download).toContain("uses: actions/download-artifact@");
    expect(download).toContain("name: package-smoke-build-${{ matrix.os }}-${{ github.event.pull_request.head.sha || github.sha }}");
    expect(download).not.toMatch(/\n        (?:if|continue-on-error):/u);
    expect(consumer!.indexOf("Download exact-source package build"))
      .toBeLessThan(consumer!.indexOf("Prove platform capabilities"));
    expect(consumer!.indexOf("Download exact-source package build"))
      .toBeLessThan(consumer!.indexOf("run: pnpm package:smoke"));
  });

  it("keeps the smaller Windows admission at the artifact-fed consumer boundary", () => {
    expect(consumer).toContain("runs-on: ${{ matrix.os == 'windows-latest' && (matrix.capacity == 'control' && 'fs-safe-windows-16core' || 'windows-latest') || matrix.os }}");
    expect(consumer).toContain("minimum-logical-processors: ${{ matrix.capacity == 'control' && '16' || '4' }}");
    expect(consumer).not.toMatch(/run: pnpm (?:build|native:build)/u);
    expect(runnerCheck).toContain('default: "16"');
    expect(runnerCheck).toContain("FS_SAFE_MINIMUM_LOGICAL_PROCESSORS: ${{ inputs.minimum-logical-processors }}");
    expect(runnerCheck).toContain("[System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform");
    expect(runnerCheck).toContain("Get-CimInstance -ClassName Win32_ComputerSystem");
    expect(runnerCheck).toContain("-Windows $windows -Architecture $architecture -RunnerOS $env:FS_SAFE_RUNNER_OS -LogicalProcessors $logicalProcessors -MinimumLogicalProcessors $env:FS_SAFE_MINIMUM_LOGICAL_PROCESSORS");
    // Other workloads keep the original default and cannot inherit the consumer override.
    for (const job of [producer, workflow.match(/^  native-check:\n((?: {4,}[^\n]*\n|\n)*)/mu)?.[1]]) {
      expect(job).toContain("'fs-safe-windows-16core'");
      expect(job).toContain("uses: ./.github/actions/verify-windows-ci-runner");
      expect(job).not.toContain("minimum-logical-processors:");
    }
    expect(workflow.match(/minimum-logical-processors:/gu)).toHaveLength(1);
    for (const file of ["coverage", "mutation-policy-proof", "watch-stress", "compiler-qualification"]) {
      const sibling = readFileSync(new URL(`../.github/workflows/${file}.yml`, import.meta.url), "utf8");
      expect(sibling, file).toContain("'fs-safe-windows-16core'");
      expect(sibling, file).not.toContain("minimum-logical-processors:");
    }
  });

  it("makes the identical-artifact control opt-in without changing ordinary proof names", () => {
    expect(workflow).toMatch(/windows_package_capacity_proof:\n        description:[^\n]+\n        required: false\n        default: false\n        type: boolean/u);
    expect(consumer).toContain(`capacity: \${{ fromJSON(github.event_name == 'workflow_dispatch' && inputs.windows_package_capacity_proof && '["standard","control"]' || '["standard"]') }}`);
    expect(consumer).toContain("exclude:\n          - os: ubuntu-latest\n            capacity: control\n          - os: xcode-27\n            capacity: control");
    expect(consumer).toContain("})${{ matrix.capacity == 'control' && ' [16-core control]' || '' }}");
    expect(consumer).toContain("name: platform-package-proof-${{ runner.os }}-${{ runner.arch }}-node-${{ matrix.node }}${{ matrix.capacity == 'control' && '-16-core-control' || '' }}");
    expect(consumer).toContain("FS_SAFE_EXPECTED_SOURCE_COMMIT: ${{ github.event.pull_request.head.sha || github.sha }}");
    expect(consumer).toContain("FS_SAFE_NATIVE_MODE: require");
    expect(consumer).toContain("run: ./scripts/check-windows-native-imports.ps1");
    expect(consumer).toContain("run: pnpm test test/pipe.test.ts test/native-worker-fd-ownership.test.ts test/windows-native-fd-bridge.test.ts");
    expect(consumer).toContain("run: pnpm test test/root-file-open-batch-sync.test.ts");
    expect(consumer).toContain("run: pnpm test test/benchmark-windows-owner-caught-failure.test.ts");
    expect(consumer).not.toContain("continue-on-error");
  });
});
