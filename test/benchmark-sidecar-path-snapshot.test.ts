import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SIDECAR_PATH_SNAPSHOT_NAMES,
  preflightSidecarPathSnapshotCase,
  registerSidecarPathSnapshot,
  sidecarPathSnapshotCases,
  validateSidecarPathSnapshotReport,
  validateSidecarPathSnapshotWorkloadResult,
} from "../benchmarks/sidecar-path-snapshot.mjs";
import { finishBenchmarkInvocation } from "../benchmarks/runner-cleanup.mjs";

function sidecarTestWorkspace(prefix: string): string {
  const parent = process.platform === "win32" ? process.cwd() : os.tmpdir();
  return fs.mkdtempSync(path.join(parent, prefix));
}

describe("sidecar path snapshot benchmark", () => {
  it("freezes the eight rows and their exact output semantics and receipts", () => {
    expect(SIDECAR_PATH_SNAPSHOT_NAMES).toEqual([
      "SidecarPathSnapshot/default/absolute",
      "SidecarPathSnapshot/default/relative",
      "SidecarPathSnapshot/explicit/fully-qualified",
      "SidecarPathSnapshot/explicit/relative",
      "SidecarPathSnapshot/explicit/windows-current-drive-rooted",
      "SidecarPathSnapshot/explicit/windows-drive-relative",
      "SidecarPathSnapshot/reentrant/default-absolute",
      "SidecarPathSnapshot/reentrant/relative-explicit",
    ]);
    const rows = sidecarPathSnapshotCases({ platform: "linux", cwd: "/work", workspace: "/tmp/fixture" });
    expect(rows.map(({ name }) => name)).toEqual(SIDECAR_PATH_SNAPSHOT_NAMES);
    expect(rows.map(({ workloadSemantics }) => workloadSemantics)).toEqual([
      "equivalent-output", "equivalent-output", "equivalent-output", "changed-output",
      "changed-output", "changed-output", "equivalent-output", "changed-output",
    ]);
    for (const row of rows) {
      expect(() => validateSidecarPathSnapshotWorkloadResult(row)).not.toThrow();
      expect(row.workloadDetails.timedOperation).toBe("FileLockManager.acquire");
      expect(row.fixturePlacement).toEqual({ classification: "runner-workspace", sameDrive: null });
      expect(() => validateSidecarPathSnapshotWorkloadResult({ ...row, workloadSemantics: "unknown" }))
        .toThrow("workload semantics mismatch");
      expect(() => validateSidecarPathSnapshotWorkloadResult({ ...row, workloadDetails: {} }))
        .toThrow("workload details mismatch");
      expect(() => validateSidecarPathSnapshotWorkloadResult({ ...row, fixturePlacement: undefined }))
        .toThrow("fixture receipt is incomplete");
    }
    expect(() => validateSidecarPathSnapshotWorkloadResult({ name: "SidecarPathSnapshot/unknown" }))
      .toThrow("Unknown sidecar path snapshot row");
  });

  it("constructs genuine relative forms and skips unsafe Windows drive contexts", () => {
    const portable = sidecarPathSnapshotCases({ platform: "linux", cwd: "/work", workspace: "/tmp/fixture" });
    expect(portable.filter(({ skip }) => skip).map(({ name }) => name))
      .toEqual(SIDECAR_PATH_SNAPSHOT_NAMES.slice(4, 6));
    const windows = sidecarPathSnapshotCases({ platform: "win32", cwd: "c:\\work", workspace: "C:\\temp\\fixture" });
    expect(windows.every(({ skip }) => !skip)).toBe(true);
    expect(windows[4].lockPath).toBe("\\temp\\fixture\\row-4\\explicit.lock");
    expect(windows[5].lockPath).toBe("c:..\\temp\\fixture\\row-5\\explicit.lock");
    for (const row of [...portable.filter(({ skip }) => !skip), ...windows]) {
      const paths = row.expectedTargetPath.startsWith("/") ? path.posix : path.win32;
      const cwd = paths === path.posix ? "/work" : "c:\\work";
      expect(paths.relative(row.expectedTargetPath, paths.resolve(cwd, row.targetPath))).toBe("");
      if (row.lockPath !== undefined) {
        expect(paths.relative(row.expectedLockPath, paths.resolve(cwd, row.lockPath))).toBe("");
      }
      if (row.workloadDetails.targetPathForm === "relative") expect(paths.isAbsolute(row.targetPath)).toBe(false);
    }
    for (const [cwd, workspace] of [
      ["C:\\work", "D:\\temp\\fixture"],
      ["C:\\work", "\\\\server\\share\\fixture"],
      ["\\\\server\\share\\work", "C:\\temp\\fixture"],
      ["C:\\work", "\\\\?\\C:\\temp\\fixture"],
      ["\\work", "C:\\temp\\fixture"],
    ]) {
      const rows = sidecarPathSnapshotCases({ platform: "win32", cwd, workspace });
      expect(rows.filter(({ skip }) => !skip).map(({ name }) => name)).toEqual([
        SIDECAR_PATH_SNAPSHOT_NAMES[0], SIDECAR_PATH_SNAPSHOT_NAMES[2], SIDECAR_PATH_SNAPSHOT_NAMES[6],
      ]);
    }
  });

  it("preflights the host's implicit Windows drive-relative resolution", () => {
    const rows = sidecarPathSnapshotCases({
      platform: "win32",
      cwd: "C:\\work",
      workspace: "C:\\temp\\fixture",
    });
    const calls: string[][] = [];
    const matchingResolver = (...values: string[]) => {
      calls.push(values);
      return path.win32.resolve("C:\\work", values[0]);
    };
    for (const row of rows) {
      expect(preflightSidecarPathSnapshotCase(row, {
        paths: path.win32,
        resolvePath: matchingResolver,
      })).toBeUndefined();
    }
    expect(calls.every((values) => values.length === 1)).toBe(true);

    const mismatchedResolver = (...values: string[]) => values[0] === rows[5].lockPath
      ? "C:\\inherited-drive-cwd\\explicit.lock"
      : path.win32.resolve("C:\\work", values[0]);
    expect(preflightSidecarPathSnapshotCase(rows[5], {
      paths: path.win32,
      resolvePath: mismatchedResolver,
    })).toBe("The inherited drive working directory differs from process.cwd().");
    for (const row of rows.filter((_, index) => index !== 5)) {
      expect(preflightSidecarPathSnapshotCase(row, {
        paths: path.win32,
        resolvePath: mismatchedResolver,
      })).toBeUndefined();
    }
  });

  it("rejects incomplete, duplicate, and improperly skipped sidecar reports", () => {
    const rows = sidecarPathSnapshotCases({ platform: "linux", cwd: "/work", workspace: "/tmp/fixture" });
    const results = rows.map((row) => row.skip
      ? { ...row, skipped: row.skip }
      : { ...row, iterations: 1, samplesUs: [1], minUs: 1, medianUs: 1, maxUs: 1 });
    const portableReport = { metadata: { platform: "linux" }, results };
    expect(() => validateSidecarPathSnapshotReport(portableReport, "", 1)).not.toThrow();
    expect(() => validateSidecarPathSnapshotReport({
      ...portableReport,
      results: results.slice(0, -1),
    })).toThrow("report row set mismatch");
    expect(() => validateSidecarPathSnapshotReport({
      ...portableReport,
      results: [...results, results[0]],
    })).toThrow("report row set mismatch");
    expect(() => validateSidecarPathSnapshotReport({
      ...portableReport,
      results: results.map((result, index) => index === 0 ? { ...result, skipped: "arbitrary" } : result),
    })).toThrow("portable sidecar path snapshot row was not measured");
    expect(() => validateSidecarPathSnapshotReport({
      ...portableReport,
      results: results.map((result, index) => index === 0 ? { ...result, iterations: 2 } : result),
    }, "", 1)).toThrow("iteration count mismatch");
    expect(() => validateSidecarPathSnapshotReport({
      metadata: { platform: "linux" },
      results: results.filter(({ name }) => name.includes("default/relative")),
    }, "default/relative", 1)).not.toThrow();

    const windowsRows = sidecarPathSnapshotCases({
      platform: "win32",
      cwd: "C:\\work",
      workspace: "C:\\temp\\fixture",
    }).map((row) => ({
      ...row,
      iterations: 1,
      samplesUs: [1],
      minUs: 1,
      medianUs: 1,
      maxUs: 1,
    }));
    expect(() => validateSidecarPathSnapshotReport({
      metadata: { platform: "win32" },
      results: windowsRows,
    })).not.toThrow();
    expect(() => validateSidecarPathSnapshotReport({
      metadata: { platform: "win32" },
      results: windowsRows.map((result, index) => index === 5
        ? { ...result, skipped: "drive mismatch" } : result),
    })).toThrow("Windows sidecar path snapshot row was not measured");
    expect(() => validateSidecarPathSnapshotReport({
      metadata: { platform: "win32" },
      results: windowsRows.map((result) => ({
        ...result,
        fixturePlacement: { ...result.fixturePlacement, sameDrive: false },
      })),
    })).toThrow("not verified on the cwd drive");
  });

  it("keeps only acquisition timed and wires the existing runner and evidence validator", () => {
    const source = fs.readFileSync("benchmarks/sidecar-path-snapshot.mjs", "utf8");
    const lifecycle = fs.readFileSync("benchmarks/lifecycle.mjs", "utf8");
    const runner = fs.readFileSync("benchmarks/runner.mjs", "utf8");
    const runnerCleanup = fs.readFileSync("benchmarks/runner-cleanup.mjs", "utf8");
    const evidence = fs.readFileSync("benchmarks/measured-distribution.mjs", "utf8");
    expect(source).toContain("register(row.name, () => manager.acquire(targetPath, options), {");
    expect(source).not.toContain("process.chdir");
    expect(lifecycle).toContain("registerSidecarPathSnapshot({ api: a, workspace: w, register: add, onCleanup });");
    expect(evidence).toContain("validateSidecarPathSnapshotWorkloadResult(result);");
    expect(runner).toContain("fixturePlacement: c.fixturePlacement");
    const once = runner.slice(runner.indexOf("const once = async"), runner.indexOf("const samplesUs = []"));
    expect(once.indexOf("await c.before?.()")).toBeLessThan(once.indexOf("const start = performance.now()"));
    expect(once.indexOf("await c.run(input)")).toBeLessThan(once.indexOf("elapsed = performance.now() - start"));
    expect(once.indexOf("elapsed = performance.now() - start")).toBeLessThan(once.indexOf("c.verify?.(output)"));
    expect(once.indexOf("elapsed = performance.now() - start")).toBeLessThan(once.indexOf("finishBenchmarkInvocation("));
    expect(runner).toContain("await finalizeBenchmarkReport({");
    expect(runner.indexOf("validateReport: () => {")).toBeLessThan(runner.indexOf("reportPath: args.json"));
    expect(runnerCleanup.indexOf("await finalizeBenchmarkRun({"))
      .toBeLessThan(runnerCleanup.indexOf("fs.writeFileSync(reportPath"));
  });

  it("cleans allocations after setup failures and removes orphan artifacts before reporting them", async () => {
    const makeManager = () => ({
      drain: async () => {},
      heldEntries: () => [],
      acquire: async () => { throw new Error("unused"); },
    });
    for (const failAt of ["manager", "register"] as const) {
      const workspace = sidecarTestWorkspace(`.fs-safe-sidecar-${failAt}-`);
      let cleanup: () => Promise<void> = async () => {};
      const failure = new Error(`${failAt} failed`);
      try {
        expect(() => registerSidecarPathSnapshot({
          api: {
            createFileLockManager: () => {
              if (failAt === "manager") throw failure;
              return makeManager();
            },
          },
          workspace,
          register: () => { throw failure; },
          onCleanup: (fn: typeof cleanup) => { cleanup = fn; },
          preparePrivateDirectory: () => {},
        })).toThrow(failure);
        await cleanup();
        expect(fs.readdirSync(workspace)).toEqual([]);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    }

    const workspace = sidecarTestWorkspace(".fs-safe-sidecar-orphan-");
    let cleanup: () => Promise<void> = async () => {};
    try {
      registerSidecarPathSnapshot({
        api: { createFileLockManager: makeManager },
        workspace,
        register: () => {},
        onCleanup: (fn: typeof cleanup) => { cleanup = fn; },
        preparePrivateDirectory: () => {},
      });
      fs.writeFileSync(path.join(workspace, "sidecar-path-snapshot", "row-0", "orphan"), "orphan");
      await expect(cleanup()).rejects.toThrow("sidecar benchmark left a lock or reclaim file");
      expect(fs.readdirSync(workspace)).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports retained entries after attempting recovery and fixture removal", async () => {
    const workspace = sidecarTestWorkspace(".fs-safe-sidecar-retained-");
    let cleanup: () => Promise<void> = async () => {};
    let forceReleases = 0;
    const entries: Array<{ forceRelease: () => Promise<void> }> = [];
    entries.push({ forceRelease: async () => { forceReleases++; entries.length = 0; } });
    try {
      registerSidecarPathSnapshot({
        api: {
          createFileLockManager: () => ({
            acquire: async () => { throw new Error("unused"); },
            drain: async () => {},
            heldEntries: () => entries,
          }),
        },
        workspace,
        register: () => {},
        onCleanup: (fn: typeof cleanup) => { cleanup = fn; },
        preparePrivateDirectory: () => {},
      });
      await expect(cleanup()).rejects.toThrow("sidecar benchmark drain retained a lock");
      expect(forceReleases).toBe(1);
      expect(fs.readdirSync(workspace)).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves a drain failure after checking and removing every fixture directory", async () => {
    const workspace = sidecarTestWorkspace(".fs-safe-sidecar-drain-");
    let cleanup: () => Promise<void> = async () => {};
    const drainFailure = new Error("drain failed");
    try {
      registerSidecarPathSnapshot({
        api: {
          createFileLockManager: () => ({
            acquire: async () => { throw new Error("unused"); },
            drain: async () => { throw drainFailure; },
            heldEntries: () => [],
          }),
        },
        workspace,
        register: () => {},
        onCleanup: (fn: typeof cleanup) => { cleanup = fn; },
        preparePrivateDirectory: () => {},
      });
      await expect(cleanup()).rejects.toBe(drainFailure);
      expect(fs.readdirSync(workspace)).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reuses a manager, accepts baseline relative handles, releases inner before outer, and drains on failure", async () => {
    const workspace = sidecarTestWorkspace(".fs-safe-sidecar-benchmark-contract-");
    const events: string[] = [];
    const held = new Map<string, { lockPath: string; count: number }>();
    let managers = 0;
    let rejectNextInnerAcquire: Error | undefined;
    const rejectedReleases = new Map<string, Error>();
    const manager = {
      acquire: async (target: string, options: { lockPath?: string }) => {
        const normalizedTargetPath = path.resolve(target);
        const lockPath = options.lockPath ?? `${normalizedTargetPath}.lock`;
        let entry = held.get(normalizedTargetPath);
        const label = entry ? "inner" : "outer";
        events.push(`acquire:${label}`);
        if (label === "inner" && rejectNextInnerAcquire) {
          const failure = rejectNextInnerAcquire;
          rejectNextInnerAcquire = undefined;
          throw failure;
        }
        if (!entry) {
          fs.writeFileSync(lockPath, "held", { flag: "wx" });
          entry = { lockPath, count: 0 };
          held.set(normalizedTargetPath, entry);
        }
        entry.count++;
        return {
          lockPath,
          normalizedTargetPath,
          verifyStillHeld: async () => {
            events.push(`verify:${label}`);
            return held.has(normalizedTargetPath) && fs.existsSync(lockPath);
          },
          release: async () => {
            events.push(`release:${label}`);
            const failure = rejectedReleases.get(label);
            if (failure) throw failure;
            if (--entry.count === 0) {
              fs.unlinkSync(entry.lockPath);
              held.delete(normalizedTargetPath);
            }
          },
        };
      },
      heldEntries: () => [...held.values()],
      drain: async () => {
        events.push("drain");
        for (const entry of held.values()) fs.unlinkSync(entry.lockPath);
        held.clear();
      },
    };
    type Handle = Awaited<ReturnType<typeof manager.acquire>>;
    type Row = {
      name: string;
      run: () => Promise<Handle>;
      options: {
        covers: string[];
        skip?: string;
        before: () => Promise<Handle | undefined>;
        after: (handle?: Handle, outer?: Handle) => Promise<void>;
      };
    };
    const rows: Row[] = [];
    let cleanup: () => Promise<void> = async () => {};
    try {
      registerSidecarPathSnapshot({
        api: { createFileLockManager: () => { managers++; return manager; } },
        workspace,
        register: (name: string, run: Row["run"], options: Row["options"]) => rows.push({ name, run, options }),
        onCleanup: (fn: typeof cleanup) => { cleanup = fn; },
        preparePrivateDirectory: () => {},
      });
      expect(managers).toBe(1);
      expect(events).toEqual([]);
      for (const row of rows.filter(({ options }) => !options.skip)) {
        expect(row.options.covers).toEqual(["FileLockManager.acquire"]);
        for (let iteration = 0; iteration < 2; iteration++) {
          events.length = 0;
          const outer = await row.options.before();
          const setupEvents = [...events];
          const handle = await row.run();
          expect(events).toEqual([...setupEvents, outer ? "acquire:inner" : "acquire:outer"]);
          await row.options.after(handle, outer);
          expect(events.slice(setupEvents.length + 1)).toEqual(outer
            ? ["verify:inner", "release:inner", "verify:outer", "release:outer"]
            : ["verify:outer", "release:outer"]);
          expect(held.size).toBe(0);
        }
      }
      const row = rows.find(({ name }) => name === "SidecarPathSnapshot/reentrant/default-absolute")!;
      const outer = await row.options.before();
      const handle = await row.run();
      await expect(row.options.after({ ...handle, normalizedTargetPath: workspace }, outer)).rejects.toThrow();
      expect(held.size).toBe(0);

      events.length = 0;
      const acquisitionFailure = new Error("inner acquisition failed");
      const rejectedOuter = await row.options.before();
      rejectNextInnerAcquire = acquisitionFailure;
      const invocationFailures: unknown[] = [];
      let rejectedHandle: Handle | undefined;
      try {
        rejectedHandle = await row.run();
      } catch (error) {
        invocationFailures.push(error);
      }
      let combinedFailure: unknown;
      try {
        await finishBenchmarkInvocation(
          invocationFailures,
          () => row.options.after(rejectedHandle, rejectedOuter),
          "sidecar invocation failed",
        );
      } catch (error) {
        combinedFailure = error;
      }
      expect(combinedFailure).toBeInstanceOf(AggregateError);
      expect((combinedFailure as AggregateError).errors[0]).toBe(acquisitionFailure);
      expect(events).toContain("release:outer");
      expect(held.size).toBe(0);

      events.length = 0;
      const rejectedInnerRelease = new Error("inner release failed");
      const rejectedOuterRelease = new Error("outer release failed");
      const releaseOuter = await row.options.before();
      const releaseInner = await row.run();
      rejectedReleases.set("inner", rejectedInnerRelease);
      rejectedReleases.set("outer", rejectedOuterRelease);
      let releaseFailure: unknown;
      try {
        await row.options.after(releaseInner, releaseOuter);
      } catch (error) {
        releaseFailure = error;
      }
      rejectedReleases.clear();
      expect(releaseFailure).toBeInstanceOf(AggregateError);
      expect((releaseFailure as AggregateError).errors).toEqual(expect.arrayContaining([
        rejectedInnerRelease,
        rejectedOuterRelease,
      ]));
      expect(events).toContain("release:inner");
      expect(events).toContain("release:outer");
      await manager.drain();
      expect(held.size).toBe(0);

      // Runner cleanup must also drain a lock left by an interrupted invocation.
      await row.options.before();
      await row.run();
      await cleanup();
      expect(events.at(-1)).toBe("drain");
      expect(held.size).toBe(0);
      expect(fs.readdirSync(workspace)).toEqual([]);
      expect(managers).toBe(1);
    } finally {
      await manager.drain();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
