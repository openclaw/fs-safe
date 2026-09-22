import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { finishBenchmarkInvocation } from "./runner-cleanup.mjs";

export const ABSOLUTE_DIRECTORY_CLASSIFIER_FILTER = "ensureAbsoluteDirectory/classifier/";
const MODE = 0o700;
const SCOPE_LABEL = "classifier benchmark";
const OPTIONS = Object.freeze({ mode: MODE, scopeLabel: SCOPE_LABEL });
const ROWS = Object.freeze(["existing", "missing"].flatMap(state => [1, 8].map(depth => Object.freeze({
  name: `${ABSOLUTE_DIRECTORY_CLASSIFIER_FILTER}state=${state}/depth=${depth}`,
  state,
  depth,
  workloadSemantics: "equivalent-output",
  workloadDetails: Object.freeze({
    publicMethod: "ensureAbsoluteDirectory",
    initialSuffixState: state,
    generatedSuffixDepth: depth,
    requestedMode: MODE,
    scopeLabel: SCOPE_LABEL,
    timedOperations: Object.freeze(["fully awaited public ensureAbsoluteDirectory"]),
    untimedOperations: Object.freeze([
      "parent and suffix state admission before every invocation",
      "exact public result and complete directory-chain verification",
      "retained parent and existing-directory identity verification",
      "missing suffix removal and absence verification after every invocation",
    ]),
  }),
}))));

export const ABSOLUTE_DIRECTORY_CLASSIFIER_NAMES = Object.freeze(ROWS.map(row => row.name));
export const absoluteDirectoryClassifierDescriptors = () => ROWS;

function isClassifierRow(name) {
  return typeof name === "string" && name.includes(ABSOLUTE_DIRECTORY_CLASSIFIER_FILTER);
}

function classifierEnvironment(report) {
  const metadata = report.metadata;
  assert(metadata && typeof metadata === "object" && !Array.isArray(metadata),
    "classifier environment metadata missing");
  const fields = ["node", "platform", "arch", "cpu", "osRelease"];
  for (const field of fields) {
    assert(typeof metadata[field] === "string" && metadata[field].trim().length > 0,
      `classifier environment ${field} missing or invalid`);
  }
  const filesystem = metadata.workspaceFilesystem;
  assert(filesystem && typeof filesystem === "object" && !Array.isArray(filesystem),
    "classifier workspace filesystem missing or invalid");
  assert(Number.isSafeInteger(filesystem.type), "classifier workspace filesystem type invalid");
  assert(Number.isSafeInteger(filesystem.blockSize) && filesystem.blockSize > 0,
    "classifier workspace filesystem block size invalid");
  return { ...Object.fromEntries(fields.map(field => [field, metadata[field]])), workspaceFilesystem: filesystem };
}

export function validateAbsoluteDirectoryClassifierWorkloadResult(result) {
  if (!isClassifierRow(result.name)) return;
  const row = ROWS.find(candidate => candidate.name === result.name);
  assert(row, `Unknown absolute-directory classifier row: ${result.name}`);
  assert.equal(result.skipped, undefined, `classifier row was not measured: ${result.name}`);
  assert.equal(result.workloadSemantics, row.workloadSemantics);
  assert.deepEqual(result.workloadDetails, row.workloadDetails, "classifier workload receipt mismatch");
  const fixture = result.fixturePlacement;
  assert(fixture && typeof fixture === "object", "classifier fixture receipt missing");
  assert.deepEqual(Object.keys(fixture).sort(), [
    "canonicalParentDepth", "filesystemBlockSize", "filesystemType", "generatedSuffixDepth",
    "initialSuffixState", "storage", "umask",
  ]);
  assert.equal(fixture.storage, "canonical child of runner workspace");
  assert.equal(fixture.generatedSuffixDepth, row.depth);
  assert.equal(fixture.initialSuffixState, row.state);
  assert(Number.isSafeInteger(fixture.canonicalParentDepth) && fixture.canonicalParentDepth > 0,
    "classifier canonical parent depth invalid");
  assert(Number.isSafeInteger(fixture.umask) && fixture.umask >= 0 && fixture.umask <= 0o777,
    "classifier umask invalid");
  assert(Number.isSafeInteger(fixture.filesystemType), "classifier filesystem type invalid");
  assert(Number.isSafeInteger(fixture.filesystemBlockSize) && fixture.filesystemBlockSize > 0,
    "classifier filesystem block size invalid");
}

export function validateAbsoluteDirectoryClassifierReport(report, filter = "", iterations, samples) {
  const expected = ROWS.filter(row => !filter || row.name.includes(filter));
  const results = (report.results ?? []).filter(row => isClassifierRow(row.name));
  assert.deepEqual(results.map(row => row.name), expected.map(row => row.name),
    "classifier report row set mismatch");
  if (filter === ABSOLUTE_DIRECTORY_CLASSIFIER_FILTER) {
    assert.equal(report.results.length, expected.length, "classifier report has extra rows");
  }
  for (const result of results) {
    validateAbsoluteDirectoryClassifierWorkloadResult(result);
    if (iterations !== undefined) assert.equal(result.iterations, iterations, "classifier iteration count mismatch");
    if (samples !== undefined) {
      assert(Array.isArray(result.samplesUs) && result.samplesUs.length === samples,
        "classifier sample count mismatch");
    }
  }
  if (results.length > 0) {
    assert.equal(new Set(results.map(row => row.fixturePlacement.canonicalParentDepth)).size, 1,
      "classifier parent depth changed between rows");
    assert.equal(new Set(results.map(row => row.fixturePlacement.umask)).size, 1,
      "classifier umask changed between rows");
    for (const field of ["filesystemType", "filesystemBlockSize"]) {
      assert.equal(new Set(results.map(row => row.fixturePlacement[field])).size, 1,
        "classifier filesystem changed between rows");
    }
    const { workspaceFilesystem } = classifierEnvironment(report);
    assert.equal(results[0].fixturePlacement.filesystemType, workspaceFilesystem.type);
    assert.equal(results[0].fixturePlacement.filesystemBlockSize, workspaceFilesystem.blockSize);
  }
}

