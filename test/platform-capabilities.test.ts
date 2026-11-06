import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { tryAcquireWriteLease } from "../src/file-lock.js";
import { inspectDarwinAcl } from "../src/permissions-public.js";
import { holdWindowsSharingLock, setWindowsFileAttributes, readWindowsFileExtents } from "../src/test-hooks.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useTempDirs } from "./helpers/vitest.js";

const native = loadTestNative("required-env");
const { tempRoot } = useTempDirs();
const diagnosticEnabled = process.env.FS_SAFE_PLATFORM_CAPABILITY_DIAGNOSTICS === "1";
const phaseName = ".fs-safe-platform-capability-phases.jsonl";
type Diagnostic = {
  directory: string;
  verdict: "pending" | "passed" | "failed";
  receipt: Record<string, unknown>;
};
let diagnostic: Diagnostic | undefined;
const diagnostics: Diagnostic[] = [];
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const text = (value: unknown, directory: string) => typeof value === "string"
  ? Buffer.from(value.replaceAll(directory, "<synthetic-temp>")).subarray(-4096).toString("utf8") : null;
function failureFields(error: unknown, directory: string) {
  const fields = (error ?? {}) as Record<string, unknown>;
  const output = (value: unknown) => typeof value === "string" ? {
    bytes: Buffer.byteLength(value), tail: text(value, directory),
  } : null;
  return {
    name: text(fields.name, directory), message: text(fields.message, directory),
    code: fields.code ?? null, killed: fields.killed ?? null,
    signal: fields.signal ?? null, status: fields.status ?? null,
    stdout: output(fields.stdout), stderr: output(fields.stderr),
  };
}

// Registered after useTempDirs: reverse afterEach order captures before cleanup.
// Only preserve the tiny sidecar here: identity reads wait until BOTH cases end.
afterEach(() => {
  const observed = diagnostic;
  diagnostic = undefined;
  if (!observed) return;
  const { directory, receipt } = observed;
  receipt.verdict = observed.verdict;
  try {
    const phaseFile = path.join(directory, phaseName);
    assert.ok(fs.statSync(phaseFile).size <= 32 * 1024, "diagnostic phase byte bound");
    const phases = fs.readFileSync(phaseFile, "utf8");
    const records = phases.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.ok(records.length <= 64, "diagnostic phase count bound");
    receipt.phases = records;
  } catch (error) {
    receipt.collectionError = failureFields(error, directory);
  }
});

afterAll(() => {
  if (!diagnosticEnabled) return;
  let identity: Record<string, unknown> | undefined, collectionError: unknown;
  try {
    const producerFile = "release-artifacts-package-smoke/package-build-proof.json";
    const producer = JSON.parse(fs.readFileSync(producerFile, "utf8"));
    assert.equal(producer.source.commit, process.env.GITHUB_SHA);
    assert.equal(producer.source.dirty, false);
    assert.equal(producer.host, "win32-x64-msvc");
    const manifestHash = hash("release-artifacts-package-smoke/manifest.json");
    assert.equal(manifestHash, producer.manifestSha256);
    identity = {
      // Immutable parent subject; producer source is the distinct diagnostic commit.
      subject: "1927e4a6a8b3875e7426d8704c1ce8495ad98af5",
      subjectTree: "ebbc437319dc3774847d5f564f1500b9c0faa078",
      producer, producerProofSha256: hash(producerFile), manifestSha256: manifestHash,
      artifactName: `package-smoke-build-windows-latest-${producer.source.commit}`,
      binarySha256: hash("packages/win32-x64-msvc/fs-safe-native.node"),
      testSha256: hash(fileURLToPath(import.meta.url)),
      fixtureSha256: hash(fileURLToPath(new URL("./fixtures/platform-capabilities.mjs", import.meta.url))),
      node: process.version, arch: process.arch, platform: process.platform,
      napi: process.versions.napi, modules: process.versions.modules,
      run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
      image: process.env.ImageOS, imageVersion: process.env.ImageVersion,
      timing: "after-all-case-verdicts", instrumentation: "sidecar phase I/O; not an unchanged timing control",
    };
  } catch (error) {
    collectionError = error;
  }
  for (const observed of diagnostics) {
    const { receipt, directory } = observed;
    receipt.expectedCases = 2;
    receipt.observedCases = diagnostics.length;
    receipt.identity = identity ?? null;
    if (collectionError) receipt.identityError = failureFields(collectionError, directory);
    console.error(`FS_SAFE_PLATFORM_CAPABILITY_DIAGNOSTIC ${JSON.stringify(receipt)}`);
  }
  // Never mask an existing primary failure. Incomplete telemetry cannot certify
  // an otherwise passing diagnostic job, including a case that never settled.
  if (!diagnostics.some(observed => observed.verdict !== "passed")) {
    assert.equal(diagnostics.length, 2, "both diagnostic cases must execute");
    assert.equal(collectionError, undefined, "diagnostic identity collection failed");
    assert.ok(diagnostics.every(observed => !observed.receipt.collectionError), "diagnostic phase collection failed");
  }
});

