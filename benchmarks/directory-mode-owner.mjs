import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const DIRECTORY_MODE_OWNER_BENCHMARK_NAME =
  "mergeExtractedTreeIntoDestination/directory-mode-owner-post-dispatch";

const WORKLOAD_SEMANTICS =
  "successful public directory-mode finalization through owner post-dispatch checks";
const WORKLOAD_DETAILS = Object.freeze({
  sourceDirectoryMode: "0555",
  destinationLayout: "missing-empty-directory",
  ownerCheckCallbackSupplied: true,
  postDispatchCheck: true,
});

export function validateDirectoryModeOwnerWorkloadResult(result) {
  if (result.name !== DIRECTORY_MODE_OWNER_BENCHMARK_NAME) return;
  assert.equal(
    result.workloadSemantics,
    WORKLOAD_SEMANTICS,
    "directory-mode owner workload semantics mismatch",
  );
  assert.deepEqual(
    result.workloadDetails,
    WORKLOAD_DETAILS,
    "directory-mode owner workload details mismatch",
  );
}

export function registerDirectoryModeOwnerBenchmark({ api, workspace, register }) {
  const sourceRoot = path.join(workspace, "directory-mode-owner-source");
  const sourceDirectory = path.join(sourceRoot, "nested");
  const destinationRoot = path.join(workspace, "directory-mode-owner-destination");
  const destinationDirectory = path.join(destinationRoot, "nested");
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.mkdirSync(sourceDirectory, { mode: 0o555 });
  fs.mkdirSync(destinationRoot);
  if (process.platform !== "win32") fs.chmodSync(sourceDirectory, 0o555);

  register(
    DIRECTORY_MODE_OWNER_BENCHMARK_NAME,
    () => api.mergeExtractedTreeIntoDestination({
      sourceDir: sourceRoot,
      destinationDir: destinationRoot,
      destinationRealDir: destinationRoot,
    }),
    {
      divisor: 10,
      workloadSemantics: WORKLOAD_SEMANTICS,
      workloadDetails: WORKLOAD_DETAILS,
      before: () => {
        fs.rmSync(destinationDirectory, { recursive: true, force: true });
        const source = fs.lstatSync(sourceDirectory);
        assert.equal(source.isDirectory(), true);
        if (process.platform === "win32") {
          assert.notEqual(source.mode & 0o777, 0,
            "Windows source mode must differ from the identity-only owner observation");
        } else {
          assert.equal(source.mode & 0o7777, 0o555);
        }
      },
      verify: () => {
        const destination = fs.lstatSync(destinationDirectory);
        assert.equal(destination.isDirectory(), true);
        if (process.platform !== "win32") assert.equal(destination.mode & 0o7777, 0o555);
      },
      after: () => fs.rmSync(destinationDirectory, { recursive: true, force: true }),
    },
  );
}
