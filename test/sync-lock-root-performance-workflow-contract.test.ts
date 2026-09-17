import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  validateDispatchInputs,
  validateMethodAuditWorkflowPath,
} from "../benchmarks/method-audit-plan.mjs";

async function text(file: string) {
  return (await readFile(file, "utf8")).replace(/\r\n?/gu, "\n");
}

describe("synchronous lockRoot performance workflow contract", () => {
  it("is manual, draft-only, first-attempt, and campaign serialized", async () => {
    const workflow = await text(".github/workflows/sync-lock-root-performance-proof.yml");
    expect(workflow).toContain("on:\n  workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+(?:pull_request|push|schedule):/gmu);
    expect(workflow).toContain("acknowledge_draft:");
    expect(workflow).toContain("selective workflow reruns are forbidden");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("inputs.campaign_id }}-${{ inputs.expected_actions_run_number");
    expect(workflow).toContain("max-parallel: 1");
    expect(workflow).toContain("if: always()\n        uses: actions/upload-artifact@");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("predeclares every hosted OS, Node, order, and independent control", async () => {
    const workflow = await text(".github/workflows/sync-lock-root-performance-proof.yml");
    for (const value of [
      "surface: linux, os: ubuntu-latest",
      "surface: macos, os: macos-15",
      "surface: windows, os: windows-latest",
      'node: ["22", "24"]',
      "order: [abba, baab]",
      "study: [source-comparison, same-source-rebuild, same-artifact]",
      'METHOD_ITERATIONS: "100"',
      'METHOD_SAMPLES: "9"',
      'METHOD_BLOCKS: "5"',
      "METHOD_NATIVE_MODE: off",
      "METHOD_FILTER: syncLockRoot/",
    ]) expect(workflow).toContain(value);
    expect(workflow.match(/5f6ac8cafeb9f301e66b80b3b589dc4ebfd68136/gu)).not.toBeNull();
    expect(workflow).not.toContain("6404191fd6e73bf34bcfacaefe2f113a2b8f6d99");
    expect(workflow).toContain("METHOD_CANDIDATE_REF: ${{ inputs.candidate_ref }}");
    expect(workflow).toContain("METHOD_EXPECTED_HARNESS_SHA: ${{ inputs.expected_harness_sha }}");
    expect(workflow).toContain("METHOD_WORKFLOW_SHA: ${{ github.workflow_sha }}");
    expect(workflow).toContain("run head is not the reviewed harness commit");
    expect(workflow).toContain("METHOD_WORKFLOW_PATH: .github/workflows/sync-lock-root-performance-proof.yml");
    expect(workflow).toContain("expected_crabbox_version:");
    expect(workflow).toContain("SYNC_LOCK_ROOT_CRABBOX_VERSION: ${{ inputs.expected_crabbox_version }}");
    for (const binding of [
      "expected_workflow_database_id:", "expected_workflow_file_sha256:",
      "expected_actions_run_number:", "campaign_initialized_at:",
    ]) expect(workflow).toContain(binding);
    expect(workflow).toContain("predeclared Actions run number was consumed or raced");
    expect(workflow).toContain("run.run_number !== Number(process.env.EXPECTED_ACTIONS_RUN_NUMBER)");
    expect(workflow).toContain("run.repository?.full_name !== \"openclaw/fs-safe\"");
    expect(workflow).toContain("run.workflow_id");
    expect(workflow).toContain("initialized > created");
  });

  it("binds exact source, harness, dependency, report, and artifact identities", async () => {
    const workflow = await text(".github/workflows/sync-lock-root-performance-proof.yml");
    const evidence = await text("benchmarks/method-audit-evidence.mjs");
    const plan = await text("benchmarks/method-audit-plan.mjs");
    const provenance = await text("benchmarks/sync-lock-root-provenance.mjs");
    const hosted = await text("benchmarks/sync-lock-root-hosted-provenance.mjs");
    for (const value of [
      "fetch-depth: 0", "persist-credentials: false", "--expected-plan-file-hash",
      "Snapshot immutable installations", "Finalized exact study receipt",
    ]) {
      if (value === "Finalized exact study receipt") {
        expect(workflow).toContain("Finalize exact study receipt");
      } else {
        expect(workflow).toContain(value);
      }
    }
    expect(plan).toContain("identity mutated during the study");
    expect(evidence).toContain("dependencySnapshot");
    expect(evidence).toContain("runnerOutputReceipt");
    expect(evidence).toContain("workflowPath");
    expect(evidence).toContain('["--no-replace-objects", "-C", root');
    expect(evidence).toContain('GIT_NO_REPLACE_OBJECTS: "1"');
    expect(workflow).toContain('GIT_NO_REPLACE_OBJECTS: "1"');
    expect(workflow).toContain("git --no-replace-objects cat-file blob");
    expect(workflow).toContain("listWorkflowRunArtifacts");
    expect(workflow).toContain("listJobsForWorkflowRunAttempt");
    expect(workflow).toContain("getWorkflowRun");
    expect(workflow).toContain("SYNC_LOCK_ROOT_API_JOB_ID");
    expect(workflow).toContain("SYNC_LOCK_ROOT_API_JOB_STARTED_AT");
    expect(workflow).toContain("producerJobId: job.id");
    expect(workflow).toContain("createdAt: artifact.created_at");
    expect(workflow).toContain("startedAt: upload.started_at");
    expect(workflow).toContain("artifact-ids: ${{ steps.artifacts.outputs.ids }}");
    expect(workflow).toContain("artifact.digest");
    expect(workflow).toContain("job.run_attempt !== runAttempt");
    expect(workflow).toContain("response.data.artifacts.some");
    expect(workflow).not.toContain("download-artifact@v");
    expect(hosted).toContain('assertWindow("artifact creation"');
    expect(provenance).toContain('assertWindow("worker report"');
    expect(hosted).toContain("artifact producer API job ID is not admitted");
    expect(hosted).toContain("campaign state was initialized after the Actions run began");
    expect(provenance).toContain("Crabbox timing syncDelegated has the wrong type");
    expect(provenance).toContain("const syncDelegated = timing.syncDelegated ?? false");
  });

  it("keeps the focused worker out of unrelated benchmark registration", async () => {
    const runner = await text("benchmarks/runner.mjs");
    const worker = await text("benchmarks/sync-lock-root.mjs");
    expect(runner).toContain("args.filter === SYNC_LOCK_ROOT_FILTER");
    expect(runner).toContain("? await registerSyncLockRoot(context) : null");
    expect(runner).toContain('["--no-replace-objects", "rev-parse", "HEAD"]');
    expect(runner).toContain('GIT_NO_REPLACE_OBJECTS: "1"');
    expect(worker).toContain("dedicated sync lockRoot worker requires --filter");
    expect(worker).toContain("assertNoHeldLocks(\"worker startup\")");
    expect(worker).toContain("assertNoHeldLocks(\"worker cleanup\")");
    expect(worker).not.toContain("process._getActiveHandles");
  });

  it("admits only the two reviewed method-audit workflow paths", () => {
    expect(validateMethodAuditWorkflowPath(".github/workflows/benchmarks.yml"))
      .toBe(".github/workflows/benchmarks.yml");
    expect(validateMethodAuditWorkflowPath(
      ".github/workflows/sync-lock-root-performance-proof.yml",
    )).toBe(".github/workflows/sync-lock-root-performance-proof.yml");
    for (const rejected of ["../workflow.yml", ".github/workflows/ci.yml", ""]) {
      expect(() => validateMethodAuditWorkflowPath(rejected)).toThrow();
    }
    expect(validateDispatchInputs({ platform: "wsl2" }).platform).toBe("wsl2");
  });

  it("requires all hosted artifacts but never calls them full release clearance", async () => {
    const workflow = await text(".github/workflows/sync-lock-root-performance-proof.yml");
    const analyzer = await text("benchmarks/sync-lock-root-analysis.mjs");
    expect(workflow).toContain('--surfaces "linux,macos,windows"');
    expect(workflow).toContain("Analyze complete hosted cohort (not WSL2 clearance)");
    expect(workflow).toContain("Upload non-clearance hosted analysis");
    expect(analyzer).toContain("releaseClearance: complete &&");
    expect(analyzer).toContain("ALL_SURFACES.every");
    expect(analyzer).toContain("sourceFailures");
    expect(analyzer).toContain("controlFailures");
    expect(analyzer).not.toMatch(/subtract|exclude|cancel(?:led|lation)?/iu);
  });
});

describe("synchronous lockRoot WSL2 Crabbox lane contract", () => {
  it("retains the outer wrapper receipt and derives attribution only from Crabbox output", async () => {
    const capture = await text("benchmarks/sync-lock-root-crabbox-capture-wsl2.sh");
    const finalizer = await text("benchmarks/sync-lock-root-crabbox-capture.mjs");
    const integrity = await text("benchmarks/sync-lock-root-harness-integrity.mjs");
    const lane = await text("benchmarks/sync-lock-root-crabbox-wsl2.sh");
    const provenance = await text("benchmarks/sync-lock-root-provenance.mjs");
    const attributes = await text(".gitattributes");
    expect(capture).toContain("crabbox run --provider ssh --target windows --windows-mode wsl2");
    expect(capture).toContain('--timing-json --capture-stdout "$archive"');
    expect(capture).toContain('>"$timing" 2>"$wrapper_log"');
    expect(capture).toContain("wrapperExitCode");
    expect(capture).toContain("validationExitCode");
    expect(capture).toContain("extractionExitCode");
    expect(capture).toContain("sync-lock-root-tar.mjs");
    expect(capture).toContain("--no-same-owner --no-same-permissions");
    expect(capture).toContain("umask 077");
    expect(capture).toContain("export GIT_NO_REPLACE_OBJECTS=1");
    expect(capture).toContain("command git --no-replace-objects");
    expect(capture).toContain('trusted_git -C "$repo_root" rev-parse HEAD');
    expect(capture).toContain("outer capture must execute the private immutable campaign launcher");
    expect(capture).toContain('hash-object --no-filters -- "$launcher_path"');
    expect(capture).toContain('trusted_git -C "$repo_root" ls-tree -r --name-only');
    expect(capture).toContain('trusted_git -C "$repo_root" cat-file blob');
    expect(capture).not.toContain("git status");
    expect(capture).not.toContain("--provider)");
    expect(capture).not.toContain("--id)");
    expect(finalizer).toContain("normalizeCrabboxTiming(readJson(options.timing))");
    expect(finalizer).toContain("remoteFileManifest(options.remote)");
    expect(finalizer).toContain("accepted: false");
    expect(finalizer).toContain("validateImmutableHarness");
    expect(integrity).toContain('"cat-file", "blob"');
    expect(integrity).toContain('"ls-tree", "-r", "--name-only"');
    expect(integrity).toContain('"--no-replace-objects", "-C"');
    expect(integrity).toContain('GIT_NO_REPLACE_OBJECTS: "1"');
    expect(integrity).toContain("executed capture launcher differs from reviewed blob");
    expect(lane).toContain("native WSL2 kernel was not observed");
    expect(lane).not.toContain("--provider)");
    expect(lane).not.toContain("--id)");
    expect(lane).not.toContain("--run-id)");
    expect(lane).not.toContain("--sync-delegated)");
    expect(lane).toContain('[[ "$actual_node" == "$node_major" ]]');
    expect(lane).toContain("wsl2-remote-receipt-node-$node_major.json");
    expect(lane).toContain("laneScriptSha256");
    expect(lane).toContain("executed WSL2 lane differs from the reviewed immutable blob");
    expect(lane).toContain("export GIT_NO_REPLACE_OBJECTS=1");
    expect(lane).toContain("command git --no-replace-objects");
    expect(lane).toContain("hash-object --no-filters");
    expect(lane).toContain("filesystemDevice");
    expect(lane).toContain("identityHash");
    expect(lane).toContain('export TMPDIR="$temp_root"');
    expect(lane).toContain("Node did not select the pinned worker temp root");
    expect(lane).toContain("tempStatfsType");
    expect(provenance).toContain("WSL2 lane script hash mismatch");
    expect(provenance).toContain("WSL2 captures overlap or were selectively reordered");
    expect(provenance).toContain('for (const field of ["provider", "id", "syncDelegated"])');
    expect(attributes).toContain("benchmarks/sync-lock-root-crabbox-wsl2.sh text eol=lf");
    expect(attributes).toContain("benchmarks/sync-lock-root-crabbox-capture-wsl2.sh text eol=lf");
  });

  it("runs both balanced orders and all controls without substitution or selective reruns", async () => {
    const lane = await text("benchmarks/sync-lock-root-crabbox-wsl2.sh");
    expect(lane).toContain("for order in abba baab");
    expect(lane).toContain("for study in source-comparison same-source-rebuild same-artifact");
    expect(lane).toContain('export GITHUB_RUN_ATTEMPT="1"');
    expect(lane).toContain('export METHOD_BLOCKS="5"');
    expect(lane).toContain('export METHOD_SAMPLES="9"');
    expect(lane).toContain('export METHOD_MATRIX_PLATFORM="wsl2"');
    expect(lane).toContain('tar --format=ustar -C "$output_root" -czf - . >&3');
    expect(lane).not.toMatch(/skip|fallback|retry/iu);
  });

  it("shares predeclared single-use campaign bindings with the hosted run", async () => {
    const workflow = await text(".github/workflows/sync-lock-root-performance-proof.yml");
    const capture = await text("benchmarks/sync-lock-root-crabbox-capture-wsl2.sh");
    for (const binding of [
      "campaign_id", "wsl2_node_22_capture", "wsl2_node_24_capture", "expected_crabbox_version",
      "expected_workflow_database_id", "expected_workflow_file_sha256",
      "expected_actions_run_number", "campaign_initialized_at",
    ]) {
      expect(workflow).toContain(`${binding}:`);
    }
    expect(workflow).toContain("campaign bindings must be distinct");
    expect(capture).toContain('mkdir -m 700 "$capture_directory"');
    expect(capture).toContain('--campaign-id "$campaign_id"');
    expect(capture).toContain('--node-22-capture "$node22_capture"');
    expect(capture).toContain('--node-24-capture "$node24_capture"');
    expect(capture).toContain('mode="initialize"');
    expect(capture).toContain("sync-lock-root-campaign-state.mjs consume");
    expect(capture.indexOf("sync-lock-root-campaign-state.mjs consume"))
      .toBeLessThan(capture.indexOf("crabbox run --provider ssh"));
    expect(capture).toContain("campaign capture token was already consumed");
    expect(capture).toContain('state_root="$repo_root/artifacts-sync-lock-root-state-v1"');
  });
});
