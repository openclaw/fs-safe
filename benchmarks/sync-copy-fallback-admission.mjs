import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "replaceFileAtomicSync/sync-destination-admission/";
const DIVISOR = 10;

const ROWS = Object.freeze([
  {
    name: `${PREFIX}rename`,
    forceCopyFallback: false,
    restore: "none",
    expectedDestinationCalls: { lstatSync: 3, openSync: 1, fstatSync: 1, closeSync: 1 },
  },
  {
    name: `${PREFIX}copy-fallback-restore`,
    forceCopyFallback: true,
    restore: "restore-original",
    expectedDestinationCalls: { lstatSync: 4, openSync: 2, fstatSync: 3, closeSync: 2 },
  },
].map((row) => Object.freeze({
  ...row,
  expectedDestinationCalls: Object.freeze(row.expectedDestinationCalls),
  workloadSemantics: "equivalent-output",
  workloadDetails: Object.freeze({
    timedOperation: "replaceFileAtomicSync",
    route: row.forceCopyFallback ? "forced copy fallback with bounded restore" : "ordinary rename",
    destinationHardlinks: "reject",
    expectedDestinationCalls: Object.freeze(row.expectedDestinationCalls),
    untimedOperations: Object.freeze([
      "fixture reset",
      "result verification",
      "destination call-receipt verification",
      "content verification",
    ]),
  }),
})));

export const SYNC_COPY_FALLBACK_ADMISSION_NAMES = Object.freeze(ROWS.map(({ name }) => name));

export function syncCopyFallbackAdmissionDescriptors() {
  return ROWS;
}

export function validateSyncCopyFallbackAdmissionWorkloadResult(result) {
  if (!result.name.startsWith(PREFIX)) return;
  const row = ROWS.find(({ name }) => name === result.name);
  assert(row, `Unknown sync destination-admission row: ${result.name}`);
  assert.equal(result.workloadSemantics, row.workloadSemantics,
    `sync destination-admission workload semantics mismatch for ${result.name}`);
  assert.deepEqual(result.workloadDetails, row.workloadDetails,
    `sync destination-admission workload receipt mismatch for ${result.name}`);
}

export function validateSyncCopyFallbackAdmissionReport(report, filter = "", requestedIterations) {
  const expectedNames = SYNC_COPY_FALLBACK_ADMISSION_NAMES
    .filter((name) => !filter || name.includes(filter));
  const results = (report.results ?? []).filter(({ name }) => name.startsWith(PREFIX));
  assert.deepEqual(results.map(({ name }) => name), expectedNames,
    "sync destination-admission report row set mismatch");
  for (const result of results) {
    validateSyncCopyFallbackAdmissionWorkloadResult(result);
    assert.equal(result.skipped, undefined,
      `sync destination-admission row was not measured: ${result.name}`);
    if (requestedIterations !== undefined) {
      assert.equal(result.iterations, Math.max(1, Math.floor(requestedIterations / DIVISOR)),
        `sync destination-admission iteration count mismatch: ${result.name}`);
    }
  }
}

function createInstrumentedFileSystem(dest, forceCopyFallback) {
  const calls = { lstatSync: 0, openSync: 0, fstatSync: 0, closeSync: 0 };
  const destinationFds = new Set();
  const observedDestinationFds = new Set();
  const fileSystem = {
    ...fs,
    lstatSync(candidate, ...options) {
      if (String(candidate) === dest) calls.lstatSync += 1;
      return fs.lstatSync(candidate, ...options);
    },
    openSync(candidate, flags, mode) {
      const fd = fs.openSync(candidate, flags, mode);
      if (String(candidate) === dest) {
        calls.openSync += 1;
        destinationFds.add(fd);
        observedDestinationFds.add(fd);
      } else {
        // Numeric descriptors may be reused after a destination close.
        observedDestinationFds.delete(fd);
      }
      return fd;
    },
    fstatSync(fd, ...options) {
      if (destinationFds.has(fd)) calls.fstatSync += 1;
      return fs.fstatSync(fd, ...options);
    },
    closeSync(fd) {
      if (observedDestinationFds.has(fd)) calls.closeSync += 1;
      destinationFds.delete(fd);
      fs.closeSync(fd);
    },
    renameSync(source, destination) {
      if (forceCopyFallback && String(destination) === dest) {
        throw Object.assign(new Error("benchmark forces copy fallback"), { code: "EPERM" });
      }
      fs.renameSync(source, destination);
    },
  };
  return { calls, destinationFds, fileSystem };
}

export function registerSyncCopyFallbackAdmission({ api, workspace, register }) {
  const original = Buffer.from("original destination");
  const replacement = Buffer.from("replacement payload");
  for (const [index, row] of ROWS.entries()) {
    const dest = path.join(workspace, `sync-destination-admission-${index}`);
    const instrumented = createInstrumentedFileSystem(dest, row.forceCopyFallback);
    register(row.name, () => api.replaceFileAtomicSync({
      filePath: dest,
      content: replacement,
      fileSystem: instrumented.fileSystem,
      destinationHardlinks: "reject",
      copyFallbackOnPermissionError: row.forceCopyFallback,
      copyFallbackRestore: row.restore,
      maxRestoreBytes: row.forceCopyFallback ? original.length : undefined,
      syncTempFile: false,
      syncParentDir: false,
    }), {
      sync: true,
      divisor: DIVISOR,
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
      before: () => {
        assert.equal(instrumented.destinationFds.size, 0,
          "previous destination descriptor remained open");
        for (const name of Object.keys(instrumented.calls)) instrumented.calls[name] = 0;
        fs.writeFileSync(dest, original, { mode: 0o600 });
      },
      verify: (result) => {
        assert.equal(result.method, row.forceCopyFallback ? "copy-fallback" : "rename");
        assert.ok(fs.readFileSync(dest).equals(replacement));
      },
      after: (result) => {
        assert.equal(result?.method, row.forceCopyFallback ? "copy-fallback" : "rename");
        assert.deepEqual(instrumented.calls, row.expectedDestinationCalls);
        assert.equal(instrumented.destinationFds.size, 0);
        assert.ok(fs.readFileSync(dest).equals(replacement));
      },
    });
  }
}
