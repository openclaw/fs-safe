import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, encode, firstDifference, generate, shrinkSpec, validateSpec } from "./differential-root-model.mjs";

const script = fileURLToPath(import.meta.url);
let values;
try { ({ values } = parseArgs({ options: {
  ci: { type: "boolean" }, help: { type: "boolean" },
  runtimes: { type: "string" }, modes: { type: "string" }, variants: { type: "string" },
  seed: { type: "string" }, seeds: { type: "string" }, length: { type: "string" },
  out: { type: "string" }, replay: { type: "string" }, shrink: { type: "boolean" },
  "shrink-budget": { type: "string" }, "no-fallback": { type: "boolean" },
  "stop-first": { type: "boolean" }, verbose: { type: "boolean" },
  worker: { type: "boolean" }, fixture: { type: "string" }, variant: { type: "string" },
} })); }
catch (error) { console.error(error); process.exit(2); }

function integer(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`expected integer in [${minimum}, ${maximum}]`);
  }
  return number;
}
function choices(value, defaults, allowed) {
  const selected = value === undefined ? defaults : value.split(",");
  assert.ok(selected.length > 0 && selected.every(item => allowed.includes(item)), `expected ${allowed.join(",")}`);
  assert.equal(new Set(selected).size, selected.length, "duplicate lane selection");
  return selected;
}

function run(spec, lane) {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-diff-"));
  try {
    // Root uses native canonicalization, which also expands Windows temp aliases.
    const fixture = fs.realpathSync.native(created);
    const child = spawnSync(lane.runtime, [script, "--worker", "--fixture", fixture, "--variant", lane.variant], {
      input: encode(spec), encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, FS_SAFE_NATIVE_MODE: lane.mode, FS_SAFE_TEST_NO_OPENAT2: lane.fallback ? "1" : "0" },
    });
    if (child.error || child.status !== 0) {
      throw new Error(`${lane.id}: worker failed: ${child.error ?? child.stderr}\n${child.stdout}`);
    }
    const result = decode(child.stdout);
    assert.equal(result.mode, lane.mode, "worker native mode");
    assert.equal(result.sync, lane.variant === "sync", "worker variant");
    assert.ok(result.runtime.startsWith(`${lane.runtime}-`), "worker runtime");
    assert.equal(lane.mode === "off", result.loads.length === 0, `${lane.id}: native loading was not proved`);
    if (lane.mode === "off") assert.equal(result.nativeAttempts, 0, "off must not attempt native loading");
    return result;
  } finally {
    // The supervisor owns cleanup even if a worker times out or crashes.
    fs.rmSync(created, { recursive: true, force: true });
  }
}

function signature(spec, left, right) {
  const difference = firstDifference(left, right);
  if (difference?.phase !== "operation") return undefined;
  return encode({ method: spec.ops[difference.index].method,
    left: left.results[difference.index]?.error ?? "success",
    right: right.results[difference.index]?.error ?? "success",
  });
}

