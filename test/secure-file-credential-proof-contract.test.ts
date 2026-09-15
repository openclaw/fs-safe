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

function workflowJob(workflow: string): string {
  const match = workflow.match(
    /^  secure-file-credential-proof:\n(?<body>[\s\S]*?)(?=^  [a-z][a-z0-9-]+:\n)/mu,
  );
  expect(match?.groups?.body).toBeDefined();
  return match!.groups!.body!;
}

describe("manual split-credential secure-file proof contract", () => {
  it("normalizes CRLF and lone carriage returns before structural matching", () => {
    expect(normalizeSource("first\r\nsecond\rthird\n")).toBe("first\nsecond\nthird\n");
  });

  it("is opt-in only and leaves ordinary CI events independent of the proof", async () => {
    const { workflow } = await sources();
    expect(workflow).toMatch(
      /workflow_dispatch:\n\s+inputs:\n\s+secure_file_credential_proof:\n(?:\s+[^\n]+\n)*?\s+default:\s+false\n\s+type:\s+boolean/u,
    );
    const job = workflowJob(workflow);
    expect(job).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.secure_file_credential_proof == true",
    );
    expect(job).toMatch(/node:\n\s+- 22\.23\.2\n\s+- 24\.20\.0/u);
    expect(job).not.toMatch(/pull_request|push:/u);
  });

  it("builds both revisions unprivileged and pins the audit-only baseline", async () => {
    const { coordinator, workflow } = await sources();
    const job = workflowJob(workflow);
    expect(job.match(/test "\$\(id -u\)" -ne 0/gu)).toHaveLength(2);
    expect(job).toContain(`git worktree add --detach "$BASELINE_DIR" ${BASE_HEAD}`);
    expect(job).toContain(`show -s --format=%T HEAD)\" = ${BASE_TREE}`);
    expect(coordinator).toContain(`const BASE_HEAD = "${BASE_HEAD}"`);
    expect(coordinator).toContain(`const BASE_TREE = "${BASE_TREE}"`);
    expect(coordinator).toContain("role: \"historical-negative-control\"");
    expect(coordinator).toContain("auditOnly: true");
  });

  it("uses only argument-array process creation and a bounded root-owned trace", async () => {
    const { coordinator } = await sources();
    expect(coordinator).toContain("import { spawn } from \"node:child_process\"");
    expect(coordinator).not.toMatch(/\bexec(?:File|Sync)?\s*\(/u);
    expect(coordinator).not.toContain("shell: true");
    expect(coordinator).toContain("shell: false");
    expect(coordinator).toContain("options.requireRoot === true");
    expect(coordinator).toContain("toolReceipts.strace.runsAsRoot = true");
    expect(coordinator).toContain('["node", false], ["prlimit", true], ["setpriv", true]');
    expect(coordinator).toContain("\"30s\"");
    expect(coordinator).toContain("--kill-after=5s");
    expect(coordinator).toMatch(
      /"30s",\n\s+tools\.prlimit\.path,\n\s+"--fsize=1048576:1048576",\n\s+"--core=0:0",\n\s+"--",\n\s+tools\.strace\.path,/u,
    );
    expect(coordinator).toContain("toolReceipts.prlimit.appliesToStraceAndWorker = true");
    expect(coordinator).toContain("traceStat.size >= BigInt(MAX_TRACE_BYTES)");
    expect(coordinator).toContain('proofError("TRACE_SIZE_LIMIT_REACHED")');
    expect(coordinator).toContain("--trace-path=${secret.path}");
    expect(coordinator).toContain(
      "--trace=open,openat,openat2,read,readv,pread64,preadv,preadv2,mmap,sendfile,copy_file_range,splice,close",
    );
  });

  it("proves all credential directions and the unbounded rejection repeat", async () => {
    const { coordinator } = await sources();
    expect(coordinator).toContain("const REAL_UID = 61001");
    expect(coordinator).toContain("const EFFECTIVE_UID = 61002");
    expect(coordinator).toContain("const PROOF_GID = 61003");
    expect(coordinator.match(/case: "equal-owner"/gu)).toHaveLength(2);
    expect(coordinator.match(/case: "split-effective-owner"/gu)).toHaveLength(2);
    expect(coordinator.match(/case: "split-real-owner-bounded"/gu)).toHaveLength(2);
    expect(coordinator.match(/case: "split-real-owner-unbounded"/gu)).toHaveLength(1);
    for (const flag of [
      "--ruid", "--euid", "--rgid", "--egid", "--clear-groups", "--inh-caps=-all",
      "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs",
    ]) {
      expect(coordinator).toContain(`\"${flag}\"`);
    }
  });

  it("loads public exports with native disabled and validates Linux credentials twice", async () => {
    const { worker } = await sources();
    expect(worker).toContain('import("@openclaw/fs-safe/config")');
    expect(worker).toContain('import("@openclaw/fs-safe/secure-file")');
    expect(worker).toContain('configureFsSafeNative({ mode: "off" })');
    expect(worker).toContain('fs.readFile("/proc/self/status", "utf8")');
    expect(worker).toContain("status.uids[2] === expectedUids[2]");
    expect(worker).toContain("status.uids[3] === expectedUids[3]");
    expect(worker).toContain("status.groups.length === 0");
    expect(worker).toContain("status.capsZero");
    expect(worker).toContain("status.noNewPrivs");
    expect(worker).not.toMatch(/(?:mock|vi\.)/u);
    expect(worker).not.toMatch(/\.\.\/src|\.\.\/dist/u);
  });

  it("fails incomplete syscall evidence and uploads only the allowlisted JSON receipt", async () => {
    const { coordinator, workflow } = await sources();
    expect(coordinator).toContain("successfulOpen !== 1 || successfulClose !== 1");
    expect(coordinator).toContain("!apiRead && !traceReadAttempted && !tracePositiveBytes");
    expect(coordinator).toContain("apiRead && traceReadAttempted && tracePositiveBytes");
    expect(coordinator).toContain("await fs.unlink(tracePath)");
    expect(coordinator).toContain("receiptAllowlisted: true");
    expect(coordinator).toContain("rawArtifactsUploaded: false");
    const upload = workflowJob(workflow).match(
      /- name: Upload allowlisted credential receipt\n(?<body>[\s\S]*?)$/u,
    )?.groups?.body;
    expect(upload).toBeDefined();
    expect(upload).toContain("path: ${{ env.RECEIPT_PATH }}");
    expect(upload).not.toMatch(/trace|stack|\.log|dist\//u);
  });

  it("creates a fixed failed receipt without overwriting and still runs upload", async () => {
    const { workflow } = await sources();
    const job = workflowJob(workflow);
    const fallbackStart = job.indexOf("- name: Create failed proof receipt when missing");
    const uploadStart = job.indexOf("- name: Upload allowlisted credential receipt");
    expect(fallbackStart).toBeGreaterThan(-1);
    expect(uploadStart).toBeGreaterThan(fallbackStart);
    const fallback = job.slice(fallbackStart, uploadStart);
    expect(fallback).toContain("if: always()");
    expect(fallback).toContain('if [[ -e "$RECEIPT_PATH" || -L "$RECEIPT_PATH" ]]');
    expect(fallback).toContain("set -o noclobber");
    expect(fallback).toContain(
      '{"schema":1,"proof":"secure-file-split-credential","overall":false,"failure":{"stage":"workflow-fallback","name":"ProofError","code":"RECEIPT_MISSING"},"workflow":{"fallback":true,"receiptAllowlisted":true}}',
    );
    expect(fallback).toMatch(/chmod 0644 "\$RECEIPT_PATH"\n\s+exit 1/u);
    expect(job.slice(uploadStart)).toContain("if: always()");
    expect(job).not.toContain("continue-on-error");
    expect(job).toContain('prlimit_path=$(realpath "$(command -v prlimit)")');
    expect(job).toContain('--prlimit "$prlimit_path"');
  });
});
