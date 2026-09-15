import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const BASE_HEAD = "914cd7b41388876b55e1cca76b46b8eb01e46364";
const BASE_TREE = "eb1d05638cd0ec21cea68a8b189ec3e253a8d903";

let sourcePromise: Promise<{ coordinator: string; worker: string; workflow: string }> | undefined;

function normalizeSource(source: string): string {
  return source.replace(/\r\n?/gu, "\n");
}

function sources(): Promise<{ coordinator: string; worker: string; workflow: string }> {
  sourcePromise ??= Promise.all([
    readFile("scripts/secure-file-credential-proof.mjs", "utf8"),
    readFile("scripts/secure-file-credential-proof-worker.mjs", "utf8"),
    readFile(".github/workflows/ci.yml", "utf8"),
  ]).then(([coordinator, worker, workflow]) => ({
    coordinator: normalizeSource(coordinator),
    worker: normalizeSource(worker),
    workflow: normalizeSource(workflow),
  }));
  return sourcePromise;
}

function workflowJob(workflow: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = workflow.match(
    new RegExp(`^  ${escaped}:\\n(?<body>[\\s\\S]*?)(?=^  [a-z][a-z0-9-]+:\\n)`, "mu"),
  );
  expect(match?.groups?.body).toBeDefined();
  return match!.groups!.body!;
}

