import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
  .replace(/\r\n?/gu, "\n");
const consumer = workflow.match(/^  package-smoke:\n((?: {4,}[^\n]*\n|\n)*)/mu)?.[1];
const producer = workflow.match(/^  package-smoke-build:\n((?: {4,}[^\n]*\n|\n)*)/mu)?.[1];

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
    expect(consumer).toContain("name: Bundled package smoke (${{ matrix.os }}, Node ${{ matrix.node }})");
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
});
