import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIVISOR = 100;
const CONCURRENCY = 2;
const SHAPES = Object.freeze(["many-small-nested", "multichunk"]);
const POLICIES = Object.freeze(["never", "auto"]);
const BACKENDS = Object.freeze(["apfs", "btrfs", "refs", "xfs", "zfs"]);
const MTIME_TOLERANCE_NS = 2_000_000n;

export const PROBE_TREE_SUCCESS_WORKLOAD = Object.freeze({
  schemaVersion: 1,
  publicOperation: "probeTreeClone",
  outcome: "success",
  parentState: "existing-runner-workspace-directory",
  timedBoundary: "probeTreeClone-call-through-terminal-settlement",
  verification: "every-returned-backend-equals-untimed-registration-probe",
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function receiptPath(name) {
  return name.split(path.sep).join("/");
}

function fixturePlan(shape) {
  const directories = ["", "empty", "nested", path.join("nested", "deep"), "sibling"];
  const files = [];
  if (shape === "many-small-nested") {
    const parents = ["", "nested", path.join("nested", "deep"), "sibling"];
    for (let index = 0; index < 32; index++) {
      const bytes = Buffer.alloc(4096, index % 251 + 1);
      bytes.writeUInt32LE(index, 0);
      files.push({
        name: path.join(parents[index % parents.length], `file-${String(index).padStart(2, "0")}`),
        bytes,
        mode: index % 2 ? 0o640 : 0o750,
        mtimeSeconds: 1_600_000_100 + index,
      });
    }
  } else {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    bytes.write("multichunk-head", 0, "utf8");
    bytes.write("multichunk-tail", bytes.length - 15, "utf8");
    files.push({
      name: path.join("nested", "deep", "multichunk.bin"),
      bytes,
      mode: 0o640,
      mtimeSeconds: 1_600_000_201,
    }, {
      name: "small.bin",
      bytes: Buffer.alloc(4097, 0xa5),
      mode: 0o750,
      mtimeSeconds: 1_600_000_202,
    });
  }
  const specification = {
    directories: directories.map((name, index) => ({
      name: receiptPath(name),
      mode: index % 2 ? 0o750 : 0o700,
      mtimeSeconds: 1_600_000_000 + index,
    })),
    files: files.map(({ name, bytes, mode, mtimeSeconds }) => ({
      name: receiptPath(name), bytes: bytes.length, sha256: digest(bytes), mode, mtimeSeconds,
    })),
    link: { name: "nested-link", target: "nested", type: "directory" },
  };
  return {
    directories,
    files,
    specification,
    sourceTreeSha256: digest(JSON.stringify(specification)),
  };
}

const PLANS = new Map(SHAPES.map(shape => [shape, fixturePlan(shape)]));
const ROWS = Object.freeze(SHAPES.flatMap(shape => POLICIES.map(clone => {
  const plan = PLANS.get(shape);
  const payloadBytes = plan.files.reduce((sum, file) => sum + file.bytes.length, 0);
  const workloadDetails = Object.freeze({
    schemaVersion: 1,
    publicOperation: "copyTree",
    outcome: "success",
    clonePolicy: clone,
    concurrency: CONCURRENCY,
    shape,
    directories: plan.directories.length,
    files: plan.files.length,
    symbolicLinks: 1,
    payloadBytes,
    largestFileBytes: Math.max(...plan.files.map(file => file.bytes.length)),
    sourceTreeSha256: plan.sourceTreeSha256,
    timedBoundary: "copyTree-call-through-terminal-close-settlement",
    linkPolicy: "relative POSIX directory symlink or absolute Windows directory junction; preserve readlink text and resolved target",
    verification: "setup+exact-paths+sha256+posix-relative-symlink-or-windows-absolute-junction-spelling+resolved-link-target+mode+mtime+independent-destination-mutation+source-preservation",
  });
  return Object.freeze({
    name: `copyTree/settled-success/clone=${clone}/${shape}`,
    clone,
    shape,
    divisor: DIVISOR,
    workloadSemantics: "equivalent-output",
    workloadDetails,
  });
})));

export const COPY_TREE_SUCCESS_NAMES = Object.freeze(ROWS.map(({ name }) => name));

function isProbeTreeSuccessName(name) {
  return typeof name === "string" && name.includes("probeTreeClone");
}

function isCopyTreeSuccessName(name) {
  return typeof name === "string" && name.includes("copyTree/settled-success/");
}

export function copyTreeSuccessDescriptors() {
  return ROWS;
}

export function copyTreeSuccessFixtureReceipt(row, {
  cloneBackend = null,
  nativeMode = "off",
} = {}) {
  const forcedJavaScript = row.clone === "never" || nativeMode === "off";
  return Object.freeze({
    classification: "runner-workspace",
    sameFilesystem: true,
    nativeMode,
    probedCloneBackend: cloneBackend,
    executionPath: forcedJavaScript
      ? "portable-javascript-byte-copy"
      : "automatic-route-unverified",
    autoByteFallbackVerified: row.clone === "auto" && nativeMode === "off" ? true : null,
    sourceTreeSha256: row.workloadDetails.sourceTreeSha256,
  });
}

export function probeTreeSuccessFixtureReceipt(
  cloneBackend,
  nativeMode = "off",
  nativeLoaded = nativeMode === "require",
) {
  return Object.freeze({
    classification: "runner-workspace",
    nativeMode,
    nativeLoaded,
    expectedBackend: cloneBackend,
    executionPath: nativeLoaded
      ? "native-probe-parent-open-close"
      : "native-disabled-or-unavailable-short-circuit",
  });
}

export function validateProbeTreeSuccessWorkloadResult(result) {
  if (!isProbeTreeSuccessName(result.name)) return;
  assert.equal(result.name, "probeTreeClone", `Unknown probeTreeClone success row: ${result.name}`);
  assert.equal(result.skipped, undefined, "probeTreeClone success row was not measured");
  assert.equal(result.workloadSemantics, "equivalent-output",
    "probeTreeClone success workload semantics mismatch");
  assert.deepEqual(result.workloadDetails, PROBE_TREE_SUCCESS_WORKLOAD,
    "probeTreeClone success workload receipt mismatch");
  const receipt = result.fixturePlacement;
  assert(receipt && typeof receipt === "object", "probeTreeClone fixture receipt is missing");
  assert(["off", "auto", "require"].includes(receipt.nativeMode),
    "probeTreeClone native mode receipt is invalid");
  assert.equal(typeof receipt.nativeLoaded, "boolean",
    "probeTreeClone native-loaded receipt is invalid");
  if (receipt.nativeMode === "off") {
    assert.equal(receipt.nativeLoaded, false, "probeTreeClone native-off receipt is invalid");
  }
  if (receipt.nativeMode === "require") {
    assert.equal(receipt.nativeLoaded, true, "probeTreeClone native-required receipt is invalid");
  }
  assert(receipt.expectedBackend === null || BACKENDS.includes(receipt.expectedBackend),
    "probeTreeClone backend receipt is invalid");
  if (receipt.expectedBackend !== null) {
    assert.equal(receipt.nativeLoaded, true, "probeTreeClone backend requires a loaded native binding");
  }
  assert.deepEqual(receipt, probeTreeSuccessFixtureReceipt(
    receipt.expectedBackend,
    receipt.nativeMode,
    receipt.nativeLoaded,
  ),
    "probeTreeClone fixture receipt mismatch");
}

export function validateProbeTreeSuccessReport(report, filter = "", requestedIterations) {
  const selected = !filter || "probeTreeClone".includes(filter);
  const results = (report.results ?? []).filter(({ name }) => isProbeTreeSuccessName(name));
  assert.deepEqual(results.map(({ name }) => name), selected ? ["probeTreeClone"] : [],
    "probeTreeClone success report row set mismatch");
  if (!selected) return;
  validateProbeTreeSuccessWorkloadResult(results[0]);
  if (requestedIterations !== undefined) {
    assert.equal(results[0].iterations, requestedIterations,
      "probeTreeClone success iteration count mismatch");
  }
  if (report.metadata?.mode !== undefined) {
    assert.equal(results[0].fixturePlacement.nativeMode, report.metadata.mode,
      "probeTreeClone report native mode mismatch");
  }
}

export function validateCopyTreeSuccessWorkloadResult(result) {
  if (!isCopyTreeSuccessName(result.name)) return;
  const row = ROWS.find(({ name }) => name === result.name);
  assert(row, `Unknown copyTree success row: ${result.name}`);
  assert.equal(result.skipped, undefined, `copyTree success row was not measured: ${result.name}`);
  assert.equal(result.workloadSemantics, row.workloadSemantics,
    `copyTree success workload semantics mismatch: ${result.name}`);
  assert.deepEqual(result.workloadDetails, row.workloadDetails,
    `copyTree success workload receipt mismatch: ${result.name}`);
  const placement = result.fixturePlacement;
  assert(placement && typeof placement === "object",
    `copyTree success fixture receipt is missing: ${result.name}`);
  assert(placement.probedCloneBackend === null || BACKENDS.includes(placement.probedCloneBackend),
    `copyTree success clone backend is invalid: ${result.name}`);
  assert(["off", "auto", "require"].includes(placement.nativeMode),
    `copyTree success native mode is invalid: ${result.name}`);
  if (placement.nativeMode === "off") {
    assert.equal(placement.probedCloneBackend, null,
      `copyTree success native-off backend mismatch: ${result.name}`);
    assert.equal(placement.executionPath, "portable-javascript-byte-copy",
      `copyTree success native-off execution path mismatch: ${result.name}`);
  }
  assert.deepEqual(
    placement,
    copyTreeSuccessFixtureReceipt(row, {
      cloneBackend: placement.probedCloneBackend,
      nativeMode: placement.nativeMode,
    }),
    `copyTree success fixture receipt mismatch: ${result.name}`,
  );
}

export function validateCopyTreeSuccessReport(report, filter = "", requestedIterations) {
  const expected = ROWS.filter(({ name }) => !filter || name.includes(filter));
  const results = (report.results ?? []).filter(({ name }) => isCopyTreeSuccessName(name));
  assert.deepEqual(results.map(({ name }) => name), expected.map(({ name }) => name),
    "copyTree success report row set mismatch");
  for (const [index, result] of results.entries()) {
    validateCopyTreeSuccessWorkloadResult(result);
    if (requestedIterations !== undefined) {
      assert.equal(
        result.iterations,
        Math.max(1, Math.floor(requestedIterations / expected[index].divisor)),
        `copyTree success iteration count mismatch: ${result.name}`,
      );
    }
    if (report.metadata?.mode !== undefined) {
      assert.equal(result.fixturePlacement.nativeMode, report.metadata.mode,
        `copyTree success report native mode mismatch: ${result.name}`);
    }
  }
}

function captureTree(root) {
  const entries = [];
  const visit = (relative) => {
    const filename = relative ? path.join(root, relative) : root;
    const stat = fs.lstatSync(filename, { bigint: true });
    const common = {
      path: relative,
      mode: process.platform === "win32" ? null : Number(stat.mode & 0o7777n),
      mtimeNs: stat.mtimeNs,
    };
    if (stat.isDirectory()) {
      entries.push({ ...common, kind: "directory" });
      for (const name of fs.readdirSync(filename).sort()) {
        visit(relative ? path.join(relative, name) : name);
      }
    } else if (stat.isFile()) {
      const bytes = fs.readFileSync(filename);
      entries.push({ ...common, kind: "file", bytes: bytes.length, sha256: digest(bytes) });
    } else if (stat.isSymbolicLink()) {
      entries.push({ path: relative, kind: "symbolic-link", target: fs.readlinkSync(filename) });
    } else {
      assert.fail(`unexpected copyTree benchmark entry: ${relative}`);
    }
  };
  visit("");
  return entries;
}

function verifyTree(actualRoot, expected) {
  const actual = captureTree(actualRoot);
  assert.equal(actual.length, expected.length, "copyTree benchmark entry count changed");
  for (let index = 0; index < expected.length; index++) {
    const before = expected[index];
    const after = actual[index];
    assert.equal(after.path, before.path, "copyTree benchmark path changed");
    assert.equal(after.kind, before.kind, `copyTree benchmark kind changed: ${before.path}`);
    if (before.kind === "symbolic-link") {
      assert.equal(after.target, before.target, `copyTree benchmark link changed: ${before.path}`);
      continue;
    }
    assert.equal(after.mode, before.mode, `copyTree benchmark mode changed: ${before.path}`);
    const delta = after.mtimeNs - before.mtimeNs;
    assert(delta >= -MTIME_TOLERANCE_NS && delta <= MTIME_TOLERANCE_NS,
      `copyTree benchmark mtime changed: ${before.path}`);
    if (before.kind === "file") {
      assert.equal(after.bytes, before.bytes, `copyTree benchmark size changed: ${before.path}`);
      assert.equal(after.sha256, before.sha256, `copyTree benchmark hash changed: ${before.path}`);
    }
  }
  return actual;
}

function verifyPlannedFixture(source, plan, actual) {
  const plannedKinds = [
    ...plan.specification.directories.map(({ name }) => ({ path: name, kind: "directory" })),
    ...plan.specification.files.map(({ name }) => ({ path: name, kind: "file" })),
    { path: plan.specification.link.name, kind: "symbolic-link" },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const actualKinds = actual.map(({ path: name, kind }) => ({
    path: receiptPath(name), kind,
  })).sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(actualKinds, plannedKinds, "copyTree benchmark fixture path set mismatch");
  for (const specification of [
    ...plan.specification.directories.map(entry => ({ ...entry, kind: "directory" })),
    ...plan.specification.files.map(entry => ({ ...entry, kind: "file" })),
  ]) {
    const captured = actual.find(entry =>
      receiptPath(entry.path) === specification.name && entry.kind === specification.kind);
    assert(captured, `copyTree benchmark fixture entry missing: ${specification.name}`);
    if (process.platform !== "win32") {
      assert.equal(captured.mode, specification.mode,
        `copyTree benchmark fixture mode mismatch: ${specification.name}`);
    }
    const intendedMtime = BigInt(specification.mtimeSeconds) * 1_000_000_000n;
    const delta = captured.mtimeNs - intendedMtime;
    assert(delta >= -MTIME_TOLERANCE_NS && delta <= MTIME_TOLERANCE_NS,
      `copyTree benchmark fixture mtime mismatch: ${specification.name}`);
    if (specification.kind === "file") {
      assert.equal(captured.bytes, specification.bytes,
        `copyTree benchmark fixture size mismatch: ${specification.name}`);
      assert.equal(captured.sha256, specification.sha256,
        `copyTree benchmark fixture hash mismatch: ${specification.name}`);
    }
  }
  const link = actual.find(entry => entry.kind === "symbolic-link");
  assert(link, "copyTree benchmark fixture link is missing");
  if (process.platform === "win32") {
    assert.equal(path.isAbsolute(link.target), true,
      "copyTree benchmark Windows junction target is not absolute");
  } else {
    assert.equal(link.target, plan.specification.link.target,
      "copyTree benchmark POSIX link text mismatch");
  }
  assert.equal(
    digest(JSON.stringify(plan.specification)),
    plan.sourceTreeSha256,
    "copyTree benchmark portable fixture receipt changed",
  );
}

function populateFixture(source, plan) {
  for (const name of plan.directories.slice(1)) fs.mkdirSync(path.join(source, name), { recursive: true });
  for (const file of plan.files) {
    const filename = path.join(source, file.name);
    fs.writeFileSync(filename, file.bytes);
    if (process.platform !== "win32") fs.chmodSync(filename, file.mode);
    fs.utimesSync(filename, file.mtimeSeconds, file.mtimeSeconds);
  }
  const target = process.platform === "win32" ? path.join(source, "nested") : "nested";
  fs.symlinkSync(target, path.join(source, "nested-link"), process.platform === "win32" ? "junction" : "dir");
  for (const [index, name] of [...plan.directories.entries()].reverse()) {
    const directory = path.join(source, name);
    if (process.platform !== "win32") fs.chmodSync(directory, index % 2 ? 0o750 : 0o700);
    fs.utimesSync(directory, 1_600_000_000 + index, 1_600_000_000 + index);
  }
}

export async function registerCopyTreeSuccess({ api, workspace, register, nativeMode }) {
  const cloneBackend = api.probeTreeClone(workspace) ?? null;
  const fixtures = new Map();
  for (const shape of SHAPES) {
    const plan = PLANS.get(shape);
    const source = path.join(workspace, `copy-tree-success-source-${shape}`);
    if (cloneBackend) await api.createCloneSource(source);
    else fs.mkdirSync(source);
    populateFixture(source, plan);
    const expected = captureTree(source);
    verifyPlannedFixture(source, plan, expected);
    assert.equal(fs.realpathSync(path.join(source, "nested-link")), fs.realpathSync(path.join(source, "nested")),
      "copyTree benchmark fixture link target mismatch");
    fixtures.set(shape, { source, plan, expected });
  }

  ROWS.forEach((row, index) => {
    const fixture = fixtures.get(row.shape);
    const destination = path.join(workspace, `copy-tree-success-target-${index}`);
    const fixturePlacement = copyTreeSuccessFixtureReceipt(row, {
      cloneBackend,
      nativeMode,
    });
    register(row.name, () => api.copyTree(fixture.source, destination, {
      clone: row.clone,
      concurrency: CONCURRENCY,
    }), {
      divisor: row.divisor,
      workloadSemantics: row.workloadSemantics,
      workloadDetails: row.workloadDetails,
      fixturePlacement,
      before: () => {
        assert.equal(fs.existsSync(destination), false, "copyTree benchmark destination already exists");
        assert.deepEqual(captureTree(fixture.source), fixture.expected,
          "copyTree benchmark source changed before timing");
      },
      after: () => {
        try {
          verifyTree(destination, fixture.expected);
          const expectedLinkTarget = process.platform === "win32"
            ? path.join(fixture.source, "nested")
            : path.join(destination, "nested");
          assert.equal(
            fs.realpathSync(path.join(destination, "nested-link")),
            fs.realpathSync(expectedLinkTarget),
            "copyTree benchmark copied link target mismatch",
          );
          const file = fixture.plan.files[0];
          fs.appendFileSync(path.join(destination, file.name), Buffer.from([0xff]));
          assert.deepEqual(captureTree(fixture.source), fixture.expected,
            "copyTree benchmark destination mutation changed its source");
        } finally {
          fs.rmSync(destination, { recursive: true, force: true });
        }
      },
    });
  });
}
