#!/usr/bin/env node
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import fc from "fast-check";
import { root } from "../../dist/root.js";
import { watch } from "../../dist/watch.js";
import { sequences } from "./model-operations.mjs";
import { runSequence } from "./model.mjs";
import { runTransitions, recordNativeLoss } from "./model-transitions.mjs";
import { __setFsSafeTestHooksForTest } from "../../dist/test-hooks.js";

const { values } = parseArgs({ options: {
  seed: { type: "string", default: "1" }, seeds: { type: "string", default: "2000" },
  mode: { type: "string", default: "both" }, concurrency: { type: "string", default: "4" },
  steps: { type: "string", default: "32" }, settle: { type: "string", default: "40" },
  output: { type: "string", default: "watch-model-results.json" }, replay: { type: "string" },
  transitions: { type: "boolean", default: false }, "native-only": { type: "boolean", default: false },
} });
function integer(name, minimum) {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid --${name}`);
  return value;
}
const firstSeed = integer("seed", 0), count = integer("seeds", 1), concurrency = integer("concurrency", 1);
const steps = integer("steps", 1), settleMs = integer("settle", 0);
const modes = values.mode === "both" ? ["poll", "events"] : [values.mode];
if (values.transitions) {
  process.env.NODE_ENV = "test";
  __setFsSafeTestHooksForTest({ afterWatchBackendOverflow: recordNativeLoss });
}
if (modes.some(mode => !["poll", "events"].includes(mode))) throw new Error("invalid --mode");
if (values.replay) {
  const failure = JSON.parse(await fs.readFile(values.replay, "utf8"));
  await runSequence({ root, watch }, failure.operations, { mode: failure.mode, settleMs });
  console.log("replay passed");
} else {
  const summary = { platform: process.platform, node: process.version, firstSeed, count, steps, settleMs, concurrency, completed: { poll: 0, events: 0 }, operations: { poll: {}, events: {} }, checkpoints: 0, invalidations: 0, failures: [] };
  let next = 0, failed = false;
  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= count * modes.length) return;
      const mode = modes[index % modes.length], seed = firstSeed + Math.floor(index / modes.length);
      let proof, generated;
      if (values.transitions) {
        try {
          const transition = await runTransitions({ root, watch }, seed, { mode, nativeOnly: values["native-only"] });
          (summary.transitions ??= []).push({ seed, mode, ...transition });
        } catch (error) {
          failed = true;
          const failure = { seed, mode, phase: "transitions", error: String(error.stack), cause: String(error.cause?.stack ?? "") };
          summary.failures.push(failure); console.error(JSON.stringify(failure)); return;
        }
      }
      const property = fc.asyncProperty(sequences(0, steps), async operations => {
        generated = operations;
        proof = await runSequence({ root, watch }, operations, { mode, settleMs });
      });
      const result = await fc.check(property, { seed, numRuns: 1 });
      if (result.failed) {
        failed = true;
        const failure = { seed, mode, path: result.counterexamplePath, shrinks: result.numShrinks, operations: result.counterexample?.[0], error: String(result.errorInstance?.stack ?? result.errorInstance), cause: String(result.errorInstance?.cause?.stack ?? "") };
        failure.artifact = `${values.output}.${mode}-${seed}.failure.json`;
        summary.failures.push(failure);
        await fs.writeFile(failure.artifact, JSON.stringify(failure, null, 2));
        console.error(JSON.stringify(failure));
      } else {
        summary.completed[mode]++;
        summary.checkpoints += proof.checkpoints;
        summary.invalidations += proof.invalidations;
        for (const operation of generated) summary.operations[mode][operation.kind] = (summary.operations[mode][operation.kind] ?? 0) + 1;
        if ((summary.completed.poll + summary.completed.events) % 100 === 0) console.log(JSON.stringify({ completed: summary.completed, seconds: (Date.now() - started) / 1000 }));
      }
    }
  }));
  summary.seconds = (Date.now() - started) / 1000;
  await fs.writeFile(values.output, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (summary.failures.length) process.exitCode = 1;
}
