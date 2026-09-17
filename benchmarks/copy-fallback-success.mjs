import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PAYLOAD_SIZES = Object.freeze([128, 1024 * 1024, 16 * 1024 * 1024]);
const RESTORE_POLICIES = Object.freeze(["none", "restore-original"]);
const METHODS = Object.freeze([
  Object.freeze({ name: "replaceFileAtomic", sync: false }),
  Object.freeze({ name: "replaceFileAtomicSync", sync: true }),
]);
const DIVISOR = 100;

const ROWS = Object.freeze(PAYLOAD_SIZES.flatMap(payloadBytes =>
  RESTORE_POLICIES.flatMap(restorePolicy =>
    METHODS.map(({ name: publicMethod, sync }) => Object.freeze({
      name: `${publicMethod}/copy-fallback/${restorePolicy}/${payloadBytes}`,
      sync,
      divisor: DIVISOR,
      payloadBytes,
      restorePolicy,
      publicMethod,
      workloadSemantics: "equivalent-output",
      workloadDetails: Object.freeze({
        publicMethod,
        fallbackTrigger: "injected-rename-EPERM",
        destinationLayout: "existing-regular-file",
        restorePolicy,
        payloadBytes,
        syncTempFile: false,
        syncParentDir: false,
        timedOperations: Object.freeze([
          "public atomic replacement",
          "forced rename failure",
          "copy-fallback source admission and read",
          "destination replacement",
          "destination-writer close",
          "source-temp settlement",
        ]),
        untimedOperations: Object.freeze([
          "fixture reset",
          "result receipt verification",
          "destination content verification",
          "source-temp absence verification",
        ]),
      }),
    }))),
));

export const COPY_FALLBACK_SUCCESS_NAMES = Object.freeze(ROWS.map(({ name }) => name));

function isCopyFallbackSuccessName(name) {
  return typeof name === "string" &&
    /^(replaceFileAtomic|replaceFileAtomicSync)\/copy-fallback\//u.test(name);
}

export function copyFallbackSuccessDescriptors() {
  return ROWS;
}

export function validateCopyFallbackSuccessWorkloadResult(result) {
  if (!isCopyFallbackSuccessName(result.name)) return;
  const row = ROWS.find(({ name }) => name === result.name);
  assert(row, `Unknown copy-fallback success row: ${result.name}`);
  assert.equal(result.skipped, undefined,
    `copy-fallback success row was not measured: ${result.name}`);
  assert.equal(result.workloadSemantics, row.workloadSemantics,
    `copy-fallback workload semantics mismatch for ${result.name}`);
  assert.deepEqual(result.workloadDetails, row.workloadDetails,
    `copy-fallback workload receipt mismatch for ${result.name}`);
}

export function validateCopyFallbackSuccessReport(report, filter = "", requestedIterations) {
  const expectedRows = ROWS.filter(({ name }) => !filter || name.includes(filter));
  const results = (report.results ?? []).filter(({ name }) => isCopyFallbackSuccessName(name));
  assert.deepEqual(results.map(({ name }) => name), expectedRows.map(({ name }) => name),
    "copy-fallback success report row set mismatch");
  for (const [index, result] of results.entries()) {
    const row = expectedRows[index];
    validateCopyFallbackSuccessWorkloadResult(result);
    if (requestedIterations !== undefined) {
      assert.equal(result.iterations, Math.max(1, Math.floor(requestedIterations / row.divisor)),
        `copy-fallback success iteration count mismatch: ${result.name}`);
    }
  }
}

export function registerCopyFallbackSuccess({ api, workspace, register }) {
  const renameDenied = () => {
    throw Object.assign(new Error("benchmark forces copy fallback"), { code: "EPERM" });
  };
  const asyncFs = { promises: { ...fs.promises, rename: async () => renameDenied() } };
  const syncFs = { ...fs, renameSync: renameDenied };
  const dest = path.join(workspace, "fallback-output");
  const fixtures = new Map(PAYLOAD_SIZES.map(payloadBytes => [payloadBytes, {
    original: Buffer.alloc(payloadBytes, 0xa5),
    content: Buffer.alloc(payloadBytes, 0x5a),
  }]));

  for (const row of ROWS) {
    const { original, content } = fixtures.get(row.payloadBytes);
    register(row.name, () => api[row.publicMethod]({
      filePath: dest,
      content,
      fileSystem: row.sync ? syncFs : asyncFs,
      copyFallbackOnPermissionError: true,
      copyFallbackRestore: row.restorePolicy,
      maxRestoreBytes: row.restorePolicy === "restore-original" ? row.payloadBytes : undefined,
      syncTempFile: false,
      syncParentDir: false,
    }), {
      sync: row.sync,
      divisor: row.divisor,
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
      before: () => fs.writeFileSync(dest, original, { mode: 0o600 }),
      after: result => {
        assert.equal(result.method, "copy-fallback");
        assert.ok(fs.readFileSync(dest).equals(content));
        assert.equal(fs.readdirSync(workspace).some(name =>
          name.startsWith(".fs-safe-replace.") && name.endsWith(".tmp")), false);
      },
    });
  }
}
