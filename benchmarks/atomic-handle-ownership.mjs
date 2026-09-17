import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const ASYNC_ATOMIC_HANDLE_OWNERSHIP_BENCHMARK_NAME =
  "replaceFileAtomic/terminal-handle-finish/existing/bytes=32";

export const ASYNC_ATOMIC_HANDLE_OWNERSHIP_WORKLOAD = Object.freeze({
  schemaVersion: 1,
  publicOperation: "replaceFileAtomic",
  outcome: "rename",
  targetState: "existing-regular-file",
  payloadBytes: 32,
  syncTempFile: false,
  syncParentDir: false,
  timedBoundary: "public-call-including-terminal-owner-finish",
  verification: "return-method+published-bytes+no-owned-sibling-temp",
});

export const ASYNC_ATOMIC_HANDLE_OWNERSHIP_FIXTURE = Object.freeze({
  setup: "before-each-invocation",
  verificationAndCleanup: "after-each-invocation",
  timed: "replaceFileAtomic-call-only",
});

const CONTENT = Buffer.from("0123456789abcdef0123456789abcdef");
const TEMP_PREFIX = ".fs-safe-bench-atomic-finish";

function ownedTemps(directory) {
  return fs.readdirSync(directory).filter((name) => name.startsWith(`${TEMP_PREFIX}.`));
}

export function registerAsyncAtomicHandleOwnership({ api, workspace, register }) {
  const fixture = path.join(workspace, "atomic-handle-ownership");
  const target = path.join(fixture, "target");
  const reset = () => {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.mkdirSync(fixture);
    fs.writeFileSync(target, "previous");
    assert.deepEqual(ownedTemps(fixture), []);
  };
  const verifyAndCleanup = (result) => {
    try {
      assert.deepEqual(result, { method: "rename" });
      assert.ok(fs.readFileSync(target).equals(CONTENT));
      assert.deepEqual(ownedTemps(fixture), []);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  };

  register(
    ASYNC_ATOMIC_HANDLE_OWNERSHIP_BENCHMARK_NAME,
    () => api.replaceFileAtomic({
      filePath: target,
      content: CONTENT,
      tempPrefix: TEMP_PREFIX,
      syncTempFile: false,
      syncParentDir: false,
    }),
    {
      divisor: 20,
      workloadSemantics: "equivalent-output",
      workloadDetails: ASYNC_ATOMIC_HANDLE_OWNERSHIP_WORKLOAD,
      fixturePlacement: ASYNC_ATOMIC_HANDLE_OWNERSHIP_FIXTURE,
      before: reset,
      after: verifyAndCleanup,
    },
  );
}
