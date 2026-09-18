import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { canContinueCompilerControls, extractRawFixture, ownedTempInventory, runDiagnosticProcess, runFixtureWorker, runtimeProfileControlEnv } from "../scripts/windows-security-compiler-diagnostic.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it("stops later comparisons whenever worker or compiler completion is unconfirmed", () => {
  const supervisor = { exitConfirmed: true, outputClosed: true, exitCode: 0, signal: null, timedOut: false, errorCode: null };
  const fixture = { exitCode: 0, signal: null, errorCode: null };
  expect(canContinueCompilerControls(supervisor, fixture)).toBe(true);
  for (const change of [{ exitConfirmed: false }, { outputClosed: false }, { exitCode: null },
    { signal: "SIGKILL" }, { timedOut: true }, { errorCode: "output-limit" }]) {
    expect(canContinueCompilerControls({ ...supervisor, ...change }, fixture)).toBe(false);
  }
  const snapshot = { ...supervisor, processes: { protocol: 1, ok: true, rootValidated: true, truncated: false } };
  expect(canContinueCompilerControls({ ...supervisor, snapshots: [snapshot] }, fixture)).toBe(true);
  expect(canContinueCompilerControls({ ...supervisor, snapshots: [{ status: "snapshot-failed" }] }, fixture)).toBe(false);
  expect(canContinueCompilerControls({ ...supervisor, snapshots: [{ ...supervisor, outputClosed: false }] }, fixture)).toBe(false);
  for (const change of [{ protocol: 2 }, { ok: false }, { rootValidated: false }, { truncated: true }]) {
    expect(canContinueCompilerControls({ ...supervisor, snapshots: [{ ...snapshot, processes: { ...snapshot.processes, ...change } }] }, fixture)).toBe(false);
  }
  for (const change of [{ exitCode: null }, { exitCode: 1 }, { signal: "SIGKILL" }, { errorCode: "ETIMEDOUT" }]) {
    expect(canContinueCompilerControls(supervisor, { ...fixture, ...change })).toBe(false);
  }
  expect(canContinueCompilerControls(supervisor, undefined)).toBe(false);
});

it("restores only allowlisted runtime facts while keeping installer and policy isolation", () => {
  const controlled = runtimeProfileControlEnv({ USERPROFILE: "isolated", TEMP: "isolated-temp",
    npm_config_userconfig: "isolated-config", npm_config_cache: "isolated-cache",
    PSExecutionPolicyPreference: "Restricted", __PSLockdownPolicy: "4" }, {
    UserProfile: "runtime-profile", Temp: "runtime-temp", PSModulePath: "runtime-modules",
    PSExecutionPolicyPreference: "Bypass", __PSLockdownPolicy: "8", GH_TOKEN: "synthetic-never-copy",
    NODE_OPTIONS: "synthetic-never-copy", npm_config_userconfig: "ambient-never-copy",
  });
  expect(controlled).toEqual({ USERPROFILE: "runtime-profile", TEMP: "runtime-temp", PSModulePath: "runtime-modules",
    npm_config_userconfig: "isolated-config", npm_config_cache: "isolated-cache",
    PSExecutionPolicyPreference: "Restricted", __PSLockdownPolicy: "4" });
});

it("keeps the compared fixture on spawnSync with default pipe EOF semantics", () => {
  const result = runFixtureWorker({ file: process.execPath,
    args: ["-e", "console.log(require('node:fs').readFileSync(0).length)"], stdin: "pipe" });
  expect(result).toMatchObject({ exitCode: 0, errorCode: null });
  expect(result.stdout.trim()).toBe("0");
});

it("extracts the exact existing fixture without evaluating template expressions", async () => {
  const source = await fs.readFile(new URL("../scripts/consumer-windows-security-probe.mjs", import.meta.url), "utf8");
  expect(extractRawFixture(source, "aclSource")).toContain("GetNamedSecurityInfoW");
  expect(extractRawFixture(source, "aclScript")).toContain("Add-Type -LiteralPath");
  expect(() => extractRawFixture('const x = String.raw`value${untrusted}`;', "x")).toThrow();
  expect(() => extractRawFixture('const x = String.raw`one`; const x = String.raw`two`;', "x")).toThrow();
});

it("reports only bounded extension counts and never follows an inventory junction", async () => {
  const directory = await tempRoot("fs-safe-compiler-inventory-");
  const configuration = path.join(directory, "config");
  const outside = path.join(directory, "unrelated");
  await fs.mkdir(configuration);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(configuration, "synthetic-secret-name.cmdline"), "unread contents");
  await fs.writeFile(path.join(outside, "must-not-count.dll"), "unread contents");
  await fs.symlink(outside, path.join(configuration, "junction"), "junction");
  const result = ownedTempInventory(configuration);
  expect(result).toMatchObject({ files: 1, directories: 0, extensions: { ".cmdline": 1 }, errorCode: null });
  expect(JSON.stringify(result)).not.toContain("synthetic-secret-name");
  await Promise.all(Array.from({ length: 140 }, (_, index) => fs.writeFile(path.join(configuration, `file-${index}`), "")));
  expect(ownedTempInventory(configuration)).toMatchObject({ files: 128, truncated: true });
});

it("closes piped stdin as the synchronous fixture does, and joins ordinary completion", async () => {
  const result = await runDiagnosticProcess(process.execPath, ["-e", "console.log(require('node:fs').readFileSync(0).length)"], { timeoutMs: 2_000 });
  expect(result).toMatchObject({ exitCode: 0, exitConfirmed: true, outputClosed: true, timedOut: false });
  expect(result.stdout.trim()).toBe("0");
});

it("bounds a stalled diagnostic process without claiming successful output", async () => {
  const result = await runDiagnosticProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", timeoutMs: 100 });
  expect(result.timedOut).toBe(true);
  expect(result.elapsedMs).toBeLessThan(2_000);
  expect(result.stdout).toBe("");
});

it("stops an excessive-output diagnostic before its normal deadline", async () => {
  const result = await runDiagnosticProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(1048577)); setInterval(() => {}, 1000)"], { timeoutMs: 2_000 });
  expect(result).toMatchObject({ errorCode: "output-limit", timedOut: false });
  expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024 * 1024);
});

it("retains a spawn failure without dumping paths or command arguments into its code", async () => {
  const directory = await tempRoot("fs-safe-compiler-spawn-");
  const result = await runDiagnosticProcess(path.join(directory, "missing-executable"), [], { timeoutMs: 2_000 });
  expect(result).toMatchObject({ errorCode: "ENOENT", stdout: "", stderr: "" });
});
