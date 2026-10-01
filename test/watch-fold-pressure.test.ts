import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";
import { foldProof } from "../scripts/watch-fold-proof.mjs";

it.skipIf(process.env.FS_SAFE_TEST_WATCH_EVENTS !== "1")("folds missing TREE sibling pressure and discovers the missing descendant", async () => {
  const result = await foldProof({ root, watch });
  expect(result.overflows).toBe(0);
  expect(result.detected).toBe(true);
}, 30_000);
