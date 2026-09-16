import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { registerTempWorkspaceCoverage } from "./temp-workspace-fixtures.mjs";
import { registerSecureTempRootCoverage } from "./secure-temp-root-fixtures.mjs";
import { registerSidecarPathSnapshot } from "./sidecar-path-snapshot.mjs";

const DIRECTORY_REPLACEMENT_NATIVE_SKIP = "Directory replacement security workload requires the native binding.";
const REPLACEMENT_PAYLOAD_BYTES = 128;
const WINDOWS_HANDLE_OBSERVER_ARGS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  `(Get-Process -Id ${process.pid} -ErrorAction Stop).HandleCount`,
]);
const WINDOWS_HANDLE_OBSERVER_STDIO = Object.freeze(["ignore", "pipe", "pipe"]);
const WINDOWS_HANDLE_OBSERVER_OPTIONS = Object.freeze({
  encoding: "utf8",
  stdio: WINDOWS_HANDLE_OBSERVER_STDIO,
  timeout: 30_000,
  windowsHide: true,
});

let persistentProcessHandleObserver;

function isMissingPathError(error) {
  return error?.code === "ENOENT";
}

function throwCollectedFailures(failures, message) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function attemptSync(failures, action) {
  try {
    action();
  } catch (error) {
    failures.push(error);
  }
}

function removeTreeDeepestFirst(pathname, failures) {
  let metadata;
  try {
    metadata = fs.lstatSync(pathname);
  } catch (error) {
    if (!isMissingPathError(error)) failures.push(error);
    return;
  }

  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    let names;
    try {
      names = fs.readdirSync(pathname).sort();
    } catch (error) {
      failures.push(error);
      names = [];
    }
    for (const name of names) {
      removeTreeDeepestFirst(path.join(pathname, name), failures);
    }
    try {
      fs.rmdirSync(pathname);
    } catch (error) {
      if (!isMissingPathError(error)) failures.push(error);
    }
    return;
  }

  try {
    fs.unlinkSync(pathname);
  } catch (error) {
    if (!isMissingPathError(error)) failures.push(error);
  }
}

function cleanupTreeDeepestFirst(pathname) {
  const failures = [];
  removeTreeDeepestFirst(pathname, failures);
  throwCollectedFailures(failures, `could not clean benchmark fixture ${pathname}`);
}

function observeWindowsProcessHandles() {
  const output = execFileSync(
    "powershell.exe",
    WINDOWS_HANDLE_OBSERVER_ARGS,
    WINDOWS_HANDLE_OBSERVER_OPTIONS,
  ).trim();
  assert.match(output, /^(?:0|[1-9]\d*)$/u, "PowerShell returned an invalid process HandleCount");
  const count = Number(output);
  assert(Number.isSafeInteger(count), "PowerShell process HandleCount exceeds the safe integer range");
  return count;
}

function createPosixDescriptorObserver() {
  const descriptorDirectory = ["/proc/self/fd", "/dev/fd"].find((candidate) => fs.existsSync(candidate));
  assert(descriptorDirectory, "neither /proc/self/fd nor /dev/fd is available for descriptor observation");
  return {
    observe() {
      let count = 0;
      const descriptors = fs.readdirSync(descriptorDirectory)
        .filter((name) => /^(?:0|[1-9]\d*)$/u.test(name))
        .map(Number)
        .sort((left, right) => left - right);
      for (const descriptor of descriptors) {
        try {
          fs.fstatSync(descriptor);
          count += 1;
        } catch (error) {
          // Directory enumeration can expose its own descriptor after it has closed.
          if (error?.code !== "EBADF") throw error;
        }
      }
      return count;
    },
    observer: `numeric fstat census from ${descriptorDirectory}`,
    scope: "Persistent process-wide file-descriptor balance only; this is not a descriptor-identity proof.",
  };
}

function initializePersistentProcessHandleObserver(workspace) {
  if (persistentProcessHandleObserver) return persistentProcessHandleObserver;
  const observer = process.platform === "win32"
    ? {
        observe: observeWindowsProcessHandles,
        observer: "hidden synchronous powershell.exe Get-Process HandleCount query for the Node process",
        scope: "Persistent process-wide handle-count balance only; this is not a handle-identity proof.",
      }
    : createPosixDescriptorObserver();
  const canaryPath = path.join(workspace, ".replace-directory-handle-observer-canary");
  const failures = [];
  let canaryDescriptor;
  let before;
  let during;
  let after;

  try {
    observer.observe();
    fs.writeFileSync(canaryPath, "handle observer canary\n");
    before = observer.observe();
    canaryDescriptor = fs.openSync(canaryPath, "r");
    during = observer.observe();
    assert.equal(during, before + 1, "opening the observer canary did not add exactly one process handle");
    fs.closeSync(canaryDescriptor);
    canaryDescriptor = undefined;
    after = observer.observe();
    assert.equal(after, before, "closing the observer canary did not restore the stable process handle count");
  } catch (error) {
    failures.push(error);
  } finally {
    if (canaryDescriptor !== undefined) {
      attemptSync(failures, () => fs.closeSync(canaryDescriptor));
    }
    attemptSync(failures, () => fs.rmSync(canaryPath, { force: true }));
  }
  throwCollectedFailures(failures, "persistent process handle observer canary or cleanup failed");

  persistentProcessHandleObserver = {
    ...observer,
    canary: Object.freeze({ before, during, after, openDelta: during - before }),
  };
  return persistentProcessHandleObserver;
}

