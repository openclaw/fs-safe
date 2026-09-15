import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGuestFixture,
  GUEST_BENCHMARK_CASES,
  registerGuest,
  validateGuestBenchmarkReport,
} from "../benchmarks/guest.mjs";
import { GUEST_FILESYSTEM_PYTHON } from "../src/guest.js";

type Fixture = ReturnType<typeof createGuestFixture>;
type Row = {
  name: string;
  run: (fixture: Fixture) => unknown;
  options: {
    before: () => Fixture;
    after: (result: unknown, fixture: Fixture) => void;
    skip?: string;
    sync: boolean;
    covers: string[];
    workloadSemantics: string;
    workloadDetails: Record<string, unknown>;
  };
};

function registerRows(source = GUEST_FILESYSTEM_PYTHON, workspace = os.tmpdir()) {
  const rows: Row[] = [];
  const metadata = registerGuest({
    api: { GUEST_FILESYSTEM_PYTHON: source }, workspace,
    register: (name: string, run: Row["run"], options: Row["options"]) => rows.push({ name, run, options }),
  });
  return { rows, metadata };
}

function reportFixture() {
  const { rows, metadata } = registerRows();
  return {
    metadata: {
      platform: "linux",
      guest: {
        ...metadata,
        interpreter: {
          executable: "/usr/bin/python3", realPath: "/usr/bin/python3.12",
          version: "3.12.0", implementation: "cpython", platform: "linux", machine: "x86_64",
          directoryFlags: true, relativeDescriptors: true, sha256: "a".repeat(64),
          stat: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
          identityScope: "Executable bytes and stat identity; standard library and shared libraries are not content-hashed.",
        },
      },
    },
    results: rows.map(({ name, options }) => ({
      name, workloadSemantics: options.workloadSemantics, workloadDetails: options.workloadDetails,
      skipped: undefined as string | undefined,
    })),
  };
}

