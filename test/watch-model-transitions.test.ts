import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";
import { runTransitions } from "../scripts/watch-stress/model-transitions.mjs";

it("checks missing trees, exclusions, directory lifecycle, and another subscription with a tiny budget", async () => {
  await expect(runTransitions({ root, watch }, 7, { mode: "poll" })).resolves.toMatchObject({ maxPendingPaths: 2, overflows: 0 });
}, 30_000);

it("rejects a cache whose selected creation notification is lost", async () => {
  const dropChanges: typeof watch = (capability, options) => watch(capability, {
    ...options,
    onInvalidate(event) { if (!event.changes) options.onInvalidate(event); },
  });
  await expect(runTransitions({ root, watch: dropChanges }, 7, { mode: "poll" }))
    .rejects.toThrow("lost invalidation: missing descendant plus sibling churn");
}, 30_000);