function compareManifestEntries(left, right) {
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
}

function replacementShapeDefinition(shape, byteSeed) {
  const directories = [];
  const files = new Map();
  if (shape === "wide32") {
    for (let index = 0; index < 32; index += 1) {
      const directory = `d${String(index + 1).padStart(2, "0")}`;
      directories.push(directory);
      files.set(`${directory}/payload`, Buffer.alloc(REPLACEMENT_PAYLOAD_BYTES, (byteSeed + index) % 251 + 1));
    }
  } else if (shape === "deep16") {
    let directory = "";
    for (let index = 0; index < 16; index += 1) {
      const component = `d${String(index + 1).padStart(2, "0")}`;
      directory = directory === "" ? component : `${directory}/${component}`;
      directories.push(directory);
      files.set(`${directory}/payload`, Buffer.alloc(REPLACEMENT_PAYLOAD_BYTES, (byteSeed + index) % 251 + 1));
    }
  } else {
    assert.equal(shape, "empty", `unknown directory replacement shape: ${shape}`);
  }
  return Object.freeze({ directories: Object.freeze(directories), files });
}

function createReplacementTree(root, definition) {
  fs.mkdirSync(root);
  for (const relativePath of definition.directories) {
    fs.mkdirSync(path.join(root, ...relativePath.split("/")), { recursive: true });
  }
  for (const [relativePath, contents] of definition.files) {
    fs.writeFileSync(path.join(root, ...relativePath.split("/")), contents);
  }
}

function collectReplacementManifest(root) {
  const entries = [];
  const visit = (directory, relativeDirectory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const pathname = path.join(directory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const metadata = fs.lstatSync(pathname);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        entries.push({ relativePath, kind: "directory" });
        visit(pathname, relativePath);
      } else if (metadata.isFile()) {
        entries.push({ relativePath, kind: "file" });
      } else {
        entries.push({ relativePath, kind: "other" });
      }
    }
  };
  const rootMetadata = fs.lstatSync(root);
  assert(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), `${root} is not a real directory`);
  visit(root, "");
  return entries.sort(compareManifestEntries);
}

function verifyReplacementTree(root, definition) {
  const expected = [
    ...definition.directories.map((relativePath) => ({ relativePath, kind: "directory" })),
    ...[...definition.files].map(([relativePath]) => ({ relativePath, kind: "file" })),
  ].sort(compareManifestEntries);
  assert.deepEqual(collectReplacementManifest(root), expected, `${root} manifest changed`);
  for (const [relativePath, contents] of definition.files) {
    const pathname = path.join(root, ...relativePath.split("/"));
    assert(fs.readFileSync(pathname).equals(contents), `${pathname} payload changed`);
  }
}

