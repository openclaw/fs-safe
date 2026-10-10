import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { decode, encode, firstDifference, generate, validateSpec } from "../../scripts/differential-root-model.mjs";
import { allowedDifferences, portableReport, portableScript, seeds } from "./corpus.mjs";
import { loadTestNative } from "../helpers/native-probe.js";
import { useRealTempDirs } from "../helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const native = loadTestNative("required-env");

it("keeps checked seeds deterministic, valid and inclusive of advanced operations", () => {
  for (const seed of seeds) {
    const spec = portableScript(seed);
    expect(encode(spec)).toBe(encode(portableScript(seed)));
    expect(validateSpec(spec)).toBe(spec);
    expect(validateSpec(generate(seed, 32))).toBeDefined();
    expect(spec.ops.map(op => op.method)).toEqual(expect.arrayContaining(["copySync", "copyBatch", "lock", "temp"]));
  }
});

it("allows Unicode and dot names without admitting traversal or Windows aliases", () => {
  for (const name of [".dot", "café", "cafe\u0301", "日本語", "x".repeat(180)]) {
    expect(() => validateSpec({ ops: [{ method: "copySync", path: name, source: "file" }] })).not.toThrow();
  }
  for (const name of ["../escape", "nested/../escape", "a:b", "a\\b", "a\0b", "CON.txt", "x/COM1", "COM¹", "x/LPT².txt", "x/"]) {
    expect(() => validateSpec({ ops: [{ method: "copyBatch", path: "copy", source: name }] })).toThrow();
  }
});

it("scopes representation allowances without hiding data, mode or hash changes", () => {
  expect(Object.values(allowedDifferences).every(reason => reason.length > 0)).toBe(true);
  const tree = [{ path: "cafe\u0301", kind: "file", mode: 0o600, nlink: 1, hash: "abc" }];
  const report = { initial: tree, results: [{ value: { name: "cafe\u0301", mode: 123 }, tree }], final: tree };
  const spec = { ops: [{ method: "readJson" }] };
  const windows = portableReport(report, spec, true);
  expect(windows.initial).toEqual([{ path: "café", kind: "file", nlink: 1, hash: "abc" }]);
  expect(windows.results[0].value).toEqual(report.results[0].value);
  const changed = structuredClone(windows);
  changed.final[0].hash = "different";
  expect(firstDifference(windows, changed)).toEqual({ phase: "final" });
  const posix = portableReport(report, spec);
  expect(posix.initial[0].mode).toBe(0o600);
  const link = { initial: [{ path: "link", kind: "symlink", mode: 0o777, target: "file" }], results: [], final: [] };
  expect(portableReport(link, { ops: [] }).initial[0]).toEqual({ path: "link", kind: "symlink", target: "file" });
  const copy = { initial: [], final: [], results: [{ operation: "copySync", value: { method: "clone", bytes: 3, hash: "abc", identityMatches: true } }] };
  expect(firstDifference(copy, { ...copy, results: [{ ...copy.results[0], value: { ...copy.results[0].value, method: "copy" } }] })).toBeUndefined();
  expect(firstDifference(copy, { ...copy, results: [{ ...copy.results[0], value: { ...copy.results[0].value, bytes: 4 } }] })).toEqual({ phase: "operation", index: 0 });
  const json = { ...copy, results: [{ ...copy.results[0], operation: "readJson" }] };
  expect(firstDifference(json, { ...json, results: [{ ...json.results[0], value: { ...json.results[0].value, method: "copy" } }] })).toEqual({ phase: "operation", index: 0 });
  const walk = { initial: [], final: [], results: [{ value: [{ path: "a" }, { path: "b" }] }] };
  const reversed = { ...walk, results: [{ value: [...walk.results[0].value].reverse() }] };
  const walkSpec = { ops: [{ method: "walk" }] };
  expect(firstDifference(portableReport(walk, walkSpec), portableReport(reversed, walkSpec))).toEqual({ phase: "operation", index: 0 });
});

it("replays the portable corpus through public APIs and saves every mode's receipts", async () => {
  const output = path.join(await tempRoot("fs-safe-corpus-"), "receipts");
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL("../../scripts/differential-root.mjs", import.meta.url)),
    "--portable", "--corpus", "--runtimes", "node", "--modes", native ? "require,auto,off" : "off",
    "--no-fallback", "--out", output,
  ], { encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr || child.stdout).toBe(0);
  const summary = decode(await fs.readFile(path.join(output, "summary.json"), "utf8"));
  expect(summary.status).toBe("passed");
  expect(summary.cases.map(item => item.seed)).toEqual(seeds);
  for (const seed of seeds) {
    const receipt = decode(await fs.readFile(path.join(output, `seed-${seed}.json`), "utf8"));
    for (const report of receipt.reports) {
      expect(report.results).toHaveLength(receipt.spec.ops.length);
      for (const [index, result] of report.results.entries()) {
        if (index === 4) expect(result.error).toMatchObject({ code: "already-exists" });
        else expect(result.error, `seed ${seed}, step ${index}: ${receipt.spec.ops[index].method}`).toBeUndefined();
      }
      expect(report.results[8].value).toMatchObject({ identityMatches: true });
      expect(report.results[16].value).toEqual(receipt.spec.ops[15].data);
      expect(report.results[17].value).toEqual({ held: true });
      expect(report.results[18].value.bytes).toBe(Buffer.from(`seed:${seed}\nλ😀`).toString("hex"));
    }
  }
}, 100_000);

it("checks POSIX permissions even when Windows receipts are listed first", async () => {
  const directory = await tempRoot("fs-safe-comparator-");
  const directories = [];
  for (const [platform, mode] of [["win32", undefined], ["linux", 0o600], ["darwin", 0o644]] as const) {
    const output = path.join(directory, platform);
    await fs.mkdir(output);
    directories.push(output);
    const tree = [{ path: "file", kind: "file", mode, hash: "same" }];
    await fs.writeFile(path.join(output, "summary.json"), encode({ platform, profile: "portable", status: "passed", cases: [{ seed: 1 }], lanes: [{}] }));
    await fs.writeFile(path.join(output, "seed-1.json"), encode({ spec: { ops: [{ method: "read" }] },
      reports: [{ platform, initial: tree, results: [{ value: "same", tree }], final: tree }] }));
  }
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./compare.mjs", import.meta.url)), ...directories], { encoding: "utf8", timeout: 10_000 });
  expect(child.error).toBeUndefined();
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain('"phase":"initial"');
});
