import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";
import { ancestorProof } from "../scripts/watch-ancestor-proof.mjs";

it.skipIf(process.platform !== "darwin" || process.env.FS_SAFE_TEST_WATCH_EVENTS !== "1")
  .each(["events", "poll"] as const)("keeps ancestor entry scopes quiet under deep churn (%s)", async mode => {
    const result = await ancestorProof({ root, watch }, { mode });
    expect(result.overflows).toBe(0);
    expect(result.phases).toContain("symlink attribute after re-arm");
  }, 60_000);
