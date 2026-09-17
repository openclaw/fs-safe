import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NativeBinding } from "../src/native-binding.js";
import {
  WINDOWS_OWNER_CAUGHT_FAILURE_CONTROL_DIVISOR,
  WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
  WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE,
  WINDOWS_OWNER_CAUGHT_FAILURE_NAMES,
  WINDOWS_OWNER_CAUGHT_FAILURE_RECEIPT,
  registerWindowsOwnerCaughtFailure,
  validateWindowsOwnerCaughtFailureReport,
  validateWindowsOwnerCaughtFailureResult,
  windowsOwnerCaughtFailureDivisor,
  windowsOwnerCaughtFailureIterations,
} from "../benchmarks/windows-owner-caught-failure.mjs";
import { finalizeBenchmarkReport } from "../benchmarks/runner-cleanup.mjs";
import { applyBenchmarkPrivateWindowsAcl } from "../benchmarks/windows-private-directory.mjs";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
  getFsSafeNativeConfig,
} from "../src/native-config.js";
import { __loadBundledNativeForTest } from "../src/native.js";
import { PermissionCommandError } from "../src/permission-exec.js";
import {
  createIcaclsResetCommand,
  inspectPathPermissions,
  inspectWindowsAcl,
} from "../src/permissions.js";

let realNative: NativeBinding | undefined;
if (process.platform === "win32") {
  const nativeRequired = getFsSafeNativeConfig().mode === "require";
  try {
    realNative = __loadBundledNativeForTest();
  } catch (error) {
    if (nativeRequired) throw error;
  }
  if (nativeRequired && typeof realNative?.readOwnerAndDacl !== "function") {
    throw new Error("Required native binding lacks readOwnerAndDacl; rebuild the helper");
  }
}
const nativeWindowsOwnerSupported = typeof realNative?.readOwnerAndDacl === "function";
const itNativeWindowsOwner = it.runIf(
  process.platform === "win32" && nativeWindowsOwnerSupported,
);

type BenchmarkOptions = {
  divisor: number;
  before: () => void;
  after: (result: unknown) => void;
  workloadSemantics: string;
  workloadDetails: Record<string, unknown>;
  fixturePlacement: Record<string, unknown>;
};

function permissionResult(source: "posix" | "windows-acl") {
  return {
    ok: true,
    source,
    worldWritable: false,
    groupWritable: false,
    worldReadable: false,
    groupReadable: false,
  };
}

async function inspectPermissionFixture(
  _target: string,
  options?: { platform?: string; exec?: (command: string, args: string[]) => Promise<unknown> },
) {
  if (options?.platform === "win32") {
    await options.exec?.("powershell.exe", []);
    return {
      ...permissionResult("windows-acl"),
      ownerSid: "s-1-5-21-42",
      ownerTrusted: true,
    };
  }
  return permissionResult("posix");
}

function measuredRows(iterations = 40) {
  return WINDOWS_OWNER_CAUGHT_FAILURE_NAMES.map((name) => ({
    name,
    iterations: windowsOwnerCaughtFailureIterations(name, iterations),
    samplesUs: [1],
    minUs: 1,
    medianUs: 1,
    maxUs: 1,
    workloadSemantics: "equivalent-output",
    workloadDetails: {
      ...WINDOWS_OWNER_CAUGHT_FAILURE_RECEIPT,
      cohort: name.split("/").at(-1),
    },
    fixturePlacement: WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE,
  }));
}

