import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PAYLOADS = Object.freeze([
  Object.freeze({ label: "small", bytes: 32 }),
  Object.freeze({ label: "large", bytes: 1024 * 1024 }),
]);
const TARGET_STATES = Object.freeze(["missing", "existing"]);

function atomicDurabilityCases() {
  return [
    Object.freeze({ label: "default", durable: false }),
    Object.freeze({ label: "durable", durable: true }),
  ];
}

function storeDurabilityCases() {
  return [
    Object.freeze({ label: "default", durable: true }),
    Object.freeze({ label: "durable=false", durable: false }),
  ];
}

function buildCases() {
  const rows = [];
  for (const api of ["replaceFileAtomic", "replaceFileAtomicSync"]) {
    for (const payload of PAYLOADS) {
      for (const durability of atomicDurabilityCases()) {
        for (const targetState of TARGET_STATES) {
          const execution = api.endsWith("Sync") ? "sync" : "async";
          rows.push(Object.freeze({
            name: `${api}/temp-settlement/${payload.label}/${durability.label}/${targetState}`,
            workloadSemantics: "equivalent-output",
            workloadDetails: Object.freeze({
              schema: "atomic-temp-settlement-success-v1",
              api,
              execution,
              payloadBytes: payload.bytes,
              durable: durability.durable,
              durabilityOptions: durability.label === "default"
                ? "default"
                : "sync-temp-and-parent",
              targetLayout: "same-directory-sibling-temp",
              targetState,
              cleanupContract: "no-owned-temp-remains",
            }),
          }));
        }
      }
    }
  }
  for (const payload of PAYLOADS) {
    for (const durability of storeDurabilityCases()) {
      for (const targetState of TARGET_STATES) {
        rows.push(Object.freeze({
          name: `FileStoreSync.write/temp-settlement/${payload.label}/${durability.label}/${targetState}`,
          workloadSemantics: "equivalent-output",
          workloadDetails: Object.freeze({
            schema: "atomic-temp-settlement-success-v1",
            api: "FileStoreSync.write",
            execution: "sync",
            payloadBytes: payload.bytes,
            durable: durability.durable,
            durabilityOptions: durability.label === "default" ? "default" : "durable=false",
            targetLayout: "store-root-sibling-temp",
            targetState,
            cleanupContract: "no-owned-temp-remains",
          }),
        }));
      }
    }
  }
  return Object.freeze(rows);
}

export const ATOMIC_TEMP_SETTLEMENT_CASES = buildCases();
const CASES_BY_NAME = new Map(ATOMIC_TEMP_SETTLEMENT_CASES.map((row) => [row.name, row]));

function safeFixtureName(name) {
  return name.replaceAll(/[^a-z0-9]+/giu, "-").replaceAll(/^-|-$/gu, "").toLowerCase();
}

function payloadFor(row) {
  return Buffer.alloc(row.workloadDetails.payloadBytes, 0x5a);
}

function assertExactTarget(directory, targetPath, payload) {
  assert.deepEqual(fs.readdirSync(directory).sort(), [path.basename(targetPath)]);
  assert(fs.readFileSync(targetPath).equals(payload), "published bytes differ from the requested payload");
  const stat = fs.lstatSync(targetPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), "published target is not a regular file");
  if (process.platform !== "win32") {
    assert.equal(stat.mode & 0o777, 0o600, "published target mode differs from the default");
  }
}

function registerCase({ api, workspace, register, onCleanup }, row, index) {
  const directory = path.join(workspace, "atomic-temp-settlement", `${index}-${safeFixtureName(row.name)}`);
  const targetPath = path.join(directory, "target.bin");
  const payload = payloadFor(row);
  const previous = Buffer.alloc(payload.byteLength, 0xa5);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  onCleanup(() => fs.rmSync(directory, { recursive: true, force: true }));

  const before = () => {
    assert.deepEqual(fs.readdirSync(directory), [], "orphan temp existed before measured invocation");
    if (row.workloadDetails.targetState === "existing") {
      fs.writeFileSync(targetPath, previous, { mode: 0o600 });
      assert(fs.readFileSync(targetPath).equals(previous), "existing-target fixture differs");
    } else {
      assert.equal(fs.existsSync(targetPath), false, "missing-target fixture unexpectedly exists");
    }
    return Object.freeze({ targetPath });
  };
  const after = (result) => {
    const failures = [];
    try {
      if (row.workloadDetails.api === "FileStoreSync.write") {
        assert.equal(result, targetPath, "store write returned the wrong publication path");
      } else {
        assert.deepEqual(result, { method: "rename" });
      }
      assertExactTarget(directory, targetPath, payload);
    } catch (error) {
      failures.push(error);
    }
    try {
      fs.rmSync(targetPath, { force: true });
      assert.deepEqual(fs.readdirSync(directory), [], "owned temp remained after measured invocation");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `${row.name} verification and cleanup failed`);
    }
  };

  if (row.workloadDetails.api === "FileStoreSync.write") {
    const store = api.fileStoreSync({ rootDir: directory });
    register(row.name, () => store.write(
      "target.bin",
      payload,
      row.workloadDetails.durabilityOptions === "default"
        ? undefined
        : { durable: row.workloadDetails.durable },
    ), {
      sync: true,
      divisor: 100,
      before,
      after,
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
      fixturePlacement: "unique child directory on the runner workspace filesystem",
    });
    return;
  }

  const options = row.workloadDetails.durable
    ? { syncTempFile: true, syncParentDir: true }
    : {};
  register(row.name, () => api[row.workloadDetails.api]({
    filePath: targetPath,
    content: payload,
    tempPrefix: `.fs-safe-benchmark-${index}`,
    ...options,
  }), {
    sync: row.workloadDetails.execution === "sync",
    divisor: 100,
    before,
    after,
    workloadSemantics: row.workloadSemantics,
    workloadDetails: row.workloadDetails,
    fixturePlacement: "unique child directory on the runner workspace filesystem",
  });
}

export function registerAtomicTempSettlementCoverage(context) {
  ATOMIC_TEMP_SETTLEMENT_CASES.forEach((row, index) => registerCase(context, row, index));
}

export function validateAtomicTempSettlementWorkloadResult(result) {
  const expected = CASES_BY_NAME.get(result?.name);
  if (!expected) return;
  assert.equal(result.skipped, undefined, `${result.name} must execute rather than skip`);
  assert.equal(
    result.workloadSemantics,
    expected.workloadSemantics,
    `${result.name} workload semantics mismatch`,
  );
  assert.deepEqual(
    result.workloadDetails,
    expected.workloadDetails,
    `${result.name} workload details mismatch`,
  );
  assert.equal(
    result.fixturePlacement,
    "unique child directory on the runner workspace filesystem",
    `${result.name} fixture placement mismatch`,
  );
}

export function validateAtomicTempSettlementReport(report, filter) {
  const expectedNames = ATOMIC_TEMP_SETTLEMENT_CASES
    .filter((row) => !filter || row.name.includes(filter))
    .map((row) => row.name)
    .sort();
  const actualNames = (report.results ?? [])
    .filter((result) => CASES_BY_NAME.has(result.name))
    .map((result) => result.name)
    .sort();
  assert.deepEqual(actualNames, expectedNames, "atomic temp settlement row set is incomplete");
}
