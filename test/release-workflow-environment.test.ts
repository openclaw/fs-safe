import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readReleaseWorkflow(): Promise<string> {
  return (await readFile(".github/workflows/release.yml", "utf8"))
    .replaceAll("\r\n", "\n");
}

function publishJob(workflow: string): string {
  const start = workflow.indexOf("\n  publish:\n");
  const end = workflow.indexOf("\n  release:\n", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("release workflow publishing authority", () => {
  it("gates the npm OIDC publisher through the reviewed environment", async () => {
    const workflow = await readReleaseWorkflow();
    const publish = publishJob(workflow);

    expect(publish).toMatch(/^    environment: npm-publish$/mu);
    expect(publish.match(/^      id-token: write$/gmu)).toHaveLength(1);
    expect(publish).toContain("    if: github.ref_protected\n");
    expect(publish).toContain("    needs: draft-release\n");
    expect(publish.indexOf("    environment: npm-publish\n"))
      .toBeLessThan(publish.indexOf("    steps:\n"));
    expect(workflow.match(/^    environment: npm-publish$/gmu)).toHaveLength(1);
  });
});