async function main() {
  if (values.help) {
    console.log(`Usage: node scripts/differential-root.mjs [options]
  --ci                    One seed, 24 operations, explicit rejection policy
  --seed N --seeds N       First seed (default 1), count (default 16)
  --length N              Operations per sequence (default 32)
  --runtimes node,bun      Runtime executables on PATH
  --modes require,auto,off --variants async,sync
  --no-fallback           Omit Linux forced-openat fallback lanes
  --out DIR               Empty output directory (default artifacts-differential/<timestamp>)
  --replay FILE           Run one saved spec instead of generating sequences
  --shrink                Reduce divergences by deleting operations/options
  --shrink-budget N       Maximum candidate attempts per shrink (default 200)
  --stop-first --verbose
Exit 0: agreement; 1: divergence; 2: invalid input or worker/infrastructure failure.
The broad corpus deliberately includes documented legacy differences; inspect receipts.
Build dist and stage the native binding first. Workers never silently skip missing runtimes/addons.`);
    return;
  }
  if (values.worker) {
    assert.ok(values.fixture && path.basename(values.fixture).startsWith("fs-safe-diff-"));
    assert.deepEqual(fs.readdirSync(values.fixture), [], "worker fixture must be empty");
    assert.ok(["async", "sync"].includes(values.variant));
    const spec = validateSpec(decode(fs.readFileSync(0, "utf8")));
    const { worker } = await import("./differential-root-worker.mjs");
    console.log(encode(await worker(spec, values.fixture, values.variant === "sync")));
    return;
  }
  assert.ok(values.fixture === undefined && values.variant === undefined, "worker-only arguments");
  const runtimes = choices(values.runtimes, ["node", "bun"], ["node", "bun"]);
  const modes = choices(values.modes, ["require", "auto", "off"], ["require", "auto", "off"]);
  const variants = choices(values.variants, ["async", "sync"], ["async", "sync"]);
  const start = integer(values.seed, 1, 1, 0xffffffff);
  const count = integer(values.seeds, values.ci ? 1 : 16, 1, 1000);
  const length = integer(values.length, values.ci ? 24 : 32, 1, 1000);
  const shrinkBudget = integer(values["shrink-budget"], 200, 1, 1000);
  assert.ok(start + count - 1 <= 0xffffffff, "seed range exceeds uint32");
  const replay = values.replay ? validateSpec(decode(fs.readFileSync(values.replay, "utf8"))) : undefined;
  const lanes = [];
  for (const runtime of runtimes) for (const mode of modes) for (const variant of variants) {
    lanes.push({ id: `${runtime}-${mode}-${variant}`, runtime, mode, variant });
  }
  if (process.platform === "linux" && !values["no-fallback"] && modes.includes("require")) {
    for (const runtime of runtimes) for (const variant of variants) {
      lanes.push({ id: `${runtime}-openat-${variant}`, runtime, mode: "require", variant, fallback: true });
    }
  }
  assert.ok(lanes.length >= 2, "differential comparison requires at least two lanes");
  const out = path.resolve(values.out ?? path.join("artifacts-differential", new Date().toISOString().replaceAll(":", "-")));
  fs.mkdirSync(out, { recursive: true });
  assert.deepEqual(fs.readdirSync(out), [], "output directory must be empty to preserve prior evidence");
  const began = Date.now();
  const summary = { platform: process.platform, profile: values.ci ? "ci" : "broad", lanes, cases: [], divergences: [] };
  const write = (name, data) => fs.writeFileSync(path.join(out, name), encode(data));
  let completed = false;
  try {
    for (let seed = start; seed < start + (replay ? 1 : count); seed++) {
      const spec = replay ?? validateSpec(generate(seed, length, values.ci));
      const reports = lanes.map(lane => {
        if (values.verbose) console.log(encode({ running: lane.id, seed }));
        return run(spec, lane);
      });
      write(`seed-${seed}.json`, { spec, lanes, reports });
      for (let index = 1; index < lanes.length; index++) {
        const difference = firstDifference(reports[0], reports[index]);
        if (!difference) continue;
        const name = `divergence-${summary.divergences.length + 1}`;
        const detail = { name, seed, difference, left: lanes[0].id, right: lanes[index].id };
        summary.divergences.push(detail);
        write(`${name}.json`, { ...detail, spec, leftReport: reports[0], rightReport: reports[index] });
        console.log(encode(detail));
        if (values.shrink && difference.phase === "operation") {
          const originalSignature = signature(spec, reports[0], reports[index]);
          const reduced = shrinkSpec({ ...spec, ops: spec.ops.slice(0, difference.index + 1) }, next =>
            signature(next, run(next, lanes[0]), run(next, lanes[index])) === originalSignature, shrinkBudget);
          write(`${name}-replay.json`, reduced.spec);
          write(`${name}-minimal.json`, { ...reduced,
            left: run(reduced.spec, lanes[0]), right: run(reduced.spec, lanes[index]),
          });
          console.log(encode({ minimal: name, operations: reduced.spec.ops.length,
            attempts: reduced.attempts, budgetExhausted: reduced.exhausted }));
        }
      }
      summary.cases.push({ seed, operations: spec.ops.length, workers: lanes.length });
      write("summary.json", summary);
      console.log(encode({ seed, workers: lanes.length, divergences: summary.divergences.length }));
      if (summary.divergences.length && values["stop-first"]) break;
    }
    completed = true;
  } finally {
    summary.status = completed ? summary.divergences.length ? "diverged" : "passed" : "incomplete";
    summary.elapsedMs = Date.now() - began;
    write("summary.json", summary);
  }
  if (summary.divergences.length) process.exitCode = 1;
}

try { await main(); }
catch (error) { console.error(error); process.exitCode = 2; }