describe("Windows owner caught-failure benchmark contract", () => {
  it("executes every prebuilt cohort and verifies it outside timing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-owner-caught-bench-"));
    const cleanups: Array<() => void> = [];
    const rows: Array<{
      name: string;
      run: () => Promise<unknown>;
      options: BenchmarkOptions;
    }> = [];
    try {
      registerWindowsOwnerCaughtFailure({
        api: {
          inspectWindowsAcl,
          inspectPathPermissions: inspectPermissionFixture,
        },
        workspace,
        native: false,
        PermissionCommandError,
        register: (
          name: string,
          run: () => Promise<unknown>,
          options: BenchmarkOptions,
        ) => rows.push({ name, run, options }),
        onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
        platform: "linux",
      });

      expect(rows.map(({ name }) => name)).toEqual(WINDOWS_OWNER_CAUGHT_FAILURE_NAMES);
      for (const row of rows) {
        expect(row.options.divisor).toBe(windowsOwnerCaughtFailureDivisor(row.name));
        expect(row.options.workloadSemantics).toBe("equivalent-output");
        expect(row.options.workloadDetails).toMatchObject(WINDOWS_OWNER_CAUGHT_FAILURE_RECEIPT);
        expect(row.options.fixturePlacement).toBe(WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE);
        expect(Object.isFrozen(row.options.workloadDetails)).toBe(true);
        row.options.before();
        const result = await row.run();
        expect(() => row.options.after(result)).not.toThrow();
      }
    } finally {
      cleanups.reverse().forEach((cleanup) => cleanup());
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("fails a source cohort when its checked result changes", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-owner-caught-bench-"));
    const cleanups: Array<() => void> = [];
    const rows: Array<{
      name: string;
      options: BenchmarkOptions;
    }> = [];
    try {
      registerWindowsOwnerCaughtFailure({
        api: {
          inspectWindowsAcl,
          inspectPathPermissions: inspectPermissionFixture,
        },
        workspace,
        native: false,
        PermissionCommandError,
        register: (name: string, _run: () => Promise<unknown>, options: BenchmarkOptions) =>
          rows.push({ name, options }),
        onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
        platform: "linux",
      });
      const ordinary = rows.find(({ name }) => name.endsWith("/ordinary-error"))!;
      ordinary.options.before();
      expect(() => ordinary.options.after({ ok: true })).toThrow();
    } finally {
      cleanups.reverse().forEach((cleanup) => cleanup());
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("unit-checks a native Windows control receipt without consuming the fallback", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-owner-caught-native-"));
    const cleanups: Array<() => void> = [];
    const rows: Array<{
      name: string;
      run: () => Promise<unknown>;
      options: BenchmarkOptions;
    }> = [];
    try {
      registerWindowsOwnerCaughtFailure({
        api: {
          inspectWindowsAcl,
          inspectPathPermissions: async () => ({
            ...permissionResult("windows-acl"),
            ownerSid: "s-1-5-21-42",
            ownerTrusted: true,
          }),
        },
        workspace,
        native: true,
        PermissionCommandError,
        register: (
          name: string,
          run: () => Promise<unknown>,
          options: BenchmarkOptions,
        ) => rows.push({ name, run, options }),
        onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
        platform: "win32",
      });
      const control = rows[0]!;
      expect(control.name).toContain("platform-control");
      control.options.before();
      const result = await control.run();
      expect(() => control.options.after(result)).not.toThrow();
    } finally {
      cleanups.reverse().forEach((cleanup) => cleanup());
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  itNativeWindowsOwner("executes the private native-require Windows control without fallback", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-owner-caught-live-"));
    const cleanups: Array<() => void> = [];
    const rows: Array<{
      name: string;
      run: () => Promise<unknown>;
      options: BenchmarkOptions;
    }> = [];
    try {
      configureFsSafeNative({ mode: "require" });
      applyBenchmarkPrivateWindowsAcl({ createIcaclsResetCommand }, workspace);
      registerWindowsOwnerCaughtFailure({
        api: { inspectWindowsAcl, inspectPathPermissions },
        workspace,
        native: true,
        PermissionCommandError,
        register: (
          name: string,
          run: () => Promise<unknown>,
          options: BenchmarkOptions,
        ) => rows.push({ name, run, options }),
        onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
        platform: "win32",
      });

      const control = rows.find(({ name }) => name.endsWith("/platform-control"))!;
      control.options.before();
      const result = await control.run();
      expect(() => control.options.after(result)).not.toThrow();
      expect(result).toMatchObject({
        ok: true,
        source: "windows-acl",
        ownerTrusted: true,
        worldWritable: false,
        groupWritable: false,
        worldReadable: false,
        groupReadable: false,
      });
    } finally {
      try {
        cleanups.reverse().forEach((cleanup) => cleanup());
      } finally {
        try {
          fs.rmSync(workspace, { recursive: true, force: true });
        } finally {
          __resetFsSafeNativeConfigForTest();
        }
      }
    }
  });

  it("admits only the complete unskipped receipt-bound row set", () => {
    const rows = measuredRows();
    const report = { metadata: { mode: "off" }, results: rows };

    expect(() => validateWindowsOwnerCaughtFailureReport(
      report,
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).not.toThrow();
    expect(windowsOwnerCaughtFailureDivisor(rows[0]!.name)).toBe(
      WINDOWS_OWNER_CAUGHT_FAILURE_CONTROL_DIVISOR,
    );
    expect(windowsOwnerCaughtFailureDivisor(rows.at(-1)!.name)).toBe(1);
    for (const row of rows) {
      expect(() => validateWindowsOwnerCaughtFailureResult(row)).not.toThrow();
    }
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, results: rows.slice(1) },
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, results: [...rows, rows[0]] },
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, metadata: { mode: "auto" } },
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).toThrow("native mode mismatch");
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, results: [{ ...rows[0], iterations: 3 }, ...rows.slice(1)] },
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).toThrow("iteration count mismatch");
    expect(() => validateWindowsOwnerCaughtFailureResult({
      ...rows[0],
      skipped: "not run",
    })).toThrow("must execute rather than skip");
    expect(() => validateWindowsOwnerCaughtFailureResult({
      ...rows[0],
      workloadDetails: {
        ...rows[0].workloadDetails,
        hostileCases: "timed",
      },
    })).toThrow("workload receipt mismatch");
    expect(() => validateWindowsOwnerCaughtFailureResult({
      ...rows[0],
      fixturePlacement: {
        ...WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE,
        filesystemChecks: "timed",
      },
    })).toThrow("fixture receipt mismatch");
  });

  it("rejects every undeclared row in the reserved namespaces", () => {
    const rows = measuredRows();
    const unknownAcl = {
      ...rows[2],
      name: "inspectWindowsAcl/windows-owner-caught/undeclared",
    };
    const unknownControl = {
      ...rows[0],
      name: "inspectPathPermissions/windows-owner-caught/undeclared-control",
    };
    const exactAclPrefix = {
      ...rows[2],
      name: "inspectWindowsAcl/windows-owner-caught",
    };
    const exactControlPrefix = {
      ...rows[0],
      name: "inspectPathPermissions/windows-owner-caught",
    };
    const report = { metadata: { mode: "off" }, results: rows };

    expect(() => validateWindowsOwnerCaughtFailureResult(unknownAcl))
      .toThrow("not a declared Windows owner caught-failure row");
    expect(() => validateWindowsOwnerCaughtFailureResult({
      ...unknownControl,
      skipped: "unknown row was skipped",
    })).toThrow("not a declared Windows owner caught-failure row");
    expect(() => validateWindowsOwnerCaughtFailureResult(exactAclPrefix))
      .toThrow("not a declared Windows owner caught-failure row");
    expect(() => validateWindowsOwnerCaughtFailureResult(exactControlPrefix))
      .toThrow("not a declared Windows owner caught-failure row");
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, results: [...rows, unknownAcl] },
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, results: [...rows, { ...unknownControl, skipped: "unsupported" }] },
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, results: [unknownAcl, ...rows.slice(1)] },
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, results: [...rows, exactAclPrefix] },
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, results: [exactControlPrefix, ...rows.slice(1)] },
      WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
      40,
    )).toThrow("row set mismatch");
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { ...report, results: [unknownAcl] },
      "windows-owner-caught/undeclared",
      40,
    )).toThrow("row set mismatch");
  });

  it("requires only rows selected by narrower or unrelated filters", () => {
    const rows = measuredRows();
    const aclRows = rows.filter(({ name }) => name.startsWith("inspectWindowsAcl/"));
    expect(() => validateWindowsOwnerCaughtFailureResult({
      name: "unrelated-benchmark/row",
      skipped: "owned by another benchmark contract",
    })).not.toThrow();
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { metadata: { mode: "auto" }, results: aclRows },
      "inspectWindowsAcl/",
      40,
    )).not.toThrow();
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { metadata: { mode: "auto" }, results: [] },
      "unrelated-filter",
      40,
    )).not.toThrow();
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { results: [] },
      "unrelated-filter",
      40,
    )).not.toThrow();
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { results: [{ name: "unrelated-benchmark/row", skipped: "not selected" }] },
      "unrelated-filter",
      40,
    )).not.toThrow();
    expect(() => validateWindowsOwnerCaughtFailureReport(
      { metadata: { mode: "auto" }, results: rows },
      "",
      40,
    )).not.toThrow();
    expect(() => validateWindowsOwnerCaughtFailureReport(
      {
        metadata: { mode: "auto" },
        results: [{
          ...rows[0],
          name: "inspectPathPermissions/windows-owner-caught/unexpected",
        }],
      },
      "unrelated-filter",
      40,
    )).toThrow("row set mismatch");
  });

  it("prevents standalone JSON emission after an invalid receipt and still cleans", async () => {
    const envelope = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-owner-runner-"));
    const workspace = path.join(envelope, "workspace");
    const reportPath = path.join(envelope, "report.json");
    fs.mkdirSync(workspace);
    const rows = measuredRows();
    const report = {
      metadata: { mode: "off" },
      results: [...rows, {
        ...rows[2],
        name: "inspectWindowsAcl/windows-owner-caught/undeclared",
      }],
    };
    const events: string[] = [];
    try {
      await expect(finalizeBenchmarkReport({
        validateReport: () => validateWindowsOwnerCaughtFailureReport(
          report,
          WINDOWS_OWNER_CAUGHT_FAILURE_FILTER,
          40,
        ),
        cleanup: async () => { events.push("core"); },
        cleanups: [async () => { events.push("registered"); }],
        workspace,
        reportPath,
        report,
      })).rejects.toThrow("row set mismatch");
      expect(events).toEqual(["core", "registered"]);
      expect(fs.existsSync(workspace)).toBe(false);
      expect(fs.existsSync(reportPath)).toBe(false);

      const runner = fs.readFileSync("benchmarks/runner.mjs", "utf8");
      expect(runner).toContain(
        "validateWindowsOwnerCaughtFailureReport(completedReport, args.filter, args.iterations);",
      );
      expect(runner.indexOf("validateGuestBenchmarkReport(completedReport, args.filter);"))
        .toBeLessThan(runner.indexOf("validateWindowsOwnerCaughtFailureReport(completedReport"));
    } finally {
      fs.rmSync(envelope, { recursive: true, force: true });
    }
  });
});
