import { createHash } from "node:crypto";
import fs, { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extendedCase } from "../scripts/mutation-policy-proof-cases.mjs";
import {
  canonicalReceipt,
  expectedFinalReceiptContract,
  parseArguments,
  parseWorkerReceipt,
  runBoundedProcess,
  sanitizeProofFailure,
  validateFinalReceiptText,
  withFixture,
} from "../scripts/mutation-policy-proof.mjs";

const provenance = "a".repeat(64);

type WorkerReceiptFixture = {
  backend: string;
  case: string;
  complete: boolean;
  failure: { code?: string; kind: string; stage: string } | null;
  observations: Record<string, boolean | number | string>;
  passed: boolean;
  provenance: string;
  schema: string;
};

function workerReceipt(
  overrides: Record<string, unknown> = {},
): WorkerReceiptFixture & Record<string, unknown> {
  return {
    backend: "shared-js/off",
    case: "allowed-mkdir",
    complete: true,
    failure: null,
    observations: {
      addonLoaded: false,
      builtPublicImport: true,
      privateFixture: true,
      route: "shared-missing-parent",
    },
    passed: true,
    provenance,
    schema: "fs-safe-mutation-policy-worker-v2",
    ...overrides,
  } as WorkerReceiptFixture & Record<string, unknown>;
}

function pendingReceipt(overrides: Record<string, unknown> = {}) {
  return {
    cases: [],
    coverage: { complementary: [], hosted: [], limitations: [] },
    failure: { code: "PENDING", kind: "proof", stage: "startup" },
    passed: false,
    proof: "mutation-policy-public-behavior",
    provenance: null,
    runtime: { arch: "x64", libuv: "1", node: "v24.1.0", platform: "linux", v8: "1" },
    schema: "fs-safe-mutation-policy-proof-v2",
    status: "pending",
    ...overrides,
  };
}

function observationsForCase(name: string, backend: string) {
  const common = {
    addonLoaded: backend === "pinned-native/require",
    builtPublicImport: true,
    node24: true,
    privateFixture: true,
    privilegeModel: process.platform === "win32" ? "no-elevation-requested" : "posix-nonroot",
  };
  let specific: Record<string, boolean | number | string>;
  if (extendedCase(name)) {
    specific = extendedCase(name).observations;
  } else if (name === "allowed-mkdir") {
    specific = { route: "shared-missing-parent", targetDirectory: true };
  } else if (name === "allowed-open-writable" || name === "allowed-append") {
    specific = { route: "shared-missing-parent", targetBytes: 30 };
  } else if (name.startsWith("post-create-")) {
    const forced = name.endsWith("forced");
    specific = {
      authorityCalls: forced ? 1 : 0,
      faultCount: name.includes("observation") ? 1 : 0,
      mkdirAttempts: 1,
      mkdirCompletions: 1,
      route: forced ? "component-walk-authority" : "exact-parent-optimized",
    };
  } else if (name.startsWith("os-eexist-")) {
    specific = {
      collision: name.endsWith("directory") ? "directory" : "file",
      genuineEexist: true,
      mkdirAttempts: 1,
      route: "exact-parent-optimized",
    };
  } else if (name === "parent-replacement-authority-fence") {
    specific = { authoritySwap: true, childMkdirSubmissions: 0, route: "component-walk-authority" };
  } else if (name === "root-replacement-authority-fence") {
    specific = { authoritySwap: true, originalParentEmpty: true, replacementParentEmpty: true,
      route: "component-walk-authority" };
  } else if (name === "stale-missing-parent-recapture") {
    specific = {
      currentParentUsed: true,
      route: "shared-post-create-current-selection",
      staleParentUnused: true,
    };
  } else if (name === "denied-parent-redirect") {
    specific = { deniedParentEmpty: true, displacedParentEmpty: true, rejectedCode: "denied-path",
      redirectInjected: true, route: "full-policy-refresh" };
  } else if (name === "deny-spelling-drift") {
    specific = {
      denySpellingAppeared: true,
      nextComponentMkdirSubmissions: 0,
      route: "shared-policy-refresh",
    };
  } else if (name === "native-config-drift") {
    specific = { configChanged: true, modeAfter: "auto", route: "shared-refresh", safeMkdirs: 2 };
  } else if (name.startsWith("selected-destination-")) {
    const retarget = name.endsWith("retarget");
    specific = {
      authorityCallbacks: retarget ? 1 : 0,
      handlesClosed: true,
      route: retarget ? "followed-final-authority-fence" : "followed-final-stable",
    };
  } else if (name.startsWith("authority-refusal-")) {
    const midWalk = name.endsWith("mid-walk");
    specific = {
      authorityCalls: midWalk ? 2 : 1,
      firstMkdirs: midWalk ? 1 : 0,
      route: "component-walk-authority",
      secondMkdirs: 0,
    };
  } else {
    const operation = name.startsWith("pinned-write-") ? "write" :
      name.startsWith("pinned-create-") ? "create" : "copy";
    specific = {
      operation,
      route: operation === "copy" ? "pinned-file-copy" : "pinned-buffer-write",
      targetBytes: 30,
    };
  }
  return { ...specific, ...common };
}

