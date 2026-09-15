import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readWorkflow() {
  return (await readFile(".github/workflows/benchmarks.yml", "utf8"))
    .replaceAll("\r\n", "\n");
}

function callsBetween(workflow: string, startMarker: string, endMarker: string) {
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return [...workflow.slice(start, end).matchAll(
    /^\s+run_variant "([^"]+)" "([^"]*)"$/gmu,
  )].map((match) => [match[1], match[2]]);
}

describe("benchmark workflow measurement order", () => {
  it("offers both balanced orders without changing the sequential default", async () => {
    const workflow = await readWorkflow();
    expect(workflow).toContain('options: ["baseline-candidate", "abba", "baab"]');
    expect(workflow).toContain('default: "baseline-candidate"');
    expect(workflow).toContain(
      'if [[ "$METHOD_ORDER" == "abba" || "$METHOD_ORDER" == "baab" ]]',
    );
    expect(workflow).toContain('echo "$order_label order requires compare_ref"');
    expect(workflow).toContain(
      'echo "$order_label order requires a focused method filter"',
    );
  });

  it("keeps BAAB positions source-labelled and bound to the matching build", async () => {
    const workflow = await readWorkflow();
    expect(callsBetween(
      workflow,
      '              if [[ "$METHOD_ORDER" == "baab" ]]; then',
      "              else",
    )).toEqual([
      ["block-$block-candidate-a", ""],
      ["block-$block-baseline-a", "$baseline_dist"],
      ["block-$block-baseline-b", "$baseline_dist"],
      ["block-$block-candidate-b", ""],
    ]);
    expect(callsBetween(
      workflow,
      "              else",
      "              fi",
    )).toEqual([
      ["block-$block-baseline-a", "$baseline_dist"],
      ["block-$block-candidate-a", ""],
      ["block-$block-candidate-b", ""],
      ["block-$block-baseline-b", "$baseline_dist"],
    ]);
  });
});
