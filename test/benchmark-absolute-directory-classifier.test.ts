import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABSOLUTE_DIRECTORY_CLASSIFIER_FILTER as filter,
  ABSOLUTE_DIRECTORY_CLASSIFIER_NAMES as names,
  registerAbsoluteDirectoryClassifier,
  validateAbsoluteDirectoryClassifierReport as validate,
  validateAbsoluteDirectoryClassifierReportSet as validateSet,
} from "../benchmarks/absolute-directory-classifier.mjs";
import { finalizeBenchmarkRun, finishBenchmarkInvocation } from "../benchmarks/runner-cleanup.mjs";
import { completeSyntheticBenchmarkResults } from "./helpers/benchmark-report.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function report() {
  return structuredClone({
    metadata: {
      node: "v24.0.0", platform: "linux", arch: "x64", cpu: "fixture CPU", osRelease: "fixture OS",
      workspaceFilesystem: { type: 1, blockSize: 4096 },
    },
    results: completeSyntheticBenchmarkResults(5, 20).filter(row => names.includes(row.name)),
  });
}

type Result = { ok: boolean; path: string };
type Row = {
  name: string;
  run: () => Promise<Result>;
  options: {
    before: () => void;
    after: (result: unknown) => Promise<void>;
    fixturePlacement: { generatedSuffixDepth: number; initialSuffixState: string };
  };
};

async function fixture(selected = filter) {
  const workspace = fs.realpathSync.native(await tempRoot("fs-safe-classifier-harness-"));
  const rows: Row[] = [];
  const cleanups: Array<() => void> = [];
  const calls: Array<{ target: string; options: { mode: number; scopeLabel: string } }> = [];
  // Synthetic controls exercise harness hooks; the separate qualification uses public exports.
  const ensure = vi.fn(async (target: string, options: { mode: number; scopeLabel: string }) => {
    calls.push({ target, options });
    fs.mkdirSync(target, { recursive: true, mode: options.mode });
    return { ok: true, path: target };
  });
  registerAbsoluteDirectoryClassifier({
    api: { ensureAbsoluteDirectory: ensure }, workspace, args: { filter: selected },
    register: (name: string, run: Row["run"], options: Row["options"]) => rows.push({ name, run, options }),
    onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
  });
  return { workspace, rows, cleanups, calls, ensure };
}

