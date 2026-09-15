import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { measurementSequence } from "../benchmarks/method-audit-plan.mjs";

async function readWorkflow() {
  return (await readFile(".github/workflows/benchmarks.yml", "utf8"))
    .replaceAll("\r\n", "\n");
}

describe("benchmark workflow measurement order", () => {
  it("offers both balanced orders without changing the sequential default", async () => {
    const workflow = await readWorkflow();
    expect(workflow).toContain('options: ["baseline-candidate", "abba", "baab"]');
    expect(workflow).toContain('default: "baseline-candidate"');
    expect(workflow).toContain("method-audit-plan.json");
    expect(workflow).not.toContain("run_variant()");
  });

  it("keeps BAAB positions source-labelled and bound to the matching role", () => {
    expect(measurementSequence({ order: "baab", blocks: 1, hasBaseline: true }))
      .toMatchObject([
        { label: "block-1-candidate-a", role: "candidate", position: 1 },
        { label: "block-1-baseline-a", role: "baseline", position: 2 },
        { label: "block-1-baseline-b", role: "baseline", position: 3 },
        { label: "block-1-candidate-b", role: "candidate", position: 4 },
      ]);
  });
});
