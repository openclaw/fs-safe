import { expect, it } from "vitest";
import fs from "node:fs/promises";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";
import { runTransitions } from "../scripts/watch-stress/model-transitions.mjs";

it("checks missing trees, exclusions, directory lifecycle, and another subscription with a tiny budget", async () => {
  await expect(runTransitions({ root, watch }, 7, { mode: "poll" })).resolves.toMatchObject({ maxPendingPaths: 2, overflows: 0 });
}, 30_000);

it("joins both closes and removes the fixture without losing the transition failure", async () => {
  let directory = "", closes = 0;
  const closeFailure = new Error("injected close failure");
  const observedRoot: typeof root = async (name, defaults) => { directory = name; return root(name, defaults); };
  const faultyWatch: typeof watch = (capability, options) => {
    const owner = watch(capability, { ...options, onInvalidate(event) { if (!event.changes) options.onInvalidate(event); } });
    return { ...owner, async close() { await owner.close(); if (++closes === 1) throw closeFailure; } };
  };
  const error = await runTransitions({ root: observedRoot, watch: faultyWatch }, 7, { mode: "poll" })
    .then(() => undefined, error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors[0].message).toContain("lost invalidation");
  expect(error.errors).toContain(closeFailure);
  expect(closes).toBe(2);
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("rejects a cache whose selected creation notification is lost", async () => {
  const dropChanges: typeof watch = (capability, options) => watch(capability, {
    ...options,
    onInvalidate(event) { if (!event.changes) options.onInvalidate(event); },
  });
  await expect(runTransitions({ root, watch: dropChanges }, 7, { mode: "poll" }))
    .rejects.toThrow("lost invalidation: missing descendant plus sibling churn");
}, 30_000);