describe("guest benchmark contract", () => {
  it("keeps the exact ten equivalent existing/missing-parent workloads", () => {
    const { rows, metadata } = registerRows();
    expect(rows.map(({ name }) => name)).toEqual([
      "Guest.write/existing-parent", "Guest.write/missing-parent",
      "Guest.create/existing-parent", "Guest.create/missing-parent",
      "Guest.copy/existing-parent", "Guest.copy/missing-parent",
      "Guest.rename/existing-parent", "Guest.rename/missing-parent",
      "Guest.mkdirp/existing-parent", "Guest.mkdirp/missing-parent",
    ]);
    expect(GUEST_BENCHMARK_CASES.map(({ name }) => name)).toEqual(rows.map(({ name }) => name));
    expect(metadata.interpreter).toBeNull(); // Registration and unrelated filters never launch Python.
    for (const { options } of rows) {
      expect(options.sync).toBe(true);
      expect(options.before).toBeTypeOf("function");
      expect(options.after).toBeTypeOf("function");
      expect(options.covers).toEqual([]); // Guest source is not a Node Root method.
      expect(options.workloadSemantics).toBe("equivalent-output");
      expect(options.workloadDetails).toMatchObject({ parentDepth: 2, hostNativeModeAffectsGuest: false });
      expect(options.skip === undefined).toBe(["linux", "darwin"].includes(process.platform));
    }
  });

  it("hashes the measured API source and refuses a missing export", () => {
    const first = registerRows("measured build one").metadata;
    const second = registerRows("measured build two").metadata;
    expect(first.sourceSha256).toBe(createHash("sha256").update("measured build one").digest("hex"));
    expect(first.sourceSha256).not.toBe(second.sourceSha256);
    expect(() => registerRows("")).toThrow("measured build lacks guest Python source");
  });

  it("bounds both synchronous Python children with an unignorable kill signal", () => {
    const source = fs.readFileSync("benchmarks/guest.mjs", "utf8");
    expect(source.match(/spawnSync\(/gu)).toHaveLength(2);
    expect(source.match(/killSignal: "SIGKILL"/gu)).toHaveLength(2);
  });

  it("rejects missing/duplicate rows, source substitution, false skips, and changed semantics", () => {
    expect(() => validateGuestBenchmarkReport(reportFixture(), "Guest.")).not.toThrow();
    const missing = reportFixture();
    missing.results.pop();
    expect(() => validateGuestBenchmarkReport(missing, "Guest.")).toThrow("row set mismatch");
    const duplicate = reportFixture();
    duplicate.results[1] = duplicate.results[0]!;
    expect(() => validateGuestBenchmarkReport(duplicate, "Guest.")).toThrow("row set mismatch");
    const source = reportFixture();
    source.results[0]!.workloadDetails.sourceSha256 = "b".repeat(64);
    expect(() => validateGuestBenchmarkReport(source, "Guest.")).toThrow("workload receipt mismatch");
    const skipped = reportFixture();
    skipped.results[0]!.skipped = "Python missing";
    expect(() => validateGuestBenchmarkReport(skipped, "Guest.")).toThrow("platform skip mismatch");
    const semantics = reportFixture();
    semantics.results[0]!.workloadSemantics = "changed-output";
    expect(() => validateGuestBenchmarkReport(semantics, "Guest.")).toThrow("semantics mismatch");
    const interpreter = reportFixture();
    interpreter.metadata.guest.interpreter.sha256 = "missing";
    expect(() => validateGuestBenchmarkReport(interpreter, "Guest.")).toThrow();
  });

  it("records only unsupported-platform skips on Windows without an interpreter", () => {
    const report = reportFixture();
    const windows = {
      metadata: { platform: "win32", guest: { ...report.metadata.guest, interpreter: null } },
      results: report.results.map((row) => ({
        ...row, skipped: "Guest Python filesystem execution requires Linux or macOS.",
      })),
    };
    expect(() => validateGuestBenchmarkReport(windows, "Guest.")).not.toThrow();
    expect(() => validateGuestBenchmarkReport({
      ...windows, metadata: { ...windows.metadata, guest: report.metadata.guest },
    }, "Guest.")).toThrow("unsupported guest platform invoked Python");
  });

  it("selects exact partial families and rejects an absent requested family", () => {
    const report = reportFixture();
    report.results = report.results.filter(({ name }) => name.startsWith("Guest.copy/"));
    expect(() => validateGuestBenchmarkReport(report, "Guest.copy/")).not.toThrow();
    expect(() => validateGuestBenchmarkReport({ metadata: {}, results: [] }, "Guest."))
      .toThrow("row set mismatch");
  });

  it("creates fresh fixture directories and rejects unknown layouts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-guest-benchmark-contract-"));
    try {
      const first = createGuestFixture(root, "copy", "existing-parent");
      const second = createGuestFixture(root, "copy", "missing-parent");
      expect(first.directory).not.toBe(second.directory);
      expect(fs.existsSync(first.parentPath)).toBe(true);
      expect(fs.existsSync(second.parentPath)).toBe(false);
      expect(fs.readFileSync(path.join(first.directory, "source.txt"))).toHaveLength(1024);
      expect(() => createGuestFixture(root, "copy", "raced-parent")).toThrow("unknown guest benchmark parent layout");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!["linux", "darwin"].includes(process.platform))("guest benchmark execution", () => {
  it.each(GUEST_BENCHMARK_CASES)("checks real one-shot results and cleanup for $name", ({ name }) => {
    const { rows, metadata } = registerRows();
    const row = rows.find((entry) => entry.name === name)!;
    const fixture = row.options.before();
    let result;
    try {
      result = row.run(fixture);
    } finally {
      row.options.after(result, fixture);
    }
    expect(metadata.interpreter).not.toBeNull();
    expect(fs.existsSync(fixture.directory)).toBe(false);
  }, 75_000); // One interpreter probe and one child, each bounded by 30 seconds.

  it("rejects a successful child that does no guest work and still removes its fixture", () => {
    const { rows } = registerRows("pass");
    const row = rows.find(({ name }) => name === "Guest.mkdirp/missing-parent")!;
    const fixture = row.options.before();
    const result = row.run(fixture);
    expect(() => row.options.after(result, fixture)).toThrow();
    expect(fs.existsSync(fixture.directory)).toBe(false);
  }, 75_000);
});
