import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  atomicReplaceReceipt,
  canonicalReceipt,
  earlyRejectionContractReceipt,
  preservePendingReceipt,
  sanitizeProofFailure,
  timeoutContractReceipt,
  validatePullRequestMergeBinding,
} from "../scripts/file-handle-transfer-proof.mjs";
import { copyFileHandle } from "../src/advanced.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

const proofSource = fs.readFileSync(
  new URL("../scripts/file-handle-transfer-proof.mjs", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");
const workflow = fs.readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("hosted file-handle transfer proof contract", () => {
  it("binds pull-request checkouts to GITHUB_SHA and exactly ordered event parents", () => {
    const baseCommit = "1".repeat(40);
    const headCommit = "2".repeat(40);
    const eventSha = "3".repeat(40);
    const valid = {
      baseCommit,
      checkoutCommit: eventSha,
      eventSha,
      headCommit,
      parentCommits: [baseCommit, headCommit],
    };

    expect(validatePullRequestMergeBinding(valid)).toEqual({
      baseCommit,
      checkoutCommit: eventSha,
      headCommit,
      mergeCommit: eventSha,
      parentCommits: [baseCommit, headCommit],
    });
    expect(validatePullRequestMergeBinding({
      ...valid,
      mergeCommitFromPayload: undefined,
    } as typeof valid)).toEqual(expect.objectContaining({ mergeCommit: eventSha }));
    expect(validatePullRequestMergeBinding({
      ...valid,
      mergeCommitFromPayload: "4".repeat(40),
    } as typeof valid)).toEqual(expect.objectContaining({ mergeCommit: eventSha }));

    for (const invalid of [
      { ...valid, eventSha: undefined },
      { ...valid, eventSha: "not-a-commit" },
      { ...valid, checkoutCommit: "4".repeat(40) },
      { ...valid, baseCommit: "not-a-commit" },
      { ...valid, headCommit: "not-a-commit" },
      { ...valid, parentCommits: [headCommit, baseCommit] },
      { ...valid, parentCommits: [baseCommit, "4".repeat(40)] },
      { ...valid, parentCommits: [baseCommit, "not-a-commit"] },
    ]) {
      expect(() => validatePullRequestMergeBinding(invalid as typeof valid)).toThrow();
    }
    for (const parentCommits of [
      [],
      [baseCommit],
      [baseCommit, headCommit, "4".repeat(40)],
    ]) {
      let caught: unknown;
      try {
        validatePullRequestMergeBinding({ ...valid, parentCommits });
      } catch (error) {
        caught = error;
      }
      expect(sanitizeProofFailure(caught)).toEqual({
        code: "invalid-pr-parent-count",
        kind: "proof",
      });
    }
    expect(proofSource).not.toContain("merge_commit_sha");
  });

  it("sorts receipt keys recursively and sanitizes arbitrary failures", () => {
    expect(canonicalReceipt({
      z: 3,
      nested: { z: 2, a: 1, omitted: undefined },
      array: [{ z: 2, a: 1 }, undefined],
      a: 1,
    })).toBe(
      '{"a":1,"array":[{"a":1,"z":2},null],"nested":{"a":1,"z":2},"z":3}\n',
    );

    const failure = Object.assign(new Error("private text and /private/location"), {
      code: "EACCES",
      fd: 42,
      hostname: "private-machine",
      path: "/private/location",
      stack: "private trace",
    });
    expect(sanitizeProofFailure(failure)).toEqual({ kind: "error", code: "EACCES" });
    expect(JSON.stringify(sanitizeProofFailure(failure))).not.toMatch(
      /private|location|machine|trace|42/u,
    );
    expect(sanitizeProofFailure(Object.assign(new Error("x"), { code: "/unsafe/code" })))
      .toEqual({ kind: "error" });
  });

  it("observes early transfer rejection before its stat gate without an unhandled rejection", async () => {
    const directory = await tempRoot("fs-safe-transfer-proof-early-stat-");
    const sourcePath = path.join(directory, "do-not-disclose-source-token");
    const targetPath = path.join(directory, "target");
    await fsp.writeFile(sourcePath, "source");
    await fsp.writeFile(targetPath, "target");
    const source = await fsp.open(sourcePath, "r");
    const target = await fsp.open(targetPath, "r+");
    await source.close();
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      const encoded = await earlyRejectionContractReceipt(copyFileHandle(source, target));
      await new Promise<void>(resolve => { setImmediate(resolve); });
      expect(unhandled).toEqual([]);
      const parsed = JSON.parse(encoded);
      expect(parsed).toMatchObject({
        failure: { kind: "error" },
        passed: false,
        schema: "fs-safe-file-handle-transfer-proof-contract-v1",
        status: "failed",
      });
      expect(parsed.failure.code).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u);
      expect(Object.keys(parsed.failure).sort()).toEqual(["code", "kind"]);
      expect(encoded).not.toMatch(/do-not-disclose-source-token|message|stack/u);
    } finally {
      process.off("unhandledRejection", listener);
      await target.close();
    }
  });

  it("keeps a canonical pending receipt across a timed-out atomic replacement", async () => {
    const directory = await tempRoot("fs-safe-transfer-proof-contract-");
    const output = path.join(directory, "receipt.json");
    const pending = {
      passed: false,
      schema: "fs-safe-file-handle-transfer-proof-contract-v1",
      status: "pending",
    };
    const pendingEncoded = await preservePendingReceipt(output, pending);
    expect(await fsp.readFile(output, "utf8")).toBe(pendingEncoded);

    const finalEncoded = canonicalReceipt({ ...pending, passed: true, status: "passed" });
    const stalledIo = {
      rename: fsp.rename.bind(fsp),
      rm: fsp.rm.bind(fsp),
      writeFile: () => new Promise<void>(() => undefined),
    };
    await expect(atomicReplaceReceipt(output, finalEncoded, {
      io: stalledIo,
      timeoutMs: 1,
    })).rejects.toMatchObject({ proofCode: "receipt-stage-write-timeout" });
    expect(await fsp.readFile(output, "utf8")).toBe(pendingEncoded);
    expect(JSON.parse(await timeoutContractReceipt(1))).toEqual({
      failure: { code: "contract-timeout", kind: "proof" },
      passed: false,
      schema: "fs-safe-file-handle-transfer-proof-contract-v1",
      status: "failed",
    });

    await atomicReplaceReceipt(output, finalEncoded);
    expect(await fsp.readFile(output, "utf8")).toBe(finalEncoded);
  });

  it("loads the built public subpath and delegates each instance wrapper before awaiting", () => {
    expect(proofSource).toContain('await import("@openclaw/fs-safe/advanced")');
    expect(proofSource).not.toMatch(/import\s*\(\s*["']\.\.\/dist/u);
    expect(proofSource).toMatch(
      /const pending = genuineStat\(\.\.\.args\);[\s\S]*?const result = await pending;/u,
    );
    expect(proofSource).toMatch(
      /const pending = genuineWrite\(buffer, offset, delegatedLength, position\);[\s\S]*?const result = await pending;/u,
    );
    expect(proofSource).toContain('scope: "source-instance-only"');
    expect(proofSource).toContain('scope: "target-instance-only"');
    expect(proofSource).toContain(
      "settlement = observeSettlement(copyFileHandle(fixture.source, fixture.target, options))",
    );
    expect(proofSource).toMatch(/await waitForGateOrSettlement\([\s\S]*?statGate\.promise/u);
    expect(proofSource).toMatch(/finally \{[\s\S]*?statRelease\.resolve\(\);[\s\S]*?await bounded\(settlement/u);
  });

  it("retains the three bounded real-descriptor scenarios and receipt evidence", () => {
    for (const name of ["stable-replacement", "selected-signal", "current-authority"]) {
      expect(proofSource).toContain(`phase = "${name}"`);
    }
    expect(proofSource).toMatch(/const GATE_TIMEOUT_MS = 5_000;/u);
    expect(proofSource).toMatch(/const CLEANUP_OPERATION_TIMEOUT_MS = 5_000;/u);
    expect(proofSource).toMatch(/const FIXTURE_OPERATION_TIMEOUT_MS = 10_000;/u);
    expect(proofSource).toMatch(/const RECEIPT_IO_TIMEOUT_MS = 5_000;/u);
    expect(proofSource).toMatch(/const SCENARIO_TIMEOUT_MS = 30_000;/u);
    const pendingReceipt = proofSource.indexOf("await preservePendingReceipt(outputPath");
    const provenance = proofSource.indexOf("receipt.provenance = await sourceMetadata()");
    expect(pendingReceipt).toBeGreaterThanOrEqual(0);
    expect(provenance).toBeGreaterThan(pendingReceipt);
    expect(proofSource).toMatch(
      /const nextPath = `\$\{outputPath\}\.next`;[\s\S]*?io\.writeFile\(nextPath[\s\S]*?io\.rename\(nextPath, outputPath\)/u,
    );
    expect(proofSource).toMatch(
      /const closed = await boundedCleanup\([\s\S]*?handle\.close\(\)[\s\S]*?CLEANUP_OPERATION_TIMEOUT_MS/u,
    );
    expect(proofSource).toMatch(
      /const removed = await boundedCleanup\([\s\S]*?fs\.rm\(fixture\.directory[\s\S]*?CLEANUP_OPERATION_TIMEOUT_MS/u,
    );
    expect(proofSource).toMatch(/const RECEIPT_MAX_BYTES = 32 \* 1024;/u);
    expect(proofSource).toContain("replacementsInstalledWhileRealStatHeld: true");
    expect(proofSource).toContain("writesAfterCancellation: write.counts.submissions - 1");
    expect(proofSource).toContain("writesAfterRejection: write.counts.submissions - 1");
    for (const hashLabel of [
      "builtTransferModule",
      "dependencyLock",
      "packageManifest",
      "proofProgram",
      "sourceTransferModule",
      "workflow",
    ]) {
      expect(proofSource).toContain(`${hashLabel}:`);
    }
  });

  it("runs after the built check in both Linux lanes and always uploads one receipt", () => {
    const checkJob = section(workflow, "  check:\n", "  native-check:\n");
    const checkout = section(checkJob, "      - name: Check out\n", "      - name: Set up pnpm\n");
    expect(checkout).toMatch(/uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/u);
    expect(checkout).toMatch(/fetch-depth: 2/u);
    expect(checkJob).toMatch(/node:\n\s+- 22\n\s+- 24/u);
    expect(checkJob).toMatch(/os:[\s\S]*?- ubuntu-latest/u);

    const builtCheck = checkJob.indexOf("run: pnpm check");
    const proof = checkJob.indexOf("- name: Prove borrowed file-handle transfer policy snapshots");
    const upload = checkJob.indexOf("- name: Upload borrowed file-handle transfer receipt");
    const nextStep = checkJob.indexOf("- name: Smoke method benchmarks with JavaScript fallback");
    expect(builtCheck).toBeGreaterThanOrEqual(0);
    expect(proof).toBeGreaterThan(builtCheck);
    expect(upload).toBeGreaterThan(proof);
    expect(nextStep).toBeGreaterThan(upload);

    const proofStep = checkJob.slice(proof, upload);
    expect(proofStep).toMatch(/if: always\(\) && matrix\.os == 'ubuntu-latest'/u);
    expect(proofStep).toMatch(/timeout-minutes: 2/u);
    expect(proofStep).toContain(
      'run: node scripts/file-handle-transfer-proof.mjs --receipt "$FILE_HANDLE_TRANSFER_PROOF_RECEIPT"',
    );

    const uploadStep = checkJob.slice(upload, nextStep);
    expect(uploadStep).toMatch(/if: always\(\) && matrix\.os == 'ubuntu-latest'/u);
    expect(uploadStep).toMatch(
      /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u,
    );
    expect(uploadStep).toContain(
      "name: file-handle-transfer-proof-node-${{ matrix.node }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(uploadStep).toContain(
      "path: ${{ runner.temp }}/file-handle-transfer-proof-node-${{ matrix.node }}.json",
    );
    expect(uploadStep).toMatch(/if-no-files-found: error/u);
  });
});