describe("absolute-directory classifier report admission", () => {
  it("accepts exact complete receipts and selected subsets", () => {
    expect(() => validate(report(), filter, 20, 5)).not.toThrow();
    const selected = report();
    selected.results = selected.results.filter(row => row.name.includes("state=missing"));
    expect(() => validate(selected, `${filter}state=missing`, 20, 5)).not.toThrow();
    expect(() => validate({ results: [] }, "unrelated", 20, 5)).not.toThrow();
    expect(() => validateSet([report(), report()], filter)).not.toThrow();
  });

  it("rejects missing, duplicate, skipped, extra and disguised rows", () => {
    const missing = report();
    missing.results.pop();
    const duplicate = report();
    duplicate.results.push(duplicate.results[0]!);
    const skipped = report();
    skipped.results[0]!.skipped = "unavailable";
    const extra = report();
    extra.results.push({ ...extra.results[0]!, name: "unrelated" });
    const unknown = report();
    unknown.results[0]!.name += "/unknown";
    const disguised = report();
    disguised.results[0]!.name = `other/${disguised.results[0]!.name}`;
    for (const invalid of [missing, duplicate, skipped, extra, unknown, disguised]) {
      expect(() => validate(invalid, filter, 20, 5)).toThrow();
    }
  });

  it("rejects changed iterations, samples and workload semantics", () => {
    for (const patch of [
      { iterations: 19 }, { samplesUs: [1, 2, 3, 4] }, { samplesUs: "12345" },
      { workloadSemantics: "unbound" }, { workloadDetails: {} },
    ]) {
      const invalid = report();
      Object.assign(invalid.results[0]!, patch);
      expect(() => validate(invalid, filter, 20, 5)).toThrow();
    }
  });

  it("rejects invalid placement and within-report layout drift", () => {
    for (const patch of [
      { storage: "elsewhere" }, { generatedSuffixDepth: 2 }, { initialSuffixState: "missing" },
      { canonicalParentDepth: 0 }, { canonicalParentDepth: 6 }, { umask: 0o7777 }, { umask: 0o077 },
      { filesystemType: "1" }, { filesystemType: 2 }, { filesystemBlockSize: 0 },
      { filesystemBlockSize: 8192 }, { unexpected: true },
    ]) {
      const invalid = report();
      Object.assign(invalid.results[0]!.fixturePlacement!, patch);
      expect(() => validate(invalid, filter, 20, 5)).toThrow();
    }
    const invalid = report();
    invalid.metadata.workspaceFilesystem.type = 2;
    expect(() => validate(invalid, filter, 20, 5)).toThrow();
  });

  it("rejects layout and environment drift between measurement processes", () => {
    for (const field of ["canonicalParentDepth", "umask", "filesystemType", "filesystemBlockSize"]) {
      const changed = report();
      for (const row of changed.results) {
        const receipt = row.fixturePlacement as Record<string, number>;
        receipt[field] += 1;
      }
      expect(() => validateSet([report(), changed], filter)).toThrow();
    }
    for (const field of ["node", "platform", "arch", "cpu", "osRelease"] as const) {
      const changed = report();
      changed.metadata[field] += " changed";
      expect(() => validateSet([report(), changed], filter)).toThrow("environment changed");
    }
  });

  it("rejects uniformly missing, empty or incorrectly typed environment observations", () => {
    for (const field of ["node", "platform", "arch", "cpu", "osRelease"]) {
      for (const value of [undefined, null, "", "   ", 24, [], {}]) {
        const invalid = report();
        if (value === undefined) Reflect.deleteProperty(invalid.metadata, field);
        else Object.assign(invalid.metadata, { [field]: value });
        expect(() => validate(invalid, filter, 20, 5)).toThrow(`environment ${field} missing or invalid`);
        expect(() => validateSet([invalid, structuredClone(invalid)], filter))
          .toThrow(`environment ${field} missing or invalid`);
      }
    }
    for (const value of [undefined, null, "", []]) {
      const invalid = { ...report(), metadata: value };
      expect(() => validate(invalid, filter, 20, 5)).toThrow("environment metadata missing");
      expect(() => validateSet([invalid, structuredClone(invalid)], filter))
        .toThrow("environment metadata missing");
    }
  });

  it("requires a complete typed workspace filesystem receipt in every report", () => {
    for (const value of [
      undefined, null, "", [], {}, { type: 1 }, { blockSize: 4096 },
      { type: null, blockSize: 4096 }, { type: "1", blockSize: 4096 },
      { type: 1.5, blockSize: 4096 }, { type: Number.NaN, blockSize: 4096 },
      { type: 1, blockSize: null }, { type: 1, blockSize: "4096" },
      { type: 1, blockSize: 0 }, { type: 1, blockSize: -1 }, { type: 1, blockSize: Infinity },
    ]) {
      const invalid = report();
      if (value === undefined) Reflect.deleteProperty(invalid.metadata, "workspaceFilesystem");
      else Object.assign(invalid.metadata, { workspaceFilesystem: value });
      expect(() => validate(invalid, filter, 20, 5)).toThrow("workspace filesystem");
      expect(() => validateSet([invalid, structuredClone(invalid)], filter)).toThrow("workspace filesystem");
    }
  });
});