describe("platform capability contracts", () => {
  it("keeps platform results explicit", () => {
    if (process.platform !== "linux") expect(() => tryAcquireWriteLease(0)).toThrowError(expect.objectContaining({ code: "unsupported-platform" }));
    if (process.platform !== "darwin") expect(inspectDarwinAcl("missing")).toEqual({ kind: "unknown", reason: "unsupported-platform" });
    if (process.platform !== "win32") {
      for (const operation of [() => holdWindowsSharingLock("missing"), () => setWindowsFileAttributes("missing", {}), () => readWindowsFileExtents("missing")]) {
        expect(operation).toThrowError(expect.objectContaining({ code: "unsupported-platform" }));
      }
    }
    expect(true).toBe(true);
  });
});

describe.runIf(Boolean(native) && process.env.FS_SAFE_NATIVE_MODE !== "off")("real platform capabilities", () => {
  it.each(["main", "worker"])("proves native behavior in %s thread", async mode => {
    const directory = await tempRoot(`fs-safe-capabilities-${mode}-`);
    if (diagnosticEnabled) {
      assert.equal(process.env.GITHUB_ACTIONS, "true");
      assert.equal(process.env.GITHUB_REF, "refs/heads/roboclaw/diag-windows-smoke-owner");
      assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
      assert.equal(process.platform, "win32");
      assert.equal(process.arch, "x64");
      assert.equal(process.version, "v22.23.4");
      fs.writeFileSync(path.join(directory, phaseName), "", { flag: "wx", mode: 0o600 });
      diagnostic = { directory, verdict: "pending", receipt: {
        kind: "instrumented-platform-capability-diagnostic", mode,
        childDeadlineMs: 20_000, caseDeadlineMs: 25_000, events: [],
      } };
      diagnostics.push(diagnostic);
    }
    const observed = diagnostic;
    const started = observed ? process.hrtime.bigint() : 0n;
    const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
    const execution = promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("./fixtures/platform-capabilities.mjs", import.meta.url)),
      mode, directory,
    ], { timeout: 20_000, env: { ...process.env, FS_SAFE_NATIVE_MODE: "require" } });
    if (observed) {
      const events = observed.receipt.events as Record<string, unknown>[];
      execution.child.once("spawn", () => events.push({ event: "spawn", elapsedMs: elapsedMs() }));
      execution.child.once("error", error => events.push({ event: "error", elapsedMs: elapsedMs(), error: failureFields(error, directory) }));
      execution.child.once("exit", (code, signal) => events.push({ event: "exit", elapsedMs: elapsedMs(), code, signal }));
      execution.child.once("close", (code, signal) => events.push({ event: "close", elapsedMs: elapsedMs(), code, signal }));
    }
    try {
      const result = await execution;
      if (observed) observed.receipt.output = {
        stdout: { bytes: Buffer.byteLength(result.stdout), tail: text(result.stdout, directory) },
        stderr: { bytes: Buffer.byteLength(result.stderr), tail: text(result.stderr, directory) },
      };
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`"mode":"${mode}"`);
      console.log(result.stdout.trim());
      if (observed) observed.verdict = "passed";
    } catch (error) {
      if (observed) {
        observed.verdict = "failed";
        observed.receipt.failure = failureFields(error, directory);
      }
      throw error;
    } finally {
      if (observed) observed.receipt.process = {
        elapsedMs: elapsedMs(), pid: execution.child.pid ?? null,
        exitCode: execution.child.exitCode, signalCode: execution.child.signalCode,
        killed: execution.child.killed,
      };
    }
  }, 25_000);
});