function exactPathIdentity(pathname, expectedKind) {
  const metadata = fs.lstatSync(pathname, { bigint: true });
  assert.equal(metadata.isDirectory(), expectedKind === "directory", `${pathname} has the wrong directory type`);
  assert.equal(metadata.isFile(), expectedKind === "file", `${pathname} has the wrong file type`);
  assert.equal(metadata.isSymbolicLink(), false, `${pathname} became a symbolic link`);
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function assertExactPathIdentity(pathname, expected, expectedKind) {
  assert.deepEqual(exactPathIdentity(pathname, expectedKind), expected, `${pathname} identity changed`);
}

function assertPathAbsent(pathname) {
  try {
    fs.lstatSync(pathname);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  assert.fail(`${pathname} unexpectedly exists`);
}

function assertDirectoryEntries(directory, expected) {
  assert.deepEqual(fs.readdirSync(directory).sort(), [...expected].sort(), `${directory} entries changed`);
}

function createSentinel(parent, contents) {
  const pathname = path.join(parent, "sentinel");
  fs.writeFileSync(pathname, contents);
  return Object.freeze({
    pathname,
    contents,
    identity: exactPathIdentity(pathname, "file"),
  });
}

function assertSentinelCurrent(sentinel) {
  assertExactPathIdentity(sentinel.pathname, sentinel.identity, "file");
  assert(fs.readFileSync(sentinel.pathname).equals(sentinel.contents), `${sentinel.pathname} contents changed`);
}

function createHandleBalanceDetails(observer, expectedInvocations) {
  return {
    observer: observer.observer,
    scope: observer.scope,
    canary: observer.canary,
    expectedBoundaryObservations: 2,
    observedBoundaryObservations: 0,
    expectedInvocations,
    observedInvocations: 0,
    baseline: null,
    final: null,
    delta: null,
    balanced: null,
  };
}

function observeHandleBoundary(observer, details, boundary) {
  const observed = observer.observe();
  if (boundary === "baseline") {
    assert.equal(details.baseline, null, "process handle baseline was observed more than once");
    details.baseline = observed;
    details.observedBoundaryObservations += 1;
    return;
  }
  assert.equal(boundary, "final");
  assert.equal(details.final, null, "final process handle count was observed more than once");
  assert.notEqual(details.baseline, null, "final process handle count was observed before its baseline");
  details.final = observed;
  details.delta = details.final - details.baseline;
  details.balanced = details.delta === 0;
  details.observedBoundaryObservations += 1;
  assert.equal(details.final, details.baseline, "persistent process handle count changed across timed invocations");
}

function observeHandleBaselineOrCleanup(observer, details, rowRoot) {
  try {
    observeHandleBoundary(observer, details, "baseline");
  } catch (error) {
    const failures = [error];
    attemptSync(failures, () => cleanupTreeDeepestFirst(rowRoot));
    throwCollectedFailures(failures, "process handle baseline or fixture self-cleanup failed");
  }
}

function createReplacementSuccessFixture(params) {
  cleanupTreeDeepestFirst(params.rowRoot);
  try {
    fs.mkdirSync(params.rowRoot);
    let stagedParent;
    let targetParent;
    let rootEntries;
    const parents = [];

    if (params.parentPlacement === "same") {
      stagedParent = path.join(params.rowRoot, "shared-parent");
      targetParent = stagedParent;
      rootEntries = ["shared-parent"];
      fs.mkdirSync(stagedParent);
      const sentinel = createSentinel(stagedParent, Buffer.from("shared parent sentinel\n"));
      parents.push({
        pathname: stagedParent,
        identity: undefined,
        sentinel,
        beforeEntries: ["sentinel", "staged", ...(params.targetState === "existing" ? ["target"] : [])],
        afterEntries: ["sentinel", "target"],
      });
    } else {
      assert.equal(params.parentPlacement, "distinct");
      stagedParent = path.join(params.rowRoot, "staged-parent");
      targetParent = path.join(params.rowRoot, "target-parent");
      rootEntries = ["staged-parent", "target-parent"];
      fs.mkdirSync(stagedParent);
      fs.mkdirSync(targetParent);
      parents.push({
        pathname: stagedParent,
        identity: undefined,
        sentinel: createSentinel(stagedParent, Buffer.from("staged parent sentinel\n")),
        beforeEntries: ["sentinel", "staged"],
        afterEntries: ["sentinel"],
      });
      parents.push({
        pathname: targetParent,
        identity: undefined,
        sentinel: createSentinel(targetParent, Buffer.from("target parent sentinel\n")),
        beforeEntries: ["sentinel", ...(params.targetState === "existing" ? ["target"] : [])],
        afterEntries: ["sentinel", "target"],
      });
    }

    const stagedDir = path.join(stagedParent, "staged");
    const targetDir = path.join(targetParent, "target");
    createReplacementTree(stagedDir, params.stagedDefinition);
    if (params.targetState === "existing") {
      createReplacementTree(targetDir, params.targetDefinition);
    }
    for (const parent of parents) {
      parent.identity = exactPathIdentity(parent.pathname, "directory");
    }
    const fixture = {
      ...params,
      rowRootIdentity: exactPathIdentity(params.rowRoot, "directory"),
      rootEntries,
      parents,
      stagedDir,
      stagedIdentity: exactPathIdentity(stagedDir, "directory"),
      targetDir,
      targetIdentity: params.targetState === "existing"
        ? exactPathIdentity(targetDir, "directory")
        : undefined,
    };
    if (fixture.targetIdentity) {
      assert.notDeepEqual(fixture.targetIdentity, fixture.stagedIdentity, "staged and existing target identities match");
    }
    verifyReplacementSuccessFixture(fixture, "before");
    return fixture;
  } catch (error) {
    const failures = [error];
    attemptSync(failures, () => cleanupTreeDeepestFirst(params.rowRoot));
    throwCollectedFailures(failures, "directory replacement fixture setup and self-cleanup failed");
  }
}

function verifyReplacementSuccessFixture(fixture, phase) {
  assertExactPathIdentity(fixture.rowRoot, fixture.rowRootIdentity, "directory");
  assertDirectoryEntries(fixture.rowRoot, fixture.rootEntries);
  for (const parent of fixture.parents) {
    assertExactPathIdentity(parent.pathname, parent.identity, "directory");
    assertSentinelCurrent(parent.sentinel);
    assertDirectoryEntries(parent.pathname, phase === "before" ? parent.beforeEntries : parent.afterEntries);
  }

  if (phase === "before") {
    verifyReplacementTree(fixture.stagedDir, fixture.stagedDefinition);
    if (fixture.targetState === "existing") {
      assertExactPathIdentity(fixture.targetDir, fixture.targetIdentity, "directory");
      assert.deepEqual(
        fixture.targetDefinition.directories,
        fixture.stagedDefinition.directories,
        "staged and existing target directory shapes differ",
      );
      assert.deepEqual(
        [...fixture.targetDefinition.files.keys()],
        [...fixture.stagedDefinition.files.keys()],
        "staged and existing target file shapes differ",
      );
      for (const [relativePath, stagedContents] of fixture.stagedDefinition.files) {
        assert(
          !fixture.targetDefinition.files.get(relativePath).equals(stagedContents),
          `${relativePath} staged and existing target payloads match`,
        );
      }
      verifyReplacementTree(fixture.targetDir, fixture.targetDefinition);
    } else {
      assertPathAbsent(fixture.targetDir);
    }
    return;
  }

  assert.equal(phase, "after");
  assertPathAbsent(fixture.stagedDir);
  assertExactPathIdentity(fixture.targetDir, fixture.stagedIdentity, "directory");
  verifyReplacementTree(fixture.targetDir, fixture.stagedDefinition);
}

function createReplacementValidationFixture(params) {
  cleanupTreeDeepestFirst(params.rowRoot);
  try {
    fs.mkdirSync(params.rowRoot);
    const sentinel = createSentinel(params.rowRoot, Buffer.from("invalid-prefix sentinel\n"));
    const fixture = {
      ...params,
      rowRootIdentity: exactPathIdentity(params.rowRoot, "directory"),
      sentinel,
      stagedParent: path.join(params.rowRoot, "staged-parent-must-stay-absent"),
      targetParent: path.join(params.rowRoot, "target-parent-must-stay-absent"),
    };
    fixture.stagedDir = path.join(fixture.stagedParent, "staged");
    fixture.targetDir = path.join(fixture.targetParent, "target");
    verifyReplacementValidationFixture(fixture);
    return fixture;
  } catch (error) {
    const failures = [error];
    attemptSync(failures, () => cleanupTreeDeepestFirst(params.rowRoot));
    throwCollectedFailures(failures, "invalid-prefix fixture setup and self-cleanup failed");
  }
}

function verifyReplacementValidationFixture(fixture, output, requireError = false) {
  if (requireError) {
    assert(output instanceof Error, "invalid backup prefix did not produce an Error");
    assert.equal(output.code, "invalid-path", "invalid backup prefix produced the wrong error code");
  }
  assertExactPathIdentity(fixture.rowRoot, fixture.rowRootIdentity, "directory");
  assertSentinelCurrent(fixture.sentinel);
  assertDirectoryEntries(fixture.rowRoot, ["sentinel"]);
  assertPathAbsent(fixture.stagedParent);
  assertPathAbsent(fixture.targetParent);
  assertPathAbsent(fixture.stagedDir);
  assertPathAbsent(fixture.targetDir);
}

function finishReplacementBenchmarkInvocation(params) {
  const failures = [];
  if (params.invocationIndex === params.expectedInvocations) {
    attemptSync(failures, () => observeHandleBoundary(params.observer, params.handleDetails, "final"));
  }
  params.handleDetails.observedInvocations = params.invocationIndex;
  attemptSync(failures, params.verify);
  attemptSync(failures, () => cleanupTreeDeepestFirst(params.rowRoot));
  throwCollectedFailures(failures, "directory replacement verification or deepest-first teardown failed");
}

function registerDirectoryReplacementSecurityCases({ api, workspace, native, register, onCleanup, args }) {
  const observer = initializePersistentProcessHandleObserver(workspace);
  const firstTimedInvocation = args.warmup + 2;
  const expectedInvocations = args.warmup + 1 + args.samples * args.iterations;
  const shapes = ["empty", "wide32", "deep16"];

  for (const targetState of ["absent", "existing"]) {
    for (const parentPlacement of ["same", "distinct"]) {
      for (const shape of shapes) {
        const name = `replaceDirectoryAtomic/security/target=${targetState}/parents=${parentPlacement}/shape=${shape}`;
        const rowRoot = path.join(
          workspace,
          `rd-${targetState}-${parentPlacement}-${shape}`,
        );
        const stagedDefinition = replacementShapeDefinition(shape, 0x31);
        const targetDefinition = replacementShapeDefinition(shape, 0xa1);
        const handleDetails = createHandleBalanceDetails(observer, expectedInvocations);
        const workloadDetails = {
          targetState,
          parentPlacement,
          shape,
          directoriesPerTreeIncludingRoot: stagedDefinition.directories.length + 1,
          filesPerTree: stagedDefinition.files.size,
          bytesPerFile: REPLACEMENT_PAYLOAD_BYTES,
          setupVerificationAndTeardown: "outside timed operation",
          timedOperation: "replaceDirectoryAtomic through completed backup cleanup",
          persistentProcessHandleBalance: handleDetails,
        };
        let invocationIndex = 0;
        onCleanup(() => cleanupTreeDeepestFirst(rowRoot));
        register(name, () => api.replaceDirectoryAtomic({
          stagedDir: path.join(
            rowRoot,
            parentPlacement === "same" ? "shared-parent" : "staged-parent",
            "staged",
          ),
          targetDir: path.join(
            rowRoot,
            parentPlacement === "same" ? "shared-parent" : "target-parent",
            "target",
          ),
        }), {
          divisor: 1,
          skip: !native ? DIRECTORY_REPLACEMENT_NATIVE_SKIP : undefined,
          workloadSemantics: "Whole-directory publication with fixture and exhaustive state checks outside timing.",
          workloadDetails,
          before: () => {
            invocationIndex += 1;
            const fixture = createReplacementSuccessFixture({
              rowRoot,
              targetState,
              parentPlacement,
              stagedDefinition,
              targetDefinition,
            });
            fixture.invocationIndex = invocationIndex;
            if (invocationIndex === firstTimedInvocation) {
              observeHandleBaselineOrCleanup(observer, handleDetails, rowRoot);
            }
            return fixture;
          },
          after: (output, fixture) => finishReplacementBenchmarkInvocation({
            invocationIndex: fixture.invocationIndex,
            expectedInvocations,
            observer,
            handleDetails,
            rowRoot,
            verify: () => {
              assert.equal(output, undefined, "replaceDirectoryAtomic returned an unexpected value");
              verifyReplacementSuccessFixture(fixture, "after");
            },
          }),
        });
      }
    }
  }

  const validationRowRoot = path.join(workspace, "replace-directory-validation-invalid-backup-prefix");
  const validationHandleDetails = createHandleBalanceDetails(observer, expectedInvocations);
  const validationWorkloadDetails = {
    invalidBackupPrefix: "../invalid-backup-",
    expectedErrorCode: "invalid-path",
    setupVerificationAndTeardown: "outside timed operation",
    timedOperation: "reject backup prefix before native binding, mkdir, or UUID work",
    persistentProcessHandleBalance: validationHandleDetails,
  };
  let validationInvocationIndex = 0;
  onCleanup(() => cleanupTreeDeepestFirst(validationRowRoot));
  register("replaceDirectoryAtomic/validation/invalid-backup-prefix", () => api.replaceDirectoryAtomic({
    stagedDir: path.join(validationRowRoot, "staged-parent-must-stay-absent", "staged"),
    targetDir: path.join(validationRowRoot, "target-parent-must-stay-absent", "target"),
    backupPrefix: "../invalid-backup-",
  }), {
    divisor: 1,
    expectError: true,
    workloadSemantics: "Equal-semantics invalid-prefix rejection with no filesystem publication side effects.",
    workloadDetails: validationWorkloadDetails,
    before: () => {
      validationInvocationIndex += 1;
      const fixture = createReplacementValidationFixture({ rowRoot: validationRowRoot });
      fixture.invocationIndex = validationInvocationIndex;
      if (validationInvocationIndex === firstTimedInvocation) {
        observeHandleBaselineOrCleanup(observer, validationHandleDetails, validationRowRoot);
      }
      return fixture;
    },
    after: (output, fixture) => finishReplacementBenchmarkInvocation({
      invocationIndex: fixture.invocationIndex,
      expectedInvocations,
      observer,
      handleDetails: validationHandleDetails,
      rowRoot: validationRowRoot,
      verify: () => verifyReplacementValidationFixture(fixture, output, true),
    }),
  });
}

export async function registerLifecycle({ api: a, workspace: w, native, binding, register: add, contract, onCleanup, args }) {
  const cloneBackend = a.probeTreeClone(w);
  add("probeTreeClone", () => a.probeTreeClone(w), {
    sync: true,
    verify: (backend) => assert.equal(backend, cloneBackend),
  });
  const cloneSource = path.join(w, "clone-source");
  const cloneTarget = path.join(w, "clone-target");
  const clonePreparation = path.join(w, "clone-preparation");
  const cloneSkip = !cloneBackend
    ? "Native directory cloning requires APFS, Btrfs, ReFS, XFS, or ZFS."
    : undefined;
  if (cloneBackend) {
    await a.createCloneSource(cloneSource);
  } else {
    fs.mkdirSync(cloneSource);
  }
  const shape = args["copy-shape"];
  const cloneDirectories = ["empty", ...(shape === "mixed" ? ["nested"] : [])];
  const cloneContents = new Map(shape === "mixed" ? [["payload", Buffer.alloc(1024 * 1024, 0x5a)]] : []);
  for (let i = 0; shape !== "empty" && i < args["copy-files"]; i++) {
    if (shape === "nested") cloneDirectories.push(`directory-${i}`);
    const name = shape === "nested" ? `directory-${i}/file` : shape === "mixed" && i % 2 ? `nested/file-${i}` : `file-${i}`;
    cloneContents.set(name, Buffer.alloc(args["copy-file-bytes"], i % 251 + 1));
  }
  for (const name of cloneDirectories) fs.mkdirSync(path.join(cloneSource, name));
  for (const [name, bytes] of cloneContents) fs.writeFileSync(path.join(cloneSource, name), bytes);
  const cloneNames = fs.readdirSync(cloneSource).sort();
  const directoryNames = new Map(cloneDirectories.map(name => [name, fs.readdirSync(path.join(cloneSource, name)).sort()]));
  add("createCloneSource", () => a.createCloneSource(clonePreparation), {
    skip: cloneSkip,
    verify: () => assert(fs.statSync(clonePreparation).isDirectory()),
    after: () => fs.rmSync(clonePreparation, { recursive: true, force: true }),
  });
  for (const concurrency of args["copy-concurrency"] ?? [undefined]) {
    for (const clone of ["auto", "never", "always"]) {
      add(`copyTree/${clone}/${shape}${concurrency === undefined ? "" : `/workers=${concurrency}`}`, () => a.copyTree(cloneSource, cloneTarget, { clone, concurrency }), {
        divisor: 10,
        skip: clone === "always" ? cloneSkip : undefined,
        verify: () => {
          assert.deepEqual(fs.readdirSync(cloneTarget).sort(), cloneNames);
          for (const [name, entries] of directoryNames) assert.deepEqual(fs.readdirSync(path.join(cloneTarget, name)).sort(), entries);
          for (const [name, bytes] of cloneContents) assert(fs.readFileSync(path.join(cloneTarget, name)).equals(bytes), name);
        },
        after: () => fs.rmSync(cloneTarget, { recursive: true, force: true }),
      });
    }
  }
  add("readCloneFileMetadata", () => a.readCloneFileMetadata([path.join(w, "input.json")]), {
    skip: !native ? "Native metadata reader unavailable." : undefined,
    verify: (entries) => {
      assert.equal(entries.length, 1);
      if (cloneBackend === "apfs") assert.equal(entries[0]?.type, 1);
    },
  });
  if (binding) {
    const directory = path.join(w, "native-directory");
    fs.mkdirSync(directory);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);
    const rootFd = fs.openSync(w, flags);
    const rootIdentity = fs.fstatSync(rootFd);
    const directoryIdentity = fs.statSync(directory);
    onCleanup(() => fs.closeSync(rootFd));
    add("native.fstatIdentity/directory", () => binding.fstatIdentity(rootFd), {
      sync: true,
      verify: (identity) => {
        assert.equal(identity.isDirectory, true);
        assert.equal(identity.dev, rootIdentity.dev);
        assert.equal(identity.ino, rootIdentity.ino);
      },
    });
    add("native.openBeneath/directory", () => binding.openBeneath(rootFd, "native-directory", flags), {
      sync: true,
      verify: (opened) => {
        const identity = fs.fstatSync(opened.fd);
        assert.equal(identity.isDirectory(), true);
        assert.equal(identity.dev, directoryIdentity.dev);
        assert.equal(identity.ino, directoryIdentity.ino);
      },
      after: (opened) => { if (opened) fs.closeSync(opened.fd); },
    });
  } else {
    add("native.fstatIdentity/directory", () => {}, { skip: "native binding unavailable" });
    add("native.openBeneath/directory", () => {}, { skip: "native binding unavailable" });
  }
  const input = path.join(w, "input.json");
  const data = Buffer.from("synthetic benchmark\n");
  const output = path.join(w, "lifecycle-output");
  const secretRoot = path.join(w, "secret-writes");
  fs.mkdirSync(secretRoot, { mode: 0o700 });
  for (const name of ["replaceFileAtomic", "replaceFileAtomicSync"]) add(name, () => a[name]({ filePath: output, content: data }), { sync: name.endsWith("Sync") });
  add("writeTextAtomic", () => a.writeTextAtomic(output, "synthetic benchmark"));
  registerDirectoryReplacementSecurityCases({
    api: a,
    workspace: w,
    native,
    register: add,
    onCleanup,
    args,
  });
  add("movePathWithCopyFallback", () => a.movePathWithCopyFallback({ from: path.join(w, "move-source"), to: output }), { before: () => fs.writeFileSync(path.join(w, "move-source"), data) });
  for (const shape of ["empty", "wide", "deep"]) {
    const source = path.join(w, `move-copy-${shape}-source`);
    const target = path.join(w, `move-copy-${shape}-target`);
    const directories = Array.from({ length: shape === "empty" ? 0 : 32 }, (_, index) => shape === "wide"
      ? `d${index}` : Array(index + 1).fill("d").join(path.sep));
    const payload = Buffer.alloc(128, 0x5a);
    add(`movePathWithCopyFallback/forced-copy/${shape}/directories=${directories.length + 1}`, () => a.movePathWithCopyFallback({
      from: source, to: target, sourceHardlinks: "reject",
    }), {
      divisor: 10,
      workloadDetails: { shape, directories: directories.length + 1, files: directories.length, bytesPerFile: 128, sourceHardlinks: "reject" },
      before: () => {
        fs.mkdirSync(source);
        for (const directory of directories) {
          fs.mkdirSync(path.join(source, directory), { recursive: true });
          fs.writeFileSync(path.join(source, directory, "payload"), payload);
        }
      },
      verify: () => {
        assert.equal(fs.existsSync(source), false);
        assert.deepEqual(fs.readdirSync(target).sort(), shape === "deep" ? ["d"] : directories.toSorted());
        for (const [index, directory] of directories.entries()) {
          const expected = shape === "deep" && index < directories.length - 1 ? ["d", "payload"] : ["payload"];
          assert.deepEqual(fs.readdirSync(path.join(target, directory)).sort(), expected);
          assert(fs.readFileSync(path.join(target, directory, "payload")).equals(payload));
        }
      },
      after: () => {
        fs.rmSync(source, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
      },
    });
  }
  for (const name of ["writeSecretFileAtomic", "createSecretFileAtomic"]) add(name, () => a[name]({ rootDir: secretRoot, filePath: path.join(secretRoot, "secret-out"), content: data }), {
    before: () => name === "createSecretFileAtomic"
      ? fs.rmSync(path.join(secretRoot, "secret-out"), { force: true })
      : fs.writeFileSync(path.join(secretRoot, "secret-out"), data, { mode: 0o600 }),
  });
  add("writeExternalFileWithinRoot", () => a.writeExternalFileWithinRoot({ rootDir: w, path: "external-out", write: (p) => fsp.writeFile(p, data) }));
  add("writeExternalFileWithinRoot/isolated-sibling", () => a.writeExternalFileWithinRoot({
    rootDir: w, path: "external-isolated-out", staging: "sibling",
    producerIsolation: "private-directory", write: (p) => fsp.writeFile(p, data),
  }));
  add("writeSiblingTempFile", () => a.writeSiblingTempFile({ dir: w, writeTemp: (p) => fsp.writeFile(p, data), resolveFinalPath: () => output }));
  add("writeSiblingTempFile/isolated", () => a.writeSiblingTempFile({
    dir: w, producerIsolation: "private-directory", writeTemp: (p) => fsp.writeFile(p, data),
    resolveFinalPath: () => output,
  }));
  add("writeViaSiblingTempPath", () => a.writeViaSiblingTempPath({ rootDir: w, targetPath: output, writeTemp: (p) => fsp.writeFile(p, data) }));
  const tempOptions = { rootDir: w, prefix: "fixture" };
  registerSecureTempRootCoverage({ api: a, workspace: w, register: add });
  for (const suffix of ["", "Sync"]) {
    const name = `tempWorkspace${suffix}`;
    const type = `TempWorkspace${suffix}`;
    const sync = suffix === "Sync";
    registerTempWorkspaceCoverage({
      api: a,
      workspace: w,
      register: add,
      tempOptions,
      suffix,
    });
    add(`withTempWorkspace${suffix}`, () => a[`withTempWorkspace${suffix}`](tempOptions, sync ? () => 1 : async () => 1), { sync, before: () => {} });
    const tmp = await a[name](tempOptions);
    contract(type, tmp);
    onCleanup(() => tmp.cleanup());
    await tmp.write("input.json", data);
    for (const method of ["path", "read", "write", "writeText", "writeJson", ...(sync ? [] : ["copyIn"])]) {
      add(`${type}.${method}`, () => tmp[method](method === "read" || method === "path" ? "input.json" : "output.json", method === "writeJson" ? { ok: true } : method === "copyIn" ? input : data), { sync: sync || method === "path", before: method.startsWith("write") && sync ? () => {} : undefined });
    }
    add(`${type}.cleanup`, (r) => r.cleanup(), { sync, before: () => a[name](tempOptions) });
    const symbol = sync ? Symbol.dispose : Symbol.asyncDispose;
    add(`${type}.[${sync ? "Symbol.dispose" : "Symbol.asyncDispose"}]`, (r) => r[symbol](), { sync, before: () => a[name](tempOptions) });
    // The fixture is owned by the runner's temporary workspace.
  }
  const tmp = await a.tempFile(tempOptions);
  contract("TempFile", tmp);
  onCleanup(() => tmp.cleanup());
  add("tempFile", () => a.tempFile(tempOptions), { after: (r) => r?.cleanup() });
  add("TempFile.file", () => tmp.file("fixture"), { sync: true, batch: 100 });
  add("TempFile.cleanup", (r) => r.cleanup(), { before: () => a.tempFile(tempOptions) });
  add("TempFile.[Symbol.asyncDispose]", (r) => r[Symbol.asyncDispose](), { before: () => a.tempFile(tempOptions) });
  add("withTempFile", () => a.withTempFile(tempOptions, async () => 1));
  for (const name of ["syncDirectory", "syncDirectorySync", "syncDirectoryBestEffort", "syncDirectoryBestEffortSync"]) add(name, () => a[name](w), { sync: name.endsWith("Sync"), before: () => {}, divisor: 10 });
  add("ensureDurableDirectory", () => a.ensureDurableDirectory({ directoryPath: path.join(w, "durable-dir") }));
  add("pinDirectory", () => a.pinDirectory(w), { after: (r) => r?.close() });
  const pin = await a.pinDirectory(w);
  contract("PinnedDirectory", pin);
  await pin.close();
  for (const method of ["assertCurrent", "sync", "close"]) add(`PinnedDirectory.${method}`, (r) => r[method](), { before: () => a.pinDirectory(w), after: (_, r) => r.close() });
  for (const strategy of ["link-or-copy", "link-required", "rename-noreplace"]) {
    add(`publishFileExclusive/${strategy}`, () => a.publishFileExclusive({ sourcePath: path.join(w, "publish-source"), targetPath: path.join(w, "publish-target"), strategy }), {
      skip: strategy === "rename-noreplace" && !native ? "Native-only strategy." : undefined,
      before: () => fs.writeFileSync(path.join(w, "publish-source"), data), after: () => fs.rmSync(path.join(w, "publish-target"), { force: true }),
    });
  }
  const stagingSkip = !native || !["darwin", "linux"].includes(process.platform) ? "Retained-directory staging requires native Linux/macOS." : undefined;
  const stage = () => a.stageFileInDirectory({ directory: w, content: data });
  add("stageFileInDirectory", stage, { skip: stagingSkip, after: (r) => r?.cleanup() });
  if (!stagingSkip) { const r = await stage(); contract("StagedFile", r); await r.cleanup(); }
  for (const method of ["assertCurrent", "cleanup", "publish"]) add(`StagedFile.${method}`, (r) => method === "publish" ? r.publish("published-stage", { overwrite: true }) : r[method](), { skip: stagingSkip, before: stage, after: (_, r) => r.cleanup() });
  add("StagedFile.[Symbol.asyncDispose]", (r) => r[Symbol.asyncDispose](), { skip: stagingSkip, before: stage });
  const lockOptions = { payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }), timeoutMs: 1000 };
  const lockPath = path.join(w, "locked");
  for (const suffix of ["", "Sync"]) {
    const sync = suffix === "Sync";
    const acquire = () => a[`acquireFileLock${suffix}`](lockPath, lockOptions);
    add(`acquireFileLock${suffix}`, acquire, { sync, after: (r) => r?.release() });
    add(`withFileLock${suffix}`, () => a[`withFileLock${suffix}`](lockPath, lockOptions, sync ? () => 1 : async () => 1), { sync });
    const r = await acquire();
    const type = `FileLock${suffix}Handle`;
    contract(type, r);
    await r.release();
    for (const method of ["verifyStillHeld", "release"]) add(`${type}.${method}`, (r) => r[method](), { sync, before: acquire, after: (_, r) => r.release() });
    const symbol = sync ? Symbol.dispose : Symbol.asyncDispose;
    add(`${type}.[${sync ? "Symbol.dispose" : "Symbol.asyncDispose"}]`, (r) => r[symbol](), { sync, before: acquire });
  }
  const manager = a.createFileLockManager("fs-safe-benchmark");
  contract("FileLockManager", manager);
  add("createFileLockManager", () => a.createFileLockManager("fs-safe-benchmark"), { sync: true });
  add("FileLockManager.acquire", () => manager.acquire(lockPath, lockOptions), { after: (r) => r?.release() });
  add("FileLockManager.withLock", () => manager.withLock(lockPath, lockOptions, async () => 1));
  add("FileLockManager.heldEntries", () => manager.heldEntries(), { sync: true });
  add("FileLockManager.drain", () => manager.drain());
  add("FileLockManager.reset", () => manager.reset(), { sync: true });
  const held = await manager.acquire(lockPath, lockOptions);
  const heldEntry = manager.heldEntries()[0];
  contract("FileLockHeldEntry", heldEntry);
  await held.release();
  add("FileLockHeldEntry.forceRelease", (entry) => entry.forceRelease(), { before: async () => { await manager.acquire(lockPath, lockOptions); return manager.heldEntries()[0]; }, after: () => manager.drain() });
  registerSidecarPathSnapshot({ api: a, workspace: w, register: add, onCleanup });
  const queueDir = path.join(w, "queue");
  const failedDir = path.join(w, "failed");
  await a.ensureJsonDurableQueueDirs({ queueDir, failedDir });
  const queue = a.resolveJsonDurableQueueEntryPaths(queueDir, "fixture");
  const resetQueue = () => { for (const p of Object.values(queue)) fs.rmSync(p, { force: true }); fs.rmSync(path.join(failedDir, "fixture.json"), { force: true }); fs.writeFileSync(queue.jsonPath, '{"ok":true}'); };
  add("resolveJsonDurableQueueEntryPaths", () => a.resolveJsonDurableQueueEntryPaths(queueDir, "fixture"), { sync: true });
  add("ensureJsonDurableQueueDirs", () => a.ensureJsonDurableQueueDirs({ queueDir, failedDir }));
  add("writeJsonDurableQueueEntry", () => a.writeJsonDurableQueueEntry({ filePath: queue.jsonPath, entry: { ok: true }, tempPrefix: "bench" }));
  add("jsonDurableQueueEntryExists", () => a.jsonDurableQueueEntryExists(queue.jsonPath), { before: resetQueue });
  add("readJsonDurableQueueEntry", () => a.readJsonDurableQueueEntry(queue.jsonPath), { before: resetQueue, verify: (r) => assert(r.ok) });
  add("loadJsonDurableQueueEntry", () => a.loadJsonDurableQueueEntry({ paths: queue, tempPrefix: "bench" }), { before: resetQueue, verify: (r) => assert(r.ok) });
  add("loadPendingJsonDurableQueueEntries", () => a.loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "bench" }), { before: resetQueue, verify: (r) => assert.equal(r.length, 1) });
  for (const batch of [false, true]) {
    const method = batch ? "loadPendingJsonDurableQueueEntries" : "loadJsonDurableQueueEntry";
    const migrated = { ok: true, migrated: true };
    add(`${method}/migration`, () => a[method]({
      ...(batch ? { queueDir } : { paths: queue }),
      tempPrefix: "bench",
      read: async (entry) => ({ entry: { ...entry, migrated: true }, migrated: true }),
    }), {
      before: resetQueue,
      verify: (result) => {
        assert.deepEqual(result, batch ? [migrated] : migrated);
        assert.deepEqual(JSON.parse(fs.readFileSync(queue.processingPath, "utf8")), migrated);
        assert.equal(fs.existsSync(queue.jsonPath), false);
      },
    });
  }
  const claim = async () => { resetQueue(); await a.loadJsonDurableQueueEntry({ paths: queue, tempPrefix: "bench" }); };
  add("ackJsonDurableQueueEntry", () => a.ackJsonDurableQueueEntry(queue), { before: claim });
  add("moveJsonDurableQueueEntryToFailed", () => a.moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "fixture" }), { before: claim });
  add("unlinkBestEffort", () => a.unlinkBestEffort(queue.jsonPath), { before: resetQueue });
}
