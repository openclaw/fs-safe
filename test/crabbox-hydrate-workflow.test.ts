import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Crabbox hydrate workflow", () => {
  it("sets up Node before pnpm without requesting an unavailable pnpm cache", async () => {
    const workflow = await readFile(".github/workflows/crabbox-hydrate.yml", "utf8");
    const setupNode = workflow.indexOf("uses: actions/setup-node@");
    const setupPnpm = workflow.indexOf("uses: pnpm/action-setup@");

    expect(setupNode).toBeGreaterThan(-1);
    expect(setupPnpm).toBeGreaterThan(setupNode);
    expect(workflow.slice(setupNode, setupPnpm)).not.toContain("cache: pnpm");
  });
});