function passedReceipt(overrides: Record<string, unknown> = {}) {
  const contract = expectedFinalReceiptContract();
  const commit = "1".repeat(40);
  const binding = {
    checkout: {
      commit,
      dirty: false,
      expectedCommit: commit,
      expectedMatches: true,
      tree: "2".repeat(40),
    },
    event: { base: null, head: commit, headMatchesCheckout: true, name: "workflow_dispatch" },
    hashes: Object.fromEntries(contract.hashLabels.map((label) => [
      label,
      { bytes: 1, sha256: "3".repeat(64) },
    ])),
    nativeTarget: contract.nativeTarget,
    run: { attempt: "unavailable", id: "unavailable", number: "unavailable" },
  };
  const token = createHash("sha256").update(canonicalReceipt(binding)).digest("hex");
  return {
    cases: contract.cases.map(({ backend, name }) => workerReceipt({
      backend,
      case: name,
      observations: observationsForCase(name, backend),
      provenance: token,
    })),
    coverage: contract.coverage,
    failure: null,
    passed: true,
    proof: "mutation-policy-public-behavior",
    provenance: { binding, stableAfterWorkers: true, token },
    runtime: {
      arch: process.arch,
      libuv: "1",
      node: "v24.1.0",
      platform: process.platform,
      v8: "1",
    },
    schema: "fs-safe-mutation-policy-proof-v2",
    status: "passed",
    ...overrides,
  };
}