describe("manual split-credential secure-file proof contract", () => {
  it("normalizes CRLF and lone carriage returns before structural matching", () => {
    expect(normalizeSource("first\r\nsecond\rthird\n")).toBe("first\nsecond\nthird\n");
  });

  it("keeps three opt-in jobs and the exact supported-runtime proof matrix", async () => {
    const { workflow } = await sources();
    expect(workflow).toMatch(
      /workflow_dispatch:\n\s+inputs:\n\s+secure_file_credential_proof:\n(?:\s+[^\n]+\n)*?\s+default:\s+false\n\s+type:\s+boolean/u,
    );
    for (const name of [
      "secure-file-credential-candidate-build",
      "secure-file-credential-historical-build",
      "secure-file-credential-proof",
    ]) {
      const job = workflowJob(workflow, name);
      expect(job).toContain("inputs.secure_file_credential_proof == true");
      expect(job).toMatch(/node:\n\s+- 22\.23\.2\n\s+- 24\.20\.0/u);
    }
    const proof = workflowJob(workflow, "secure-file-credential-proof");
    expect(proof).toContain("- secure-file-credential-candidate-build");
    expect(proof).toContain("- secure-file-credential-historical-build");
  });

  it("builds candidate and historical bundles on separate unprivileged runners", async () => {
    const { workflow } = await sources();
    const candidate = workflowJob(workflow, "secure-file-credential-candidate-build");
    const historical = workflowJob(workflow, "secure-file-credential-historical-build");
    const proof = workflowJob(workflow, "secure-file-credential-proof");
    expect(candidate).toContain("ref: ${{ github.sha }}");
    expect(historical).toContain(`ref: ${BASE_HEAD}`);
    expect(candidate).toContain('test "$(/usr/bin/id -u)" -ne 0');
    expect(historical).toContain('test "$(/usr/bin/id -u)" -ne 0');
    expect(candidate).toContain("pnpm build");
    expect(historical).toContain("pnpm build");
    expect(historical).toContain(`show -s --format=%T HEAD)\" = ${BASE_TREE}`);
    expect(proof).not.toMatch(/\bpnpm\b|rustup|npm install|pnpm install|pnpm build/u);
    expect(proof).not.toContain("cache: pnpm");
  });

  it("uploads only bounded package and dist bundles with strict provenance", async () => {
    const { coordinator, workflow } = await sources();
    for (const name of [
      "secure-file-credential-candidate-build",
      "secure-file-credential-historical-build",
    ]) {
      const job = workflowJob(workflow, name);
      expect(job).toContain("-mindepth 33");
      expect(job).toContain("-type f -links +1");
      expect(job).toContain('test "$file_count" -le 4096');
      expect(job).toContain('test "$entry_count" -le 8192');
      expect(job).toContain('test "$byte_count" -le 134217728');
      expect(job).toContain('allowedTopLevel\\\":[\\\"dist\\\",\\\"package.json\\\",\\\"provenance.json\\\"]');
      expect(job).not.toMatch(/scripts\/secure-file-credential-proof|\.github\/workflows/u);
      expect(job).toContain("artifact-id");
      expect(job).toContain("artifact-digest");
    }
    expect(coordinator).toContain("MAX_PACKAGE_FILES = 4096");
    expect(coordinator).toContain("MAX_PACKAGE_ENTRIES = 8192");
    expect(coordinator).toContain("MAX_PACKAGE_DEPTH = 32");
    expect(coordinator).toContain('proofError("UNEXPECTED_BUNDLE_ENTRY"');
    expect(coordinator).toContain('proofError("BUNDLE_PROVENANCE_MISMATCH"');
    expect(coordinator).toContain('proofError("UNTRUSTED_SOURCE_SYMLINK"');
    expect(coordinator).toContain("stat.nlink !== 1n");
  });

  it("selects exact bundle artifacts from bounded current-run API metadata", async () => {
    const { coordinator, workflow } = await sources();
    const proof = workflowJob(workflow, "secure-file-credential-proof");
    expect(proof).toContain("actions: read");
    expect(proof).toContain("contents: read");
    expect(proof).toContain(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    expect(proof).toContain("github.rest.actions.listWorkflowRunArtifacts");
    expect(proof).toContain("run_id: runId");
    expect(proof).toContain("per_page: 100");
    expect(proof).toContain("data.total_count > 100");
    expect(proof).toContain("data.artifacts.length !== data.total_count");
    expect(proof).toContain("artifact.name === name");
    expect(proof).toContain("artifact.workflow_run?.id !== runId");
    expect(proof).toContain("artifact.workflow_run?.head_sha !== expectedHead");
    expect(proof).toContain("artifact.expired !== false");
    expect(proof).toContain("artifact.id < 1");
    expect(proof).toContain("artifact.size_in_bytes > 157286400");
    expect(proof).toContain("/^sha256:([0-9a-f]{64})$/u");
    expect(proof).toContain('core.setOutput(`${outputPrefix}_id`, String(artifact.id))');
    expect(proof).toContain('core.setOutput(`${outputPrefix}_digest`, digestMatch[1])');
    expect(proof).toContain('core.setOutput(`${outputPrefix}_name`, artifact.name)');
    expect(proof).toContain(
      'core.setOutput(`${outputPrefix}_run_id`, String(artifact.workflow_run.id))',
    );
    expect(proof).toContain("`secure-file-candidate-node-${nodeVersion}`");
    expect(proof).toContain("`secure-file-historical-node-${nodeVersion}`");
    expect(proof).toContain(
      "artifact-ids: ${{ steps.artifact-metadata.outputs.candidate_id }}",
    );
    expect(proof).toContain(
      "artifact-ids: ${{ steps.artifact-metadata.outputs.historical_id }}",
    );
    expect(proof).not.toContain("steps.artifact-identity.outputs");
    expect(proof.match(/actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/gu)).toHaveLength(4);
    for (const token of [
      "artifactName",
      "artifactId",
      "artifactDigest",
      "runId",
      "runAttempt",
      "candidate-artifact-id",
      "historical-artifact-id",
    ]) {
      expect(coordinator).toContain(token);
    }
    expect(coordinator).toContain(`const BASE_HEAD = "${BASE_HEAD}"`);
    expect(coordinator).toContain(`const BASE_TREE = "${BASE_TREE}"`);
    expect(coordinator).toContain('role: "historical-negative-control"');
    expect(coordinator).toContain("selectedByArtifactId: true");
  });

  it("matches both builder attestations to independently selected ids and digests", async () => {
    const { workflow } = await sources();
    const proof = workflowJob(workflow, "secure-file-credential-proof");
    for (const mismatch of [
      "candidate-id-mismatch",
      "candidate-digest-mismatch",
      "candidate-name-mismatch",
      "candidate-run-mismatch",
      "historical-id-mismatch",
      "historical-digest-mismatch",
      "historical-name-mismatch",
      "historical-run-mismatch",
    ]) {
      expect(proof).toContain(`attestation_failure ${mismatch}`);
    }
    expect(proof).toContain('[[ "$candidate_id" = "$API_CANDIDATE_ID" ]]');
    expect(proof).toContain('[[ "$candidate_digest" = "$API_CANDIDATE_DIGEST" ]]');
    expect(proof).toContain('[[ "$candidate_name" = "$API_CANDIDATE_NAME" ]]');
    expect(proof).toContain('[[ "$candidate_run_id" = "$API_CANDIDATE_RUN_ID" ]]');
    expect(proof).toContain('[[ "$historical_id" = "$API_HISTORICAL_ID" ]]');
    expect(proof).toContain('[[ "$historical_digest" = "$API_HISTORICAL_DIGEST" ]]');
    expect(proof).toContain('[[ "$historical_name" = "$API_HISTORICAL_NAME" ]]');
    expect(proof).toContain('[[ "$historical_run_id" = "$API_HISTORICAL_RUN_ID" ]]');
  });

  it("creates the uploadable failure receipt before every other proof step", async () => {
    const { workflow } = await sources();
    const proof = workflowJob(workflow, "secure-file-credential-proof");
    const stepsStart = proof.indexOf("    steps:\n");
    const initializeStart = proof.indexOf("      - name: Initialize allowlisted failure receipt\n");
    const gateStart = proof.indexOf("      - name: Require successful isolated builds\n");
    expect(initializeStart).toBe(stepsStart + "    steps:\n".length);
    expect(gateStart).toBeGreaterThan(initializeStart);
    const initialize = proof.slice(initializeStart, gateStart);
    expect(initialize).toContain("set -o noclobber");
    expect(initialize).toContain('"overall":false');
    expect(initialize).toContain('"code":"PROOF_NOT_STARTED"');
    expect(initialize).toContain('>> "$GITHUB_ENV"');
  });

  it("requires both isolated build matrices to succeed before artifact processing", async () => {
    const { workflow } = await sources();
    const proof = workflowJob(workflow, "secure-file-credential-proof");
    const initializeStart = proof.indexOf("      - name: Initialize allowlisted failure receipt\n");
    const gateStart = proof.indexOf("      - name: Require successful isolated builds\n");
    const metadataStart = proof.indexOf(
      "      - name: Resolve bounded artifact metadata from the workflow run API\n",
    );
    const attestationStart = proof.indexOf("      - name: Download candidate artifact identity\n");
    const stageStart = proof.indexOf("      - name: Stage trusted proof harness and executables under opt\n");
    const rootProofStart = proof.indexOf(
      "      - name: Prove split real and effective credential behavior\n",
    );
    const fallbackStart = proof.indexOf("      - name: Create failed proof receipt when missing\n");
    expect(proof).toContain("if: always()");
    expect(gateStart).toBeGreaterThan(initializeStart);
    expect(metadataStart).toBeGreaterThan(gateStart);
    expect(attestationStart).toBeGreaterThan(gateStart);
    expect(stageStart).toBeGreaterThan(gateStart);
    const gate = proof.slice(gateStart, metadataStart);
    expect(gate).toContain("${{ needs['secure-file-credential-candidate-build'].result }}");
    expect(gate).toContain("${{ needs['secure-file-credential-historical-build'].result }}");
    expect(gate).toContain('test "$CANDIDATE_BUILD_RESULT" = success');
    expect(gate).toContain('test "$HISTORICAL_BUILD_RESULT" = success');
    expect(proof.slice(rootProofStart, fallbackStart)).not.toContain("if: always()");
    expect(proof).toMatch(/- name: Create failed proof receipt when missing\n\s+if: always\(\)/u);
    expect(proof).toMatch(/- name: Upload allowlisted credential receipt\n\s+if: always\(\)/u);
  });

  it("bounds and validates each attestation before the first shell read", async () => {
    const { workflow } = await sources();
    const proof = workflowJob(workflow, "secure-file-credential-proof");
    const validationStart = proof.indexOf(
      "      - name: Validate attestations against API artifact metadata\n",
    );
    const bundleDownloadStart = proof.indexOf("      - name: Download exact candidate bundle artifact\n");
    const validation = proof.slice(validationStart, bundleDownloadStart);
    const candidateValidation = validation.indexOf(
      'validate_attestation_file "$CANDIDATE_ATTESTATION" candidate',
    );
    const candidateRead = validation.indexOf(
      'IFS= read -r candidate_line < "$CANDIDATE_ATTESTATION"',
    );
    const historicalValidation = validation.indexOf(
      'validate_attestation_file "$HISTORICAL_ATTESTATION" historical',
    );
    const historicalRead = validation.indexOf(
      'IFS= read -r historical_line < "$HISTORICAL_ATTESTATION"',
    );
    expect(candidateValidation).toBeGreaterThan(-1);
    expect(candidateRead).toBeGreaterThan(candidateValidation);
    expect(historicalValidation).toBeGreaterThan(-1);
    expect(historicalRead).toBeGreaterThan(historicalValidation);
    expect(validation).toContain('[[ ! -L "$file" ]]');
    expect(validation).toContain('[[ -f "$file" ]]');
    expect(validation).toContain("/usr/bin/stat -c %F");
    expect(validation).toContain("/usr/bin/stat -c %h");
    expect(validation).toContain("/usr/bin/stat -c %s");
    expect(validation).toContain("file_size <= 16384");
    expect(validation).toContain("/usr/bin/od -An -v -t u1");
    expect(validation).toContain("newlines == 1");
    expect(validation).toContain("last == 10");
    expect(validation).toContain("nul == 0");
  });

  it("runs the reviewed harness and copied setup-node executable from locked opt", async () => {
    const { coordinator, workflow } = await sources();
    const proof = workflowJob(workflow, "secure-file-credential-proof");
    expect(proof).toContain("STAGE_ROOT: /opt/fs-safe-credential-proof-");
    expect(proof).toContain('test "$(/usr/bin/realpath /opt)" = /opt');
    expect(proof).toContain("source_node=$(/usr/bin/realpath");
    expect(proof).toContain('sudo /usr/bin/install -o 0 -g 0 -m 0555');
    expect(proof).toContain('sudo /usr/bin/install -o 0 -g 0 -m 0444');
    expect(proof).toContain('sudo /usr/bin/chmod 0555 "$STAGE_ROOT"');
    expect(proof).toContain('sudo -- "$STAGE_ROOT/env" -i');
    expect(proof).toContain('"$STAGE_ROOT/node" "$STAGE_ROOT/coordinator"');
    expect(coordinator).toContain('fileURLToPath(import.meta.url) !== args.coordinator');
    expect(coordinator).toContain("processExecutable !== args.node");
    expect(coordinator).toContain("entry.sourceSha256 !== entry.copySha256");
    expect(coordinator).toContain('proofError("TOOL_IDENTITY_CHANGED"');
  });

  it("rejects owner, mode, ancestor, link, identity, hash, version, and execPath defects", async () => {
    const { coordinator } = await sources();
    for (const code of [
      "UNTRUSTED_TOOL_ANCESTOR",
      "UNTRUSTED_TOOL",
      "NONCANONICAL_TOOL_PATH",
      "STAGE_HASH_MISMATCH",
      "TOOL_VERSION_FAILED",
      "TOOL_IDENTITY_CHANGED",
      "NODE_EXECUTABLE_MISMATCH",
      "NODE_VERSION_MISMATCH",
    ]) {
      expect(coordinator).toContain(`proofError("${code}"`);
    }
    expect(coordinator).toContain("stat.nlink !== 1n");
    expect(coordinator).toContain("(stat.mode & 0o022n) !== 0n");
    expect(coordinator).toContain("(stat.mode & 0o7000n) !== 0n");
    expect(coordinator).toContain("stat.uid !== 0n");
    expect(coordinator).toContain("stat.gid !== 0n");
  });

  it("clears loader injection and validates every resolved shared dependency", async () => {
    const { coordinator } = await sources();
    expect(coordinator).toContain('["HOME", "LANG", "LC_ALL", "PATH", "TZ"]');
    expect(coordinator).toContain('name.startsWith("LD_")');
    expect(coordinator).toContain('stableReadFile("/etc/ld.so.preload"');
    expect(coordinator).toContain('proofError("LD_PRELOAD_CONFIGURED"');
    expect(coordinator).toContain("validateDynamicDependencies");
    expect(coordinator).toContain('proofError("DEPENDENCY_NOT_FOUND"');
    expect(coordinator).toContain('proofError("UNTRUSTED_DEPENDENCY"');
    expect(coordinator).toContain("manifestSha256");
  });

  it("rejects harness and artifact defects before creating the root fixture", async () => {
    const { coordinator } = await sources();
    const harnessStage = coordinator.indexOf('stage = "staged-harness-and-tools"');
    const artifactStage = coordinator.indexOf('stage = "artifact-attestations"');
    const bundleStage = coordinator.indexOf('stage = "artifact-bundles"');
    const fixtureStage = coordinator.indexOf('stage = "fixture-create"');
    expect(harnessStage).toBeGreaterThan(-1);
    expect(artifactStage).toBeGreaterThan(harnessStage);
    expect(bundleStage).toBeGreaterThan(artifactStage);
    expect(fixtureStage).toBeGreaterThan(bundleStage);
    for (const code of [
      "INVALID_STAGE_MANIFEST",
      "UNEXPECTED_HARNESS_SOURCE",
      "ARTIFACT_IDENTITY_MISMATCH",
      "BUNDLE_PROVENANCE_MISMATCH",
      "UNEXPECTED_BUNDLE_ENTRY",
      "EXECUTABLE_ARTIFACT_REJECTED",
      "UNTRUSTED_SOURCE_SYMLINK",
      "UNTRUSTED_SOURCE_ENTRY",
    ]) {
      expect(coordinator).toContain(`proofError("${code}"`);
    }
  });

  it("retains all seven credential cases and bounded root trace execution", async () => {
    const { coordinator } = await sources();
    expect(coordinator).toContain("const REAL_UID = 61001");
    expect(coordinator).toContain("const EFFECTIVE_UID = 61002");
    expect(coordinator).toContain("const PROOF_GID = 61003");
    expect(coordinator.match(/case: "equal-owner"/gu)).toHaveLength(2);
    expect(coordinator.match(/case: "split-effective-owner"/gu)).toHaveLength(2);
    expect(coordinator.match(/case: "split-real-owner-bounded"/gu)).toHaveLength(2);
    expect(coordinator.match(/case: "split-real-owner-unbounded"/gu)).toHaveLength(1);
    expect(coordinator).toContain("import { spawn } from \"node:child_process\"");
    expect(coordinator).not.toMatch(/\bexec(?:File|Sync)?\s*\(/u);
    expect(coordinator).not.toContain("shell: true");
    expect(coordinator).toContain("shell: false");
    expect(coordinator).toContain('"--fsize=1048576:1048576"');
    expect(coordinator).toContain('"--core=0:0"');
    expect(coordinator).toContain('"30s"');
    expect(coordinator).toContain("--kill-after=5s");
    expect(coordinator).toContain('proofError("TRACE_SIZE_LIMIT_REACHED"');
  });

  it("loads only public exports with native disabled and validates Linux credentials", async () => {
    const { worker } = await sources();
    expect(worker).toContain('import("@openclaw/fs-safe/config")');
    expect(worker).toContain('import("@openclaw/fs-safe/secure-file")');
    expect(worker).toContain('configureFsSafeNative({ mode: "off" })');
    expect(worker).toContain('fs.readFile("/proc/self/status", "utf8")');
    expect(worker).toContain("status.uids[2] === expectedUids[2]");
    expect(worker).toContain("status.uids[3] === expectedUids[3]");
    expect(worker).toContain("status.groups.length === 0");
    expect(worker).not.toMatch(/(?:mock|vi\.)/u);
    expect(worker).not.toMatch(/\.\.\/src|\.\.\/dist/u);
  });

  it("emits bounded diagnostics, provenance, durations, and only the JSON receipt", async () => {
    const { coordinator, workflow } = await sources();
    expect(coordinator).toContain("MAX_DIAGNOSTIC_FIELDS = 8");
    expect(coordinator).toContain("runnerImageVersion");
    expect(coordinator).toContain("osRelease");
    expect(coordinator).toContain("durationsMs");
    expect(coordinator).toContain("sourceSha256");
    expect(coordinator).toContain("copySha256");
    expect(coordinator).toContain("receiptAllowlisted: true");
    expect(coordinator).toContain("rawArtifactsUploaded: false");
    const proof = workflowJob(workflow, "secure-file-credential-proof");
    const upload = proof.match(
      /- name: Upload allowlisted credential receipt\n(?<body>[\s\S]*?)$/u,
    )?.groups?.body;
    expect(upload).toBeDefined();
    expect(upload).toContain("path: ${{ env.RECEIPT_PATH }}");
    expect(upload).not.toMatch(/trace|stack|\.log|dist\//u);
  });
});