describe("absolute-directory classifier invocation lifecycle", () => {
  it("admits and resets every synthetic invocation while retaining existing identities", async () => {
    const { rows, calls, cleanups, workspace } = await fixture();
    expect(rows.map(row => row.name)).toEqual(names);
    for (const row of rows) {
      for (let invocation = 0; invocation < 2; invocation += 1) {
        row.options.before();
        const result = await row.run();
        expect(calls.at(-1)!.options).toEqual({ mode: 0o700, scopeLabel: "classifier benchmark" });
        await row.options.after(result);
        const missing = row.options.fixturePlacement.initialSuffixState === "missing";
        expect(fs.existsSync(result.path)).toBe(!missing);
      }
    }
    expect(calls).toHaveLength(8);
    await finalizeBenchmarkRun({ workspace, cleanups });
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("does not allocate fixtures excluded by the filter", async () => {
    const { rows, cleanups, workspace } = await fixture("unrelated");
    expect(rows).toEqual([]);
    expect(cleanups).toEqual([]);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it("keeps cleanup registered if setup or before fails", async () => {
    const { rows, cleanups, workspace } = await fixture(`${filter}state=missing/depth=1`);
    const parent = path.join(workspace, "absolute-directory-classifier", "missing-1");
    fs.writeFileSync(path.join(parent, "unexpected"), "fixture");
    expect(() => rows[0]!.options.before()).toThrow("not empty");
    await finalizeBenchmarkRun({ workspace, cleanups });
    expect(fs.existsSync(workspace)).toBe(false);

    const other = fs.realpathSync.native(await tempRoot("fs-safe-classifier-setup-"));
    const callbacks: Array<() => void> = [];
    vi.spyOn(fs.realpathSync, "native").mockImplementationOnce(() => { throw new Error("setup failed"); });
    expect(() => registerAbsoluteDirectoryClassifier({
      api: {}, workspace: other, register: vi.fn(), onCleanup: (fn: () => void) => callbacks.push(fn),
    })).toThrow("setup failed");
    expect(callbacks).toHaveLength(1);
    callbacks[0]!();
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it("rejects changed parent and existing-directory identities before another call", async () => {
    const { rows, workspace } = await fixture(`${filter}state=existing/depth=1`);
    const parent = path.join(workspace, "absolute-directory-classifier", "existing-1");
    fs.renameSync(path.join(parent, "level-0"), path.join(parent, "original"));
    fs.mkdirSync(path.join(parent, "level-0"), { mode: 0o700 });
    expect(() => rows[0]!.options.before()).toThrow("identity or mode changed");
    fs.renameSync(parent, `${parent}-old`);
    fs.mkdirSync(parent, { mode: 0o700 });
    expect(() => rows[0]!.options.before()).toThrow("identity or mode changed");
  });

  it("validates timed-call outcomes and still resets on validation failure", async () => {
    const { rows, calls } = await fixture(`${filter}state=missing/depth=1`);
    const row = rows[0]!;
    row.options.before();
    await row.run();
    await expect(row.options.after({ ok: false })).rejects.toThrow("public result mismatch");
    expect(fs.existsSync(calls[0]!.target)).toBe(false);
    expect(() => row.options.before()).not.toThrow();
  });

  it("preserves validation and falsey cleanup failures alongside a falsey primary failure", async () => {
    const { rows } = await fixture(`${filter}state=missing/depth=1`);
    const row = rows[0]!;
    row.options.before();
    await row.run();
    const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => { throw undefined; });
    let caught: AggregateError | undefined;
    try {
      await finishBenchmarkInvocation([null], () => row.options.after({ ok: false }), "primary and cleanup failed");
    } catch (error) {
      caught = error as AggregateError;
    } finally {
      remove.mockRestore();
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught!.errors[0]).toBe(null);
    const afterFailure = caught!.errors[1] as AggregateError;
    expect(afterFailure).toBeInstanceOf(AggregateError);
    expect(afterFailure.errors[0]).toMatchObject({ message: expect.stringContaining("public result mismatch") });
    expect(afterFailure.errors[1]).toBe(undefined);
  });
});