describe("mutation policy hosted proof contract", () => {
  it("accepts only canonical, complete, provenance-bound worker receipts", () => {
    const valid = canonicalReceipt(workerReceipt());
    expect(parseWorkerReceipt(valid, "allowed-mkdir", "shared-js/off", provenance))
      .toEqual(workerReceipt());

    const missing = workerReceipt();
    delete (missing as Partial<typeof missing>).complete;
    expect(parseWorkerReceipt(canonicalReceipt(missing), "allowed-mkdir", "shared-js/off", provenance))
      .toBeNull();

    const duplicate = valid.replace(
      '"backend":"shared-js/off"',
      '"backend":"shared-js/off","backend":"shared-js/off"',
    );
    for (const rejected of [
      "{broken}\n",
      duplicate,
      valid.slice(0, -1),
      ` ${valid}`,
      `${valid}\n`,
      `${" ".repeat(4096)}\n`,
      canonicalReceipt(workerReceipt({ provenance: "b".repeat(64) })),
      canonicalReceipt(workerReceipt({ observations: { path: "/private/fixture" } })),
      canonicalReceipt(workerReceipt({ stack: "secret" })),
    ]) {
      expect(parseWorkerReceipt(rejected, "allowed-mkdir", "shared-js/off", provenance)).toBeNull();
    }
  });

  it("sanitizes arbitrary failures and rejects unsanitized final receipts", () => {
    const error = Object.assign(new Error("secret /private/fixture"), {
      code: "unsafe /private/fixture",
      fd: 42,
      hostname: "private-host",
      path: "/private/fixture",
      stack: "private stack",
    });
    const sanitized = sanitizeProofFailure(error, "worker");
    expect(sanitized).toEqual({ kind: "error", stage: "worker" });
    expect(JSON.stringify(sanitized)).not.toMatch(/secret|private|fixture|stack|hostname|fd/u);
    expect(sanitizeProofFailure(Object.assign(new Error(), { code: "EIO" }), "worker"))
      .toEqual({ code: "EIO", kind: "error", stage: "worker" });

    expect(validateFinalReceiptText(canonicalReceipt(pendingReceipt()))).toEqual(pendingReceipt());
    expect(validateFinalReceiptText(canonicalReceipt(pendingReceipt({
      failure: { kind: "error", message: "leak", stage: "startup" },
    })))).toBeNull();
    expect(validateFinalReceiptText(canonicalReceipt(pendingReceipt({
      provenance: { cwd: "/private/work" },
    })))).toBeNull();
    expect(validateFinalReceiptText(canonicalReceipt(pendingReceipt()).replace(
      '"passed":false', '"passed":false,"passed":false',
    ))).toBeNull();
    expect(validateFinalReceiptText("{malformed}\n")).toBeNull();
    expect(validateFinalReceiptText(`${" ".repeat(32 * 1024)}\n`)).toBeNull();
  });

  it("requires non-vacuous cases and hash-bound stable provenance for passed receipts", () => {
    const valid = passedReceipt();
    expect(validateFinalReceiptText(canonicalReceipt(valid))).toEqual(valid);

    const vacuous = pendingReceipt({ failure: null, passed: true, status: "passed" });
    expect(validateFinalReceiptText(canonicalReceipt(vacuous))).toBeNull();

    const missingCase = passedReceipt();
    missingCase.cases.pop();
    const duplicateCase = passedReceipt();
    duplicateCase.cases[1] = duplicateCase.cases[0]!;
    const failedWorker = passedReceipt();
    failedWorker.cases[0] = workerReceipt({
      complete: false,
      failure: { code: "EIO", kind: "error", stage: "behavior" },
      passed: false,
      provenance: failedWorker.provenance.token,
    });
    const noProvenance = { ...passedReceipt(), provenance: null };
    const unstable = passedReceipt();
    unstable.provenance.stableAfterWorkers = false;
    const wrongToken = passedReceipt();
    wrongToken.provenance.token = "4".repeat(64);
    const missingObservations = passedReceipt();
    missingObservations.cases[0]!.observations = {};
    const inconsistentBackend = passedReceipt();
    const backendIndex = Math.max(
      0,
      inconsistentBackend.cases.findIndex((entry) => entry.backend === "pinned-native/require"),
    );
    inconsistentBackend.cases[backendIndex]!.observations.addonLoaded =
      !inconsistentBackend.cases[backendIndex]!.observations.addonLoaded;

    for (const rejected of [
      missingCase,
      duplicateCase,
      failedWorker,
      noProvenance,
      unstable,
      wrongToken,
      missingObservations,
      inconsistentBackend,
    ]) expect(validateFinalReceiptText(canonicalReceipt(rejected))).toBeNull();

    const partialBase = passedReceipt();
    partialBase.cases.pop();
    const partialFailure = {
      ...partialBase,
      failure: { code: "WORKER_FAILED", kind: "proof", stage: "workers" },
      passed: false,
      provenance: { ...partialBase.provenance, stableAfterWorkers: false },
      status: "failed",
    };
    expect(validateFinalReceiptText(canonicalReceipt(partialFailure))).toEqual(partialFailure);

    const preSetup = pendingReceipt({
      runtime: { arch: process.arch, libuv: "1", node: "v20.1.0", platform: process.platform, v8: "1" },
    });
    expect(validateFinalReceiptText(canonicalReceipt(preSetup))).toEqual(preSetup);
  });

  it("canonicalizes an aliased temporary fixture and cleans its created spelling", async () => {
    const createdBase = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-proof-contract-"));
    const base = await fs.realpath(createdBase);
    const realParent = path.join(base, "real");
    const aliasParent = path.join(base, "alias");
    await fs.mkdir(realParent);
    await fs.symlink(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const temp = vi.spyOn(os, "tmpdir").mockReturnValue(aliasParent);
    try {
      const result = await withFixture(
        "contract-test",
        async ({ directory }: { directory: string }) => {
          expect(directory).toBe(await fs.realpath(directory));
          expect(directory.startsWith(await fs.realpath(realParent))).toBe(true);
          return { route: "contract-test" };
        },
      );
      expect(result).toEqual({ privateFixture: true, route: "contract-test" });
      await expect(fs.readdir(realParent)).resolves.toEqual([]);
    } finally {
      temp.mockRestore();
      await fs.rm(createdBase, { force: true, recursive: true });
    }
  });

  it("requires every exact observation and rejects the old dispatch overclaims", () => {
    const valid = passedReceipt();
    expect(Buffer.byteLength(canonicalReceipt(valid))).toBeLessThan(28 * 1024);
    for (let index = 0; index < valid.cases.length; index += 1) {
      for (const [key, value] of Object.entries(valid.cases[index]!.observations)) {
        const changed = passedReceipt();
        const variableCount = key === "safeMkdirs" || (key === "authorityCalls" &&
          valid.cases[index]!.case.startsWith("post-create-") && valid.cases[index]!.case.endsWith("forced"));
        changed.cases[index]!.observations[key] = typeof value === "boolean" ? !value :
          typeof value === "number" ? (variableCount ? 0 : value + 1) : "wrong";
        expect(validateFinalReceiptText(canonicalReceipt(changed)), `${index}:${key}`).toBeNull();
      }
    }
    for (const [name, key] of [
      ["root-replacement-authority-fence", "mutationSubmissions"],
      ["parent-replacement-authority-fence", "mutationSubmissions"],
      ["denied-parent-redirect", "deniedBeforeDispatch"],
      ["deny-spelling-drift", "mutationSubmissionsAfterDrift"],
    ] as const) {
      const changed = passedReceipt();
      const target = changed.cases.find(entry => entry.case === name);
      if (!target) {
        expect([process.platform, name]).toEqual(["win32", "root-replacement-authority-fence"]);
        continue;
      }
      target.observations[key] = true;
      expect(validateFinalReceiptText(canonicalReceipt(changed))).toBeNull();
    }
    expect(validateFinalReceiptText(canonicalReceipt({ ...valid, schema: "fs-safe-mutation-policy-proof-v1" }))).toBeNull();
  });

  it("requires exact, non-duplicated coordinator arguments", () => {
    const hash = "1".repeat(40);
    const args = [
      "--run", "--receipt", process.platform === "win32" ? "C:\\proof.json" : "/proof.json",
      "--expected-commit", hash, "--event-head", hash, "--event-base", "none",
      "--event-name", "pull_request", "--install-result", "success",
      "--build-result", "success", "--native-result", "success",
    ];
    expect(parseArguments(args)).toMatchObject({
      buildResult: "success", eventBase: null, eventHead: hash,
      eventName: "pull_request", expectedCommit: hash, installResult: "success",
      mode: "run", nativeResult: "success",
    });
    expect(() => parseArguments([])).toThrow();
    expect(() => parseArguments([...args, "--event-head", hash])).toThrow();
    expect(() => parseArguments(args.map((value) => value === hash ? "bad" : value))).toThrow();
  });

  it("reports worker exit failure and kills and reaps a timed-out worker", async () => {
    const failed = await runBoundedProcess(process.execPath, ["-e", "process.exit(7)"], {
      timeoutMs: 2_000,
    });
    expect(failed).toMatchObject({ exitCode: 7, reaped: true, timedOut: false });

    const timedOut = await runBoundedProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 50 },
    );
    expect(timedOut).toMatchObject({ reaped: true, timedOut: true });
    expect(timedOut.exitCode).not.toBe(0);
  });

  it("uses only built public exports and fresh bounded workers for behavior", async () => {
    const source = await readFile("scripts/mutation-policy-proof.mjs", "utf8");
    expect(source).toContain('import.meta.resolve("@openclaw/fs-safe")');
    expect(source).toContain('await import("@openclaw/fs-safe")');
    expect(source).toContain('resolved.endsWith("/dist/index.js")');
    expect(source).toContain('from "./mutation-policy-proof-cases.mjs"');
    expect(source).not.toContain("beforeRootFallbackMutation");
    expect(source).toContain('fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-mutation-policy-proof-")');
    expect(source).toContain("fs.realpath(createdDirectory)");
    expect(source).toContain("WORKER_TIMEOUT_MS = 15_000");
    expect(source).toContain("RECEIPT_MAX_BYTES = 32 * 1024");
    expect(source).toContain("process.getuid() !== 0");
    for (const name of [
      "allowed-mkdir", "allowed-open-writable", "allowed-append",
      "post-create-symlink-optimized", "post-create-file-forced",
      "post-create-observation-optimized", "os-eexist-directory", "os-eexist-file",
      "parent-replacement-authority-fence", "root-replacement-authority-fence",
      "stale-missing-parent-recapture", "denied-parent-redirect", "deny-spelling-drift",
      "native-config-drift", "selected-destination-stable", "selected-destination-retarget",
      "authority-refusal-immediate", "authority-refusal-mid-walk",
      "pinned-write-require", "pinned-create-require", "pinned-copy-in-require",
    ]) expect(source).toContain(`"${name}"`);
  });

  it("always uploads one exact receipt from an exact event-head checkout", async () => {
    const workflow = (await readFile(
      ".github/workflows/mutation-policy-proof.yml",
      "utf8",
    )).replace(/\r\n?/gu, "\n");
    expect(workflow).toContain("os: [ubuntu-latest, macos-15, windows-latest]");
    expect(workflow).toContain("node-version: 24");
    expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha || github.sha }}");
    expect(workflow).toContain("fetch-depth: 1");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("Initialize pending sanitized receipt");
    expect(workflow).toContain("Run bounded public mutation proof\n        id: proof\n        if: always()");
    expect(workflow).toContain("Preserve one canonical receipt on every path\n        if: always()");
    expect(workflow).toContain("Upload exact mutation proof receipt\n        if: always()");
    expect(workflow).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    const jobStart = workflow.indexOf("  public-behavior-proof:\n");
    const stepsStart = workflow.indexOf("    steps:\n", jobStart);
    expect(jobStart).toBeGreaterThanOrEqual(0);
    expect(stepsStart).toBeGreaterThan(jobStart);
    expect(workflow.slice(jobStart, stepsStart)).not.toMatch(/\brunner\s*\./u);
    const stepItems = workflow.slice(stepsStart + "    steps:\n".length)
      .split(/(?=^      - )/mu)
      .filter((item) => item.startsWith("      - "));
    const step = (name: string) => {
      const marker = `      - name: ${name}\n`;
      const matches = stepItems.filter((item) => item.startsWith(marker));
      expect(matches, `workflow step count: ${name}`).toHaveLength(1);
      return matches[0]!;
    };
    const receiptBinding =
      "        env:\n" +
      "          MUTATION_POLICY_RECEIPT: ${{ runner.temp }}/mutation-policy-proof-${{ runner.os }}.json";
    for (const [name, consumer] of [
      ["Initialize pending sanitized receipt", "--initialize --receipt \"$MUTATION_POLICY_RECEIPT\""],
      ["Run bounded public mutation proof", "--receipt \"$MUTATION_POLICY_RECEIPT\""],
      ["Preserve one canonical receipt on every path", "--ensure --receipt \"$MUTATION_POLICY_RECEIPT\""],
      ["Upload exact mutation proof receipt", "path: ${{ env.MUTATION_POLICY_RECEIPT }}"],
    ] as const) {
      expect(step(name)).toContain(receiptBinding);
      expect(step(name)).toContain(consumer);
    }
    const upload = step("Upload exact mutation proof receipt");
    const uploadWith = upload.indexOf("\n        with:\n");
    expect(uploadWith).toBeGreaterThanOrEqual(0);
    expect(upload.slice(uploadWith)).toMatch(
      /^          path: \$\{\{ env\.MUTATION_POLICY_RECEIPT \}\}$/mu,
    );
    expect(workflow.match(
      /^          MUTATION_POLICY_RECEIPT: \$\{\{ runner\.temp \}\}\/mutation-policy-proof-\$\{\{ runner\.os \}\}\.json$/gmu,
    )).toHaveLength(4);
    expect(workflow).not.toMatch(/path:\s*[|>]\s*$/mu);
    expect(workflow).not.toMatch(/MUTATION_POLICY_RECEIPT[^\n]*[*?]/u);
    const shellFallback = workflow.match(/printf '%s\\n' '(\{[^'\r\n]+\})' > "\$fallback"/u)?.[1];
    expect(shellFallback).toBeDefined();
    if (shellFallback === undefined) throw new Error("workflow fallback literal missing");
    const fallbackText = `${shellFallback}\n`;
    expect(validateFinalReceiptText(fallbackText)).toEqual(JSON.parse(shellFallback));
  });
});
