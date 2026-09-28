import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { decode, encode, firstDifference, generate, shrinkSpec, validateSpec } from "../scripts/differential-root-model.mjs";
import { normalizeFixturePath, observeAddonLoads } from "../scripts/differential-root-worker.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const operation = { method: "readText", path: "file", options: {} };

it("normalizes Windows pathname separators before replacing the fixture prefix", () => {
  const directory = String.raw`C:\fixture\root`;
  for (const returned of [String.raw`C:\fixture\root\file`, "C:/fixture/root/file"]) {
    expect(normalizeFixturePath(returned, directory, "\\")).toBe("$ROOT/file");
  }
  expect(normalizeFixturePath("C:/fixture/root-other/file", directory, "\\")).toBe("C:/fixture/root-other/file");
});

it("does not count a failed addon load as a successful native execution", async () => {
  const directory = await tempRoot("fs-safe-differential-loader-");
  const observation = observeAddonLoads();
  try {
    expect(() => Reflect.apply(process.dlopen, process, [{ exports: {} }, path.join(directory, "missing.node")])).toThrow();
    expect(observation.attempts).toBe(1);
    expect(observation.loads).toEqual([]);
  } finally { observation.restore(); }
});

it("refuses to declare agreement with only one selected lane", () => {
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/differential-root.mjs", import.meta.url)),
    "--runtimes", "node", "--modes", "off", "--variants", "async", "--no-fallback",
  ], { encoding: "utf8", timeout: 10_000 });
  expect(child.status).toBe(2);
  expect(child.stderr).toContain("requires at least two lanes");
});

it("replays a fixed seed and preserves infinite budgets", () => {
  expect(encode(generate(9, 32))).toBe(encode(generate(9, 32)));
  expect(encode(generate(9, 32))).not.toBe(encode(generate(10, 32)));
  expect(decode(encode({ maxBytes: Infinity }))).toEqual({ maxBytes: Infinity });
  const literals = { maxBytes: Infinity, data: "$Infinity", path: "$ROOT/file", nested: { value: "$$literal" } };
  expect(decode(encode(literals))).toEqual(literals);
  for (const ci of [false, true]) expect(() => validateSpec(generate(9, 32, ci))).not.toThrow();
});

it.each(["../outside", "/outside", "C:/outside", "file/../outside", "dir\\file", "NUL", "dir/COM1.txt"])(
  "refuses replay pathname %s before a standalone helper can use it", pathname => {
    expect(() => validateSpec({ ops: [{ method: "atomic", path: pathname, data: "x" }] })).toThrow();
  },
);

it("does not let a replay override an atomic destination or filesystem adapter", () => {
  for (const options of [{ filePath: "/outside" }, { fileSystem: {} }, { content: "other" }]) {
    expect(() => validateSpec({ ops: [{ method: "atomic", path: "file", options }] })).toThrow();
  }
  expect(() => validateSpec({ ops: [{ method: "atomic", path: "." }] })).toThrow();
  expect(() => validateSpec({ ops: [{ method: "constructor", path: "." }] })).toThrow();
});

it("ignores standalone enumeration order while retaining semantic and tree differences", () => {
  const tree = [{ path: "file", kind: "file", content: "78", mode: 0o600 }];
  const left = { initial: [], results: [{ value: { scannedEntryCount: 2, truncated: false,
    entries: [{ relativePath: "b" }, { relativePath: "a" }], failedDirs: [] }, tree }], final: tree };
  const reordered = structuredClone(left);
  reordered.results[0]!.value.entries.reverse();
  expect(firstDifference(left, reordered)).toBeUndefined();
  const changed = structuredClone(left);
  changed.results[0]!.tree[0]!.content = "79";
  expect(firstDifference(left, changed)).toEqual({ phase: "operation", index: 0 });
  const mode = structuredClone(left);
  mode.final = [{ ...tree[0]!, mode: 0o644 }];
  expect(firstDifference(left, mode)).toEqual({ phase: "final" });
  const subset = structuredClone(left);
  subset.results[0]!.value.entries = [{ relativePath: "different" }];
  expect(firstDifference(left, subset)).toEqual({ phase: "operation", index: 0 });
  const error = { initial: [], results: [{ error: { name: "FsSafeError", code: "not-found", category: "operational" }, tree }], final: tree };
  expect(firstDifference(error, { ...error, results: [{ ...error.results[0], error: {
    name: "FsSafeError", code: "not-found", category: "policy",
  } }] })).toEqual({ phase: "operation", index: 0 });
});

it("shrinks a state-dependent failure without dropping its necessary preparation", () => {
  const spec = { ops: [{ ...operation, path: "noise" },
    { method: "write", path: "trigger", data: "x", options: { durable: false } },
    { ...operation, path: "trigger", options: { maxBytes: 100 } }, operation] };
  const fails = next => next.ops.some((op, i) => op.method === "write" && op.path === "trigger" &&
    next.ops.slice(i + 1).some(read => read.method === "readText" && read.path === "trigger"));
  const result = shrinkSpec(spec, fails);
  expect(result.spec.ops).toEqual([
    { method: "write", path: "trigger", data: "x", options: {} },
    { method: "readText", path: "trigger", options: {} },
  ]);
  expect(result.exhausted).toBe(false);
  const bounded = shrinkSpec(spec, () => false, 1);
  expect(bounded.attempts).toBe(1);
  expect(bounded.exhausted).toBe(true);
});

it("runs public sync/async workers and preserves literal returned text", async () => {
  const directory = await tempRoot("fs-safe-differential-cli-");
  const replay = path.join(directory, "replay.json");
  const payload = String.raw`a\b`;
  await fs.writeFile(replay, encode({ defaults: { durable: false }, ops: [
    { method: "write", path: "file", data: payload, options: {} }, operation,
    { method: "resolve", path: "file", options: {} },
  ] }));
  const output = path.join(directory, "receipts");
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/differential-root.mjs", import.meta.url)),
    "--runtimes", "node", "--modes", "off", "--no-fallback", "--replay", replay, "--out", output,
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr || child.stdout).toBe(0);
  const receipt = decode(await fs.readFile(path.join(output, "seed-1.json"), "utf8"));
  expect(receipt.reports).toHaveLength(2);
  for (const report of receipt.reports) {
    expect(report.loads).toEqual([]);
    expect(report.results[1].value).toBe(payload);
    expect(report.results[2].value).toBe("$ROOT/file");
  }
}, 40_000);
