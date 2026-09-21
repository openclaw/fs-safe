import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXTENDED_CASES, extendedCase } from "../scripts/mutation-policy-proof-cases.mjs";
import { expectedFinalReceiptContract } from "../scripts/mutation-policy-proof.mjs";

describe("hosted mutation proof completeness contract", () => {
  it("requires the complete operation/backend matrix and distinct Windows compatibility route", () => {
    expect(EXTENDED_CASES.map(entry => entry.name)).toEqual([
      "pinned-policy-write-off", "pinned-policy-write-require",
      "pinned-policy-create-off", "pinned-policy-create-require",
      "pinned-policy-copy-off", "pinned-policy-copy-require",
      "pinned-write-refusal-epochs-off", "pinned-write-refusal-epochs-require",
      "windows-buffer-write-off", "windows-buffer-write-require",
    ]);
    for (const entry of EXTENDED_CASES) {
      expect(Object.isFrozen(entry.observations)).toBe(true);
      expect(Object.isFrozen(entry)).toBe(true);
      const applicable = (process.platform === "win32") === (entry.platform === "win32");
      expect(expectedFinalReceiptContract().cases.some(candidate => candidate.name === entry.name)).toBe(applicable);
    }
    expect(extendedCase("windows-buffer-write-require")).toMatchObject({
      backend: "windows-js/require", observations: { renamePolicy: "verify-content-with-lock" },
    });
    for (const operation of ["write", "create", "copy"]) {
      for (const mode of ["off", "require"]) {
        expect(extendedCase(`pinned-policy-${operation}-${mode}`)?.observations).toEqual({
          operation, route: "pinned-parent-policy", eligibleControl: true,
          deeperParentDenied: true, admittedPrefixExists: true,
          redirectSeamCalls: 1, redirectedParentDenied: true,
          staleSeamCalls: 1, staleAuthorityCalls: 1, staleParentRejected: true,
          sentinelsPreserved: true, rejectedTargetsAbsent: true, rejectedStagesAbsent: true,
          testSeam: "built-post-preflight-hook",
        });
      }
    }
    for (const mode of ["off", "require"]) {
      expect(extendedCase(`pinned-write-refusal-epochs-${mode}`)?.observations).toEqual({
        route: "pinned-write-authority", epochs: 4, refusals: 4,
        callbacksAfterRefusal: 0, firstMkdirRefused: true, admittedPrefixObserved: true,
        stageRefused: true, completedPrivateStageObserved: true,
        destinationPreserved: true, ownedStageRemoved: true,
      });
      expect(extendedCase(`windows-buffer-write-${mode}`)?.observations).toEqual({
        route: mode === "off" ? "windows-buffer-legacy" : "windows-buffer-compat",
        renamePolicy: mode === "off" ? "default" : "verify-content-with-lock",
        stableFinalSymlinkPublished: true, aliasPreserved: true,
        refusals: 3, callbacksAfterRefusal: 0, missingDestinationRefusals: 2,
        missingDestinationsAbsentAtCallbacks: true,
        missingDestinationsAbsentAfterRefusal: true, completedStagesObserved: 2,
        destinationPreserved: true, ownedStagesRemoved: true,
      });
    }
  });

  it("binds the executable public seam and phase observations without an ordinal trigger", async () => {
    const helper = await readFile("scripts/mutation-policy-proof-cases.mjs", "utf8");
    const harness = await readFile("scripts/mutation-policy-proof.mjs", "utf8");
    const workflow = await readFile(".github/workflows/mutation-policy-proof.yml", "utf8");
    expect(helper).toContain('import.meta.resolve("@openclaw/fs-safe/test-hooks")');
    expect(helper).toContain('hookUrl.endsWith("/dist/test-hooks.js")');
    expect(helper).toContain("seamCalls === 1 && target === selected");
    expect(helper).toContain("finally { setHooks(); }");
    expect(helper).toContain('symlinkSync(path.basename(protectedDir), allowed, "dir")');
    expect(helper).toContain("readlinkSync(allowed) === path.basename(protectedDir)");
    expect(helper).toContain("realpathSync.native(allowed) === protectedDir");
    expect(helper).not.toContain("symlinkSync(protectedDir, allowed");
    expect(helper).toContain('["first-mkdir", "after-mkdir", "stage", "publication"]');
    expect(helper).toContain("callbackState.refused && callbackState.after === 0");
    expect(helper).toContain("stat.nlink === 1n");
    expect(helper).toContain("fsSync.readFileSync(file).equals(payload)");
    expect(helper).toContain('"DESTINATION_VISIBLE_BEFORE_PUBLICATION"');
    expect(helper).not.toMatch(/if\s*\(\s*(?:calls|state\.calls|authorityCalls)\s*===?\s*\d/u);
    expect(harness).toContain('caseName.startsWith("pinned-policy-") ? { NODE_ENV: "test" }');
    for (const label of ["proofCases", "publicTestHooksSource", "publicTestHooksBuilt",
      "nativeStageSource", "nativeStageBuilt", "writeHandleSource", "writeHandleBuilt",
      "nativeOperationsSource", "nativeOperationsBuilt",
      "stageCleanupSource", "stageCleanupBuilt", "proofCaseContractTests"]) {
      expect(expectedFinalReceiptContract().hashLabels).toContain(label);
    }
    for (const file of ["scripts/mutation-policy-proof-cases.mjs",
      "test/mutation-policy-proof-cases-contract.test.ts", "src/test-hooks.ts",
      "src/native-staged-file.ts", "src/native-operations.ts", "src/write-file-handle.ts", "src/replace-file-temp-owner.ts"]) {
      expect(workflow).toContain(`- ${file}`);
    }
    expect(harness).toContain("RECEIPT_MAX_BYTES = 32 * 1024");
    expect(harness).toContain("WORKER_TIMEOUT_MS = 15_000");
    expect(workflow).toContain("timeout-minutes: 6");
  });
});
