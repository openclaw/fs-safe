import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import {
  LOCK_OWNERSHIP_PARSING_CASES,
  registerLockOwnershipParsing,
  validateLockOwnershipParsingReport,
} from "../benchmarks/lock-ownership-parsing.mjs";
import { finishBenchmarkInvocation } from "../benchmarks/runner-cleanup.mjs";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => configureFsSafeNative({ mode: "auto" }));

type Row = {
  name: string;
  run(input: unknown): unknown;
  before(): Promise<unknown>;
  after(result: unknown): Promise<void>;
  workloadSemantics: string;
  workloadDetails: unknown;
  fixturePlacement: string;
};

async function fixture() {
  configureFsSafeNative({ mode: "off" });
  const workspace = await tempRoot("fs-safe-lock-benchmark-");
  const rows: Row[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  registerLockOwnershipParsing({
    api: { acquireFileLock, acquireFileLockSync, root }, workspace,
    register: (name: string, run: Row["run"], options: Omit<Row, "name" | "run">) => {
      rows.push({ name, run, ...options });
    },
    onCleanup: (cleanup: () => Promise<void>) => cleanups.push(cleanup),
  });
  return { workspace, rows, cleanup: async () => {
    for (const cleanup of cleanups.toReversed()) await cleanup();
  } };
}

it("exercises all lock ownership benchmark fixtures through the real public methods", async () => {
  const f = await fixture();
  try {
    expect(f.rows).toHaveLength(96);
    for (const row of f.rows) {
      const input = await row.before();
      const failures: unknown[] = [];
      let result: unknown;
      try { result = await row.run(input); } catch (error) { failures.push(error); }
      await finishBenchmarkInvocation(failures, () => row.after(result), row.name);
    }
  } finally { await f.cleanup(); }
  expect(fs.readdirSync(f.workspace)).toEqual([]);
}, 30_000);

it("does not let successful cleanup conceal a failed public verification", async () => {
  const f = await fixture();
  try {
    const row = f.rows[0]!;
    await row.before();
    await expect(row.after(false)).rejects.toThrow("owned lock verification did not succeed");
  } finally { await f.cleanup(); }
  expect(fs.readdirSync(f.workspace)).toEqual([]);
});

it("binds selected reports to complete rows, byte budgets, parser behavior, and iteration counts", async () => {
  const f = await fixture();
  const requestedIterations = 500;
  try {
    const results = f.rows.map(row => ({
      name: row.name, workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails, fixturePlacement: row.fixturePlacement,
      iterations: 5,
    }));
    expect(() => validateLockOwnershipParsingReport({ results }, "ownership-parsing", requestedIterations)).not.toThrow();
    expect(() => validateLockOwnershipParsingReport({ results: results.slice(1) }, "ownership-parsing", requestedIterations)).toThrow();
    expect(() => validateLockOwnershipParsingReport({ results: [...results, results[0]] }, "ownership-parsing", requestedIterations)).toThrow();
    const filter = "verifyStillHeld/ownership-parsing/default/raw/near-cap/records";
    const filtered = results.filter(row => row.name.includes(filter));
    expect(filtered).toHaveLength(2);
    expect(() => validateLockOwnershipParsingReport({ results: filtered }, filter, requestedIterations)).not.toThrow();
    for (const replacement of [
      { skipped: "fixture unavailable" },
      { iterations: 6 },
      { workloadDetails: { jsonBytes: 0 } },
      { fixturePlacement: "different filesystem" },
    ]) {
      expect(() => validateLockOwnershipParsingReport({
        results: [{ ...filtered[0], ...replacement }, filtered[1]],
      }, filter, requestedIterations)).toThrow();
    }
    expect(new Set(LOCK_OWNERSHIP_PARSING_CASES.map(row => row.workloadDetails.sidecarBytes)))
      .toEqual(new Set([266, 65_674, 1_048_575]));
  } finally { await f.cleanup(); }
});