export function validateAbsoluteDirectoryClassifierReportSet(reports, filter = "") {
  if (!ROWS.some(row => !filter || row.name.includes(filter))) return;
  const layouts = new Map();
  let environment;
  for (const report of reports) {
    const results = (report.results ?? []).filter(row => isClassifierRow(row.name));
    if (results.length === 0) continue;
    const currentEnvironment = classifierEnvironment(report);
    if (environment) assert.deepEqual(currentEnvironment, environment,
      "classifier measurement environment changed within the dispatch");
    else environment = currentEnvironment;
    for (const result of results) {
      validateAbsoluteDirectoryClassifierWorkloadResult(result);
      if (layouts.has(result.name)) {
        assert.deepEqual(result.fixturePlacement, layouts.get(result.name),
          "classifier fixture layout changed between measurement processes");
      } else layouts.set(result.name, result.fixturePlacement);
    }
  }
}

function directoryReceipt(pathname) {
  const stat = fs.lstatSync(pathname, { bigint: true });
  assert.equal(stat.isSymbolicLink(), false, "classifier fixture became a symlink");
  assert.equal(stat.isDirectory(), true, "classifier fixture is not a directory");
  return { dev: stat.dev, ino: stat.ino, mode: Number(stat.mode & 0o777n) };
}

function assertDirectoryCurrent(pathname, expected) {
  assert.deepEqual(directoryReceipt(pathname), expected, "classifier directory identity or mode changed");
}

function assertAbsent(pathname) {
  try {
    fs.lstatSync(pathname);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert.fail("classifier missing suffix already exists");
}

export function registerAbsoluteDirectoryClassifier({ api, workspace, register, onCleanup, args = {} }) {
  const selected = ROWS.filter(row => !args.filter || row.name.includes(args.filter));
  if (selected.length === 0) return;
  const family = path.join(workspace, "absolute-directory-classifier");
  let familyReceipt;
  onCleanup(() => {
    if (!familyReceipt) return;
    assertDirectoryCurrent(family, familyReceipt);
    fs.rmSync(family, { recursive: true, force: true });
  });
  fs.mkdirSync(family, { mode: MODE });
  familyReceipt = directoryReceipt(family);
  for (const row of selected) {
    const parent = path.join(family, `${row.state}-${row.depth}`);
    fs.mkdirSync(parent, { mode: MODE });
    assert.equal(fs.realpathSync.native(parent), parent, "classifier parent is not canonical");
    const parentReceipt = directoryReceipt(parent);
    const umask = process.umask();
    const paths = [];
    let target = parent;
    for (let index = 0; index < row.depth; index += 1) {
      target = path.join(target, `level-${index}`);
      paths.push(target);
      if (row.state === "existing") fs.mkdirSync(target, { mode: MODE });
    }
    const initial = row.state === "existing" ? paths.map(directoryReceipt) : undefined;
    const filesystem = fs.statfsSync(parent);
    const placement = Object.freeze({
      storage: "canonical child of runner workspace",
      canonicalParentDepth: path.relative(path.parse(parent).root, parent).split(path.sep).filter(Boolean).length,
      filesystemType: filesystem.type,
      filesystemBlockSize: filesystem.bsize,
      generatedSuffixDepth: row.depth,
      initialSuffixState: row.state,
      umask,
    });
    register(row.name, () => api.ensureAbsoluteDirectory(target, OPTIONS), {
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
      fixturePlacement: placement,
      before: () => {
        assertDirectoryCurrent(parent, parentReceipt);
        assert.equal(process.umask(), umask, "classifier umask changed before invocation");
        if (initial) {
          paths.forEach((pathname, index) => assertDirectoryCurrent(pathname, initial[index]));
        } else {
          assertAbsent(paths[0]);
          assert.deepEqual(fs.readdirSync(parent), [], "classifier missing parent is not empty");
        }
      },
      after: async result => {
        const failures = [];
        try {
          assert.deepEqual(result, { ok: true, path: target }, "classifier public result mismatch");
          assertDirectoryCurrent(parent, parentReceipt);
          assert.equal(process.umask(), umask, "classifier umask changed during invocation");
          const observed = paths.map(directoryReceipt);
          if (initial) assert.deepEqual(observed, initial, "classifier existing suffix changed");
          else if (process.platform !== "win32") {
            for (const receipt of observed) assert.equal(receipt.mode, MODE & ~umask);
          }
        } catch (error) {
          failures.push(error);
        }
        await finishBenchmarkInvocation(failures, () => {
          assertDirectoryCurrent(parent, parentReceipt);
          if (!initial) {
            fs.rmSync(paths[0], { recursive: true, force: true });
            assertAbsent(paths[0]);
            assert.deepEqual(fs.readdirSync(parent), [], "classifier cleanup left entries");
            assertDirectoryCurrent(parent, parentReceipt);
          }
        }, `${row.name} validation and reset failed`);
      },
    });
  }
}
