import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const PROOF = "secure-file-split-credential";
const BASE_HEAD = "914cd7b41388876b55e1cca76b46b8eb01e46364";
const BASE_TREE = "eb1d05638cd0ec21cea68a8b189ec3e253a8d903";
const REAL_UID = 61001;
const EFFECTIVE_UID = 61002;
const PROOF_GID = 61003;
const EXPECTED_CONTENT = Buffer.from("fs-safe split-credential synthetic payload\n", "utf8");
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_WORKER_FAILURE_RECEIPT_BYTES = 1024;
const MAX_TRACE_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGE_FILES = 4096;
const MAX_PACKAGE_ENTRIES = 8192;
const MAX_PACKAGE_DEPTH = 32;
const MAX_TOOL_BYTES = 256 * 1024 * 1024;
const MAX_DIAGNOSTIC_FIELDS = 8;
const STAGE_MANIFEST_PROOF = "secure-file-split-credential-stage";
const WORKER_FAILURE_STAGES = new Set([
  "arguments",
  "runtime-identity",
  "credential-before-import",
  "fixture-before-import",
  "public-import",
  "credential-after-import",
  "fixture-after-import",
  "public-read",
  "credential-after-read",
  "fixture-after-read",
]);
const WORKER_FAILURE_CODES = new Set([
  "INVALID_ARGUMENTS",
  "INCOMPLETE_PROC_STATUS",
  "RUNTIME_IDENTITY_MISMATCH",
  "CREDENTIAL_MISMATCH",
  "FIXTURE_MISMATCH",
  "PUBLIC_EXPORT_MISMATCH",
  "NATIVE_MODE_MISMATCH",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOTDIR",
  "EIO",
  "ERR_MODULE_NOT_FOUND",
  "ERR_UNSUPPORTED_DIR_IMPORT",
]);
const NODE_ARCHIVE_SHA256 = new Map([
  ["v22.23.2", "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307"],
  ["v24.20.0", "2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2"],
]);
const BUNDLE_PROOF = "secure-file-split-credential-bundle";
const ARTIFACT_PROOF = "secure-file-split-credential-artifact";
const FAILURE_RECEIPTS = new Set([
  '{"schema":1,"proof":"secure-file-split-credential","overall":false,"failure":{"stage":"workflow-initialization","name":"ProofError","code":"PROOF_NOT_STARTED"},"workflow":{"fallback":true,"receiptAllowlisted":true}}\n',
  '{"schema":1,"proof":"secure-file-split-credential","overall":false,"failure":{"stage":"workflow-fallback","name":"ProofError","code":"RECEIPT_MISSING"},"workflow":{"fallback":true,"receiptAllowlisted":true}}\n',
]);
const ALLOWED_ARGUMENTS = new Set([
  "candidate-bundle",
  "historical-bundle",
  "candidate-attestation",
  "historical-attestation",
  "manifest",
  "coordinator",
  "worker",
  "workflow",
  "proof-parent",
  "receipt",
  "node",
  "prlimit",
  "setpriv",
  "strace",
  "timeout",
  "getent",
  "bash",
  "env",
  "ldd",
  "builder-uid",
  "builder-gid",
  "candidate-head",
  "candidate-tree",
  "historical-head",
  "historical-tree",
  "candidate-artifact-id",
  "candidate-artifact-digest",
  "historical-artifact-id",
  "historical-artifact-digest",
  "run-id",
  "run-attempt",
  "runner-image",
  "runner-image-version",
  "expected-node",
]);
const TOOL_NAMES = [
  "node",
  "prlimit",
  "setpriv",
  "strace",
  "timeout",
  "getent",
  "bash",
  "env",
  "ldd",
];
const STAGED_FILE_NAMES = [...TOOL_NAMES, "coordinator", "worker", "workflow"];
const CASES = [
  {
    case: "equal-owner",
    fixtureRole: "equal-effective-owner-0600",
    libraryRole: "candidate",
    realUid: EFFECTIVE_UID,
    effectiveUid: EFFECTIVE_UID,
    ownerUid: EFFECTIVE_UID,
    mode: 0o600,
    allowReadable: false,
    bounded: true,
    expectedRead: true,
    expectedErrorCode: null,
    auditOnly: false,
  },
  {
    case: "equal-owner",
    fixtureRole: "equal-effective-owner-0600",
    libraryRole: "historical-negative-control",
    realUid: EFFECTIVE_UID,
    effectiveUid: EFFECTIVE_UID,
    ownerUid: EFFECTIVE_UID,
    mode: 0o600,
    allowReadable: false,
    bounded: true,
    expectedRead: true,
    expectedErrorCode: null,
    auditOnly: true,
  },
  {
    case: "split-effective-owner",
    fixtureRole: "effective-owner-0600",
    libraryRole: "candidate",
    realUid: REAL_UID,
    effectiveUid: EFFECTIVE_UID,
    ownerUid: EFFECTIVE_UID,
    mode: 0o600,
    allowReadable: false,
    bounded: true,
    expectedRead: true,
    expectedErrorCode: null,
    auditOnly: false,
  },
  {
    case: "split-effective-owner",
    fixtureRole: "effective-owner-0600",
    libraryRole: "historical-negative-control",
    realUid: REAL_UID,
    effectiveUid: EFFECTIVE_UID,
    ownerUid: EFFECTIVE_UID,
    mode: 0o600,
    allowReadable: false,
    bounded: true,
    expectedRead: false,
    expectedErrorName: "FsSafeError",
    expectedErrorCode: "not-owned",
    auditOnly: true,
  },
  {
    case: "split-real-owner-bounded",
    fixtureRole: "real-owner-group-readable-0640",
    libraryRole: "candidate",
    realUid: REAL_UID,
    effectiveUid: EFFECTIVE_UID,
    ownerUid: REAL_UID,
    mode: 0o640,
    allowReadable: true,
    bounded: true,
    expectedRead: false,
    expectedErrorName: "FsSafeError",
    expectedErrorCode: "not-owned",
    auditOnly: false,
  },
  {
    case: "split-real-owner-bounded",
    fixtureRole: "real-owner-group-readable-0640",
    libraryRole: "historical-negative-control",
    realUid: REAL_UID,
    effectiveUid: EFFECTIVE_UID,
    ownerUid: REAL_UID,
    mode: 0o640,
    allowReadable: true,
    bounded: true,
    expectedRead: true,
    expectedErrorCode: null,
    auditOnly: true,
  },
  {
    case: "split-real-owner-unbounded",
    fixtureRole: "real-owner-group-readable-0640",
    libraryRole: "candidate",
    realUid: REAL_UID,
    effectiveUid: EFFECTIVE_UID,
    ownerUid: REAL_UID,
    mode: 0o640,
    allowReadable: true,
    bounded: false,
    expectedRead: false,
    expectedErrorName: "FsSafeError",
    expectedErrorCode: "not-owned",
    auditOnly: false,
  },
];

let stage = "arguments";
let fixturePath;
let fixtureIdentity;
let proofParentPath;
let proofParentIdentity;
let receiptPath;
let builderUid;
let builderGid;
let rawTracesRemoved = true;
let failureDiagnostic = null;
const caseReceipts = [];
const toolReceipts = {};
const libraryReceipts = {};
const artifactReceipts = {};
const durationsMs = {};
const proofStartedAt = performance.now();
const harnessReceipt = {
  argumentArraySpawn: true,
  shellDisabled: true,
  stagedUnderUsrLocalLib: false,
  rootOwned: false,
  nonWritable: false,
  regularFiles: false,
  linkCountOne: false,
  identityStable: false,
  manifestValidated: false,
  coordinatorSha256: null,
  workerSha256: null,
  workflowSha256: null,
  sourceCopyHashesMatch: false,
  workerCopiesMatch: false,
};
const credentialReceipt = {
  realUid: REAL_UID,
  effectiveUid: EFFECTIVE_UID,
  gid: PROOF_GID,
  idsDistinct: new Set([REAL_UID, EFFECTIVE_UID, PROOF_GID]).size === 3,
  nssUnusedBefore: false,
  procUnusedBefore: false,
  procUnusedAfter: false,
  savedAndFsIdsValidatedByWorker: false,
  groupsClearedByWorker: false,
  capsZeroByWorker: false,
  noNewPrivsByWorker: false,
};
const fixtureReceipt = {
  created: false,
  rootOwned: false,
  nonWritable: false,
  packagesRootOwned: false,
  packagesNonWritable: false,
  secretsExactBefore: false,
  secretsExactAfter: false,
  rawTracesRemoved: false,
  cleanup: false,
};

process.umask(0o077);

function safeDiagnostic(diagnostic) {
  if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return null;
  const clean = {};
  for (const [key, value] of Object.entries(diagnostic).slice(0, MAX_DIAGNOSTIC_FIELDS)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) continue;
    if (typeof value === "boolean" || (Number.isSafeInteger(value) && value >= 0)) {
      clean[key] = value;
    } else if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) {
      clean[key] = value;
    }
  }
  return Object.keys(clean).length === 0 ? null : clean;
}

function proofError(code, diagnostic = null) {
  failureDiagnostic = safeDiagnostic(diagnostic);
  const error = new Error(code);
  error.code = code;
  throw error;
}

function safeToken(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : fallback;
}

function parseArguments(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) proofError("INVALID_ARGUMENTS");
    const name = flag.slice(2);
    if (!ALLOWED_ARGUMENTS.has(name) || parsed.has(name)) proofError("INVALID_ARGUMENTS");
    parsed.set(name, value);
  }
  if (parsed.size !== ALLOWED_ARGUMENTS.size) proofError("INVALID_ARGUMENTS");
  return parsed;
}

function parseId(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) proofError("INVALID_ARGUMENTS");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) proofError("INVALID_ARGUMENTS");
  return number;
}

function validateSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) proofError("INVALID_REVISION");
  return value;
}

function validateDigest(value) {
  if (!/^[0-9a-f]{64}$/.test(value)) proofError("INVALID_ARTIFACT_DIGEST");
  return value;
}

function validatePositiveIntegerToken(value, code = "INVALID_ARGUMENTS") {
  if (!/^[1-9][0-9]*$/.test(value)) proofError(code);
  return value;
}

function validateSafeLabel(value, fallback = null) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : fallback;
}

async function timed(name, operation) {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    durationsMs[name] = Math.round((performance.now() - started) * 1000) / 1000;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identitiesMatch(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function stableReadFile(
  file,
  expectedOwner,
  limit = MAX_PACKAGE_BYTES,
  expectedGid = expectedOwner === 0 ? 0 : builderGid,
  diagnosticName = "file",
) {
  const before = await fs.lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.uid !== BigInt(expectedOwner) ||
    before.gid !== BigInt(expectedGid) ||
    (before.mode & 0o022n) !== 0n ||
    (before.mode & 0o7000n) !== 0n ||
    before.size < 0n ||
    before.size > BigInt(limit)
  ) {
    proofError("UNTRUSTED_SOURCE_FILE", {
      subject: diagnosticName,
      reason: "metadata",
      uid: Number(before.uid),
      gid: Number(before.gid),
      mode: Number(before.mode & 0o7777n),
      links: Number(before.nlink),
    });
  }
  const handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !identitiesMatch(before, opened) ||
      opened.size !== before.size ||
      opened.uid !== before.uid ||
      opened.gid !== before.gid ||
      opened.mode !== before.mode ||
      opened.nlink !== 1n
    ) {
      proofError("SOURCE_FILE_CHANGED", { subject: diagnosticName, reason: "open-identity" });
    }
    const buffer = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !identitiesMatch(opened, after) ||
      after.size !== opened.size ||
      after.uid !== opened.uid ||
      after.gid !== opened.gid ||
      after.mode !== opened.mode ||
      after.nlink !== 1n ||
      BigInt(buffer.length) !== opened.size
    ) {
      proofError("SOURCE_FILE_CHANGED", { subject: diagnosticName, reason: "read-identity" });
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

async function writeRootFile(destination, buffer, mode = 0o444) {
  const handle = await fs.open(destination, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT |
    fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chown(destination, 0, 0);
  await fs.chmod(destination, mode);
}

async function validateArtifactDirectory(directory, diagnosticName) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(builderUid) ||
    stat.gid !== BigInt(builderGid) ||
    (stat.mode & 0o022n) !== 0n ||
    (stat.mode & 0o7000n) !== 0n
  ) {
    proofError("UNTRUSTED_SOURCE_DIRECTORY", {
      subject: diagnosticName,
      reason: "metadata",
      uid: Number(stat.uid),
      gid: Number(stat.gid),
      mode: Number(stat.mode & 0o7777n),
    });
  }
  return stat;
}

function parseJson(buffer, code) {
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    proofError(code);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) proofError(code);
  return value;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

async function rejectExecutableArtifact(file, diagnosticName) {
  const stat = await fs.lstat(file, { bigint: true });
  if ((stat.mode & 0o111n) !== 0n) {
    proofError("EXECUTABLE_ARTIFACT_REJECTED", {
      subject: diagnosticName,
      reason: "executable",
      mode: Number(stat.mode & 0o7777n),
    });
  }
}

async function validateAttestation(file, expected) {
  await rejectExecutableArtifact(file, `${expected.role}-attestation`);
  const buffer = await stableReadFile(file, builderUid, 16 * 1024, builderGid, `${expected.role}-attestation`);
  const value = parseJson(buffer, "INVALID_ARTIFACT_ATTESTATION");
  const canonical = `${JSON.stringify({
    schema: 1,
    proof: ARTIFACT_PROOF,
    role: expected.role,
    node: expected.node,
    runId: expected.runId,
    runAttempt: expected.runAttempt,
    artifactName: expected.artifactName,
    artifactId: expected.artifactId,
    artifactDigest: expected.artifactDigest,
  })}\n`;
  if (
    !hasExactKeys(value, [
      "schema",
      "proof",
      "role",
      "node",
      "runId",
      "runAttempt",
      "artifactName",
      "artifactId",
      "artifactDigest",
    ]) ||
    value.schema !== 1 ||
    value.proof !== ARTIFACT_PROOF ||
    value.role !== expected.role ||
    value.node !== expected.node ||
    value.runId !== expected.runId ||
    value.runAttempt !== expected.runAttempt ||
    value.artifactName !== expected.artifactName ||
    value.artifactId !== expected.artifactId ||
    value.artifactDigest !== expected.artifactDigest ||
    buffer.toString("utf8") !== canonical
  ) {
    proofError("ARTIFACT_IDENTITY_MISMATCH", { role: expected.receiptRole, reason: "attestation" });
  }
  return {
    id: value.artifactId,
    digest: value.artifactDigest,
    nameSha256: sha256(value.artifactName),
    attestationSha256: sha256(buffer),
    exactRoleBinding: true,
    selectedByArtifactId: true,
    artifactDigestBound: true,
    transportDigestVerifiedByPinnedAction: true,
  };
}

async function validateBundle(root, expected) {
  const canonical = await fs.realpath(root);
  if (canonical !== root) {
    proofError("NONCANONICAL_BUNDLE", { role: expected.receiptRole, reason: "root" });
  }
  await validateArtifactDirectory(root, `${expected.receiptRole}-bundle`);
  const top = await fs.readdir(root, { withFileTypes: true });
  top.sort((left, right) => left.name.localeCompare(right.name));
  if (
    JSON.stringify(top.map((entry) => entry.name)) !==
      JSON.stringify(["dist", "package.json", "provenance.json"])
  ) {
    proofError("UNEXPECTED_BUNDLE_ENTRY", { role: expected.receiptRole, reason: "top-level" });
  }

  const pending = [{ relative: "dist", depth: 1 }];
  const files = [];
  let totalBytes = 0;
  let entryCount = 0;
  while (pending.length > 0) {
    const { relative, depth } = pending.pop();
    if (depth > MAX_PACKAGE_DEPTH) {
      proofError("BUNDLE_DEPTH_LIMIT", { role: expected.receiptRole, reason: "depth" });
    }
    const directory = path.join(root, ...relative.split("/"));
    await validateArtifactDirectory(directory, `${expected.receiptRole}-dist`);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_PACKAGE_ENTRIES) {
        proofError("BUNDLE_ENTRY_LIMIT", { role: expected.receiptRole, reason: "count" });
      }
      if (
        !/^[A-Za-z0-9._@+-]{1,255}$/.test(entry.name) ||
        entry.name.startsWith(".") ||
        entry.name === "." ||
        entry.name === ".."
      ) {
        proofError("INVALID_BUNDLE_ENTRY", { role: expected.receiptRole, reason: "name" });
      }
      const childRelative = `${relative}/${entry.name}`;
      const child = path.join(root, ...childRelative.split("/"));
      const stat = await fs.lstat(child, { bigint: true });
      if (stat.isSymbolicLink()) {
        proofError("UNTRUSTED_SOURCE_SYMLINK", { role: expected.receiptRole, reason: "symlink" });
      }
      if (stat.isDirectory()) {
        pending.push({ relative: childRelative, depth: depth + 1 });
        continue;
      }
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.uid !== BigInt(builderUid) ||
        stat.gid !== BigInt(builderGid) ||
        (stat.mode & 0o111n) !== 0n ||
        (stat.mode & 0o7022n) !== 0n
      ) {
        proofError("UNTRUSTED_SOURCE_ENTRY", {
          role: expected.receiptRole,
          reason: "metadata",
          uid: Number(stat.uid),
          gid: Number(stat.gid),
          mode: Number(stat.mode & 0o7777n),
          links: Number(stat.nlink),
        });
      }
      files.push(childRelative.slice("dist/".length));
      totalBytes += Number(stat.size);
      if (files.length > MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES) {
        proofError("PACKAGE_TOO_LARGE", { role: expected.receiptRole, reason: "bounds" });
      }
    }
  }
  files.sort();
  if (files.length === 0 || totalBytes === 0) proofError("EMPTY_DIST", { role: expected.receiptRole });

  const packagePath = path.join(root, "package.json");
  const provenancePath = path.join(root, "provenance.json");
  await rejectExecutableArtifact(packagePath, `${expected.receiptRole}-package`);
  await rejectExecutableArtifact(provenancePath, `${expected.receiptRole}-provenance`);
  const packageBuffer = await stableReadFile(
    packagePath,
    builderUid,
    1024 * 1024,
    builderGid,
    `${expected.receiptRole}-package`,
  );
  const provenanceBuffer = await stableReadFile(
    provenancePath,
    builderUid,
    16 * 1024,
    builderGid,
    `${expected.receiptRole}-provenance`,
  );
  const packageJson = parseJson(packageBuffer, "INVALID_PACKAGE_JSON");
  if (
    packageJson.name !== "@openclaw/fs-safe" ||
    packageJson.type !== "module" ||
    packageJson.exports?.["./config"]?.default !== "./dist/config.js" ||
    packageJson.exports?.["./secure-file"]?.default !== "./dist/secure-file.js" ||
    !files.includes("config.js") ||
    !files.includes("secure-file.js")
  ) {
    proofError("PUBLIC_EXPORT_MISMATCH", { role: expected.receiptRole });
  }
  const provenance = parseJson(provenanceBuffer, "INVALID_BUNDLE_PROVENANCE");
  const canonicalProvenance = `${JSON.stringify({
    schema: 1,
    proof: BUNDLE_PROOF,
    role: expected.role,
    node: expected.node,
    runId: expected.runId,
    runAttempt: expected.runAttempt,
    head: expected.head,
    tree: expected.tree,
    builtUnprivileged: true,
    allowedTopLevel: ["dist", "package.json", "provenance.json"],
  })}\n`;
  if (
    !hasExactKeys(provenance, [
      "schema",
      "proof",
      "role",
      "node",
      "runId",
      "runAttempt",
      "head",
      "tree",
      "builtUnprivileged",
      "allowedTopLevel",
    ]) ||
    provenance.schema !== 1 ||
    provenance.proof !== BUNDLE_PROOF ||
    provenance.role !== expected.role ||
    provenance.node !== expected.node ||
    provenance.runId !== expected.runId ||
    provenance.runAttempt !== expected.runAttempt ||
    provenance.head !== expected.head ||
    provenance.tree !== expected.tree ||
    provenance.builtUnprivileged !== true ||
    JSON.stringify(provenance.allowedTopLevel) !==
      JSON.stringify(["dist", "package.json", "provenance.json"]) ||
    provenanceBuffer.toString("utf8") !== canonicalProvenance
  ) {
    proofError("BUNDLE_PROVENANCE_MISMATCH", { role: expected.receiptRole, reason: "binding" });
  }

  const manifest = [];
  for (const relative of files) {
    const buffer = await stableReadFile(
      path.join(root, "dist", ...relative.split("/")),
      builderUid,
      MAX_PACKAGE_BYTES,
      builderGid,
      `${expected.receiptRole}-dist-file`,
    );
    manifest.push(`${relative}\0${buffer.length}\0${sha256(buffer)}\n`);
  }
  return {
    root,
    role: expected.role,
    packageBuffer,
    packageSha256: sha256(packageBuffer),
    provenanceSha256: sha256(provenanceBuffer),
    files,
    bytes: totalBytes,
    entries: entryCount,
    distSha256: sha256(manifest.join("")),
  };
}

async function copyDirectory(bundle, destination) {
  const files = bundle.files;
  let total = 0;
  const manifest = [];
  await fs.mkdir(destination, { recursive: true, mode: 0o555 });
  for (const relative of files) {
    const sourceFile = path.join(bundle.root, "dist", ...relative.split("/"));
    const destinationFile = path.join(destination, ...relative.split("/"));
    const buffer = await stableReadFile(
      sourceFile,
      builderUid,
      MAX_PACKAGE_BYTES,
      builderGid,
      `${bundle.role}-dist-copy`,
    );
    total += buffer.length;
    if (total > MAX_PACKAGE_BYTES) proofError("PACKAGE_TOO_LARGE");
    await fs.mkdir(path.dirname(destinationFile), { recursive: true, mode: 0o555 });
    await writeRootFile(destinationFile, buffer);
    const copied = await stableReadFile(destinationFile, 0);
    if (!copied.equals(buffer)) proofError("PACKAGE_COPY_MISMATCH");
    manifest.push(`${relative}\0${copied.length}\0${sha256(copied)}\n`);
  }
  const directories = [destination];
  for (const file of files) {
    let current = path.dirname(path.join(destination, ...file.split("/")));
    while (current.startsWith(`${destination}${path.sep}`)) {
      directories.push(current);
      current = path.dirname(current);
    }
  }
  for (const directory of new Set(directories)) {
    await fs.chown(directory, 0, 0);
    await fs.chmod(directory, 0o555);
  }
  return { sha256: sha256(manifest.join("")), files: files.length, bytes: total };
}

async function copyLibrary(bundle, destinationRoot, role) {
  const packageBuffer = bundle.packageBuffer;
  const packageRoot = path.join(destinationRoot, "node_modules", "@openclaw", "fs-safe");
  await fs.mkdir(packageRoot, { recursive: true, mode: 0o555 });
  await writeRootFile(path.join(packageRoot, "package.json"), packageBuffer);
  const dist = await copyDirectory(bundle, path.join(packageRoot, "dist"));
  if (dist.files === 0 || dist.bytes === 0) proofError("EMPTY_DIST");
  if (dist.sha256 !== bundle.distSha256 || dist.bytes !== bundle.bytes) {
    proofError("PACKAGE_COPY_MISMATCH", { role: safeToken(role, "unknown"), reason: "manifest" });
  }
  for (const directory of [
    packageRoot,
    path.dirname(packageRoot),
    path.dirname(path.dirname(packageRoot)),
    destinationRoot,
  ]) {
    await fs.chown(directory, 0, 0);
    await fs.chmod(directory, 0o555);
  }
  const copiedPackage = await stableReadFile(path.join(packageRoot, "package.json"), 0, 1024 * 1024);
  if (!copiedPackage.equals(packageBuffer)) proofError("PACKAGE_COPY_MISMATCH");
  return {
    role,
    builtUnprivileged: true,
    rootOwnedCopy: true,
    packageExportsValidated: true,
    distSha256: dist.sha256,
    distFilesPositive: dist.files > 0,
    distBytesPositive: dist.bytes > 0,
    packageSha256: sha256(packageBuffer),
    provenanceSha256: bundle.provenanceSha256,
    copyExact: true,
  };
}

async function validateTrustedAncestors(target, diagnosticName) {
  let current = path.dirname(target);
  let count = 0;
  for (;;) {
    const canonical = await fs.realpath(current);
    const stat = await fs.lstat(current, { bigint: true });
    if (
      canonical !== current ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0n ||
      stat.gid !== 0n ||
      (stat.mode & 0o022n) !== 0n ||
      (stat.mode & 0o7000n) !== 0n
    ) {
      proofError("UNTRUSTED_TOOL_ANCESTOR", {
        tool: diagnosticName,
        reason: "ancestor",
        uid: Number(stat.uid),
        gid: Number(stat.gid),
        mode: Number(stat.mode & 0o7777n),
      });
    }
    count += 1;
    if (current === path.parse(current).root) break;
    current = path.dirname(current);
  }
  return count;
}

async function inspectTrustedFile(file, diagnosticName, executable) {
  if (!path.isAbsolute(file)) {
    proofError("INVALID_TOOL_PATH", { tool: diagnosticName, reason: "relative" });
  }
  const canonical = await fs.realpath(file);
  if (canonical !== file) {
    proofError("NONCANONICAL_TOOL_PATH", { tool: diagnosticName, reason: "canonical" });
  }
  const ancestorCount = await validateTrustedAncestors(canonical, diagnosticName);
  const stat = await fs.lstat(canonical, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.uid !== 0n ||
    stat.gid !== 0n ||
    (stat.mode & 0o022n) !== 0n ||
    (stat.mode & 0o7000n) !== 0n ||
    (executable && (stat.mode & 0o111n) === 0n)
  ) {
    proofError("UNTRUSTED_TOOL", {
      tool: diagnosticName,
      reason: "metadata",
      uid: Number(stat.uid),
      gid: Number(stat.gid),
      mode: Number(stat.mode & 0o7777n),
      links: Number(stat.nlink),
    });
  }
  let buffer;
  try {
    buffer = await stableReadFile(canonical, 0, MAX_TOOL_BYTES, 0, diagnosticName);
  } catch (error) {
    failureDiagnostic = safeDiagnostic({
      tool: diagnosticName,
      reason: safeToken(error?.code, "stable-read"),
    });
    throw error;
  }
  return {
    path: canonical,
    stat,
    sha256: sha256(buffer),
    bytes: buffer.length,
    ancestorCount,
  };
}

function sameTrustedIdentity(left, right) {
  return left.stat.dev === right.stat.dev &&
    left.stat.ino === right.stat.ino &&
    left.stat.size === right.stat.size &&
    left.stat.mode === right.stat.mode &&
    left.sha256 === right.sha256;
}

async function loadStageManifest(manifestPath, expectedNode) {
  await inspectTrustedFile(manifestPath, "manifest", false);
  const buffer = await stableReadFile(manifestPath, 0, 1024 * 1024, 0, "manifest");
  const value = parseJson(buffer, "INVALID_STAGE_MANIFEST");
  if (
    !hasExactKeys(value, ["schema", "proof", "nodeArchive", "entries"]) ||
    value.schema !== 1 ||
    value.proof !== STAGE_MANIFEST_PROOF ||
    value.entries === null ||
    typeof value.entries !== "object" ||
    Array.isArray(value.entries) ||
    JSON.stringify(Object.keys(value.entries).sort()) !== JSON.stringify([...STAGED_FILE_NAMES].sort()) ||
    buffer.toString("utf8") !== `${JSON.stringify(value)}\n`
  ) {
    proofError("INVALID_STAGE_MANIFEST", { subject: "manifest", reason: "shape" });
  }
  if (
    !hasExactKeys(value.nodeArchive, ["version", "sha256"]) ||
    !NODE_ARCHIVE_SHA256.has(expectedNode) ||
    value.nodeArchive.version !== expectedNode ||
    value.nodeArchive.sha256 !== NODE_ARCHIVE_SHA256.get(expectedNode)
  ) {
    proofError("INVALID_NODE_ARCHIVE_PROVENANCE", { subject: "node", reason: "archive" });
  }
  for (const name of STAGED_FILE_NAMES) {
    const entry = value.entries[name];
    if (
      !hasExactKeys(entry, ["sourceSha256", "copySha256"]) ||
      !/^[0-9a-f]{64}$/.test(entry.sourceSha256) ||
      !/^[0-9a-f]{64}$/.test(entry.copySha256) ||
      entry.sourceSha256 !== entry.copySha256
    ) {
      proofError("STAGE_HASH_MISMATCH", { subject: name, reason: "source-copy" });
    }
  }
  return { value, sha256: sha256(buffer) };
}

async function validateLoaderEnvironment() {
  const allowed = ["HOME", "LANG", "LC_ALL", "PATH", "TZ"];
  const actual = Object.keys(process.env).sort();
  if (
    JSON.stringify(actual) !== JSON.stringify([...allowed].sort()) ||
    actual.some((name) => name.startsWith("LD_")) ||
    ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "BUN_OPTIONS"].some(
      (name) => process.env[name] !== undefined,
    )
  ) {
    proofError("UNSAFE_PROCESS_ENVIRONMENT", { subject: "environment", reason: "allowlist" });
  }
  try {
    const preload = await stableReadFile("/etc/ld.so.preload", 0, 4096, 0, "ld-preload");
    if (preload.toString("utf8").trim() !== "") {
      proofError("LD_PRELOAD_CONFIGURED", { subject: "loader", reason: "preload" });
    }
    return { environmentAllowlisted: true, ldSoPreload: "empty" };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { environmentAllowlisted: true, ldSoPreload: "absent" };
    }
    throw error;
  }
}

async function validateDynamicDependencies(toolName, tool, tools) {
  if (toolName === "ldd") return { count: 0, manifestSha256: sha256("script") };
  const result = await runCapture(tools.bash.path, [tools.ldd.path, tool.path], {
    timeoutMs: 10_000,
  });
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.overflow ||
    result.spawnFailed ||
    result.stderr.length !== 0
  ) {
    proofError("DEPENDENCY_RESOLUTION_FAILED", { tool: toolName, reason: "ldd" });
  }
  const records = [];
  for (const rawLine of result.stdout.toString("utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("linux-vdso.so.")) continue;
    if (line.includes("not found")) {
      proofError("DEPENDENCY_NOT_FOUND", { tool: toolName, reason: "not-found" });
    }
    if (line === "statically linked" || line === "not a dynamic executable") continue;
    const linked = line.match(/=>\s+(\/[^\s]+)\s+\(0x[0-9a-fA-F]+\)$/u);
    const direct = line.match(/^(\/[^\s]+)\s+\(0x[0-9a-fA-F]+\)$/u);
    const supplied = linked?.[1] ?? direct?.[1];
    if (supplied === undefined) {
      proofError("DEPENDENCY_OUTPUT_UNRECOGNIZED", { tool: toolName, reason: "format" });
    }
    const canonical = await fs.realpath(supplied);
    await validateTrustedAncestors(canonical, `${toolName}-dependency`);
    const stat = await fs.lstat(canonical, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.uid !== 0n ||
      stat.gid !== 0n ||
      (stat.mode & 0o022n) !== 0n ||
      (stat.mode & 0o7000n) !== 0n
    ) {
      proofError("UNTRUSTED_DEPENDENCY", {
        tool: toolName,
        reason: "metadata",
        uid: Number(stat.uid),
        gid: Number(stat.gid),
        mode: Number(stat.mode & 0o7777n),
        links: Number(stat.nlink),
      });
    }
    const buffer = await stableReadFile(canonical, 0, MAX_TOOL_BYTES, 0, `${toolName}-dependency`);
    records.push(`${path.basename(canonical)}\0${buffer.length}\0${sha256(buffer)}\n`);
  }
  records.sort();
  return { count: records.length, manifestSha256: sha256(records.join("")) };
}

async function validateStagedHarnessAndTools(args, expectedNode, expectedStageDirectory) {
  const manifest = await loadStageManifest(args.manifest, expectedNode);
  const inspected = {};
  for (const name of STAGED_FILE_NAMES) {
    inspected[name] = await inspectTrustedFile(args[name], name, TOOL_NAMES.includes(name));
    if (inspected[name].sha256 !== manifest.value.entries[name].copySha256) {
      proofError("STAGE_HASH_MISMATCH", { subject: name, reason: "copy" });
    }
  }
  if (
    path.dirname(args.coordinator) !== expectedStageDirectory ||
    path.dirname(args.coordinator) !== path.dirname(args.node) ||
    STAGED_FILE_NAMES.some((name) => path.dirname(args[name]) !== path.dirname(args.coordinator)) ||
    fileURLToPath(import.meta.url) !== args.coordinator
  ) {
    proofError("UNEXPECTED_HARNESS_SOURCE", { subject: "harness", reason: "stage-root" });
  }
  const processExecutable = await fs.realpath(process.execPath);
  if (
    processExecutable !== args.node ||
    process.version !== expectedNode ||
    inspected.node.sha256 !== manifest.value.entries.node.copySha256
  ) {
    proofError("NODE_EXECUTABLE_MISMATCH", { tool: "node", reason: "execPath" });
  }

  const tools = {};
  for (const name of TOOL_NAMES) {
    tools[name] = { path: inspected[name].path, receipt: null };
  }
  const dependencies = {};
  for (const name of TOOL_NAMES) {
    dependencies[name] = await validateDynamicDependencies(name, tools[name], tools);
  }
  for (const name of TOOL_NAMES) {
    const beforeVersion = await inspectTrustedFile(args[name], name, true);
    if (!sameTrustedIdentity(inspected[name], beforeVersion)) {
      proofError("TOOL_IDENTITY_CHANGED", { tool: name, reason: "pre-version" });
    }
    const command = name === "ldd" ? tools.bash.path : tools[name].path;
    const versionArgs = name === "ldd" ? [tools.ldd.path, "--version"] : ["--version"];
    const version = await runCapture(command, versionArgs, { timeoutMs: 10_000 });
    const output = Buffer.concat([version.stdout, version.stderr]);
    if (
      version.code !== 0 ||
      version.signal !== null ||
      version.timedOut ||
      version.overflow ||
      version.spawnFailed ||
      output.length === 0
    ) {
      proofError("TOOL_VERSION_FAILED", { tool: name, reason: "version" });
    }
    if (name === "node" && output.toString("utf8").trim() !== expectedNode) {
      proofError("NODE_VERSION_MISMATCH", { tool: "node", reason: "version" });
    }
    const after = await inspectTrustedFile(args[name], name, true);
    if (!sameTrustedIdentity(inspected[name], after)) {
      proofError("TOOL_IDENTITY_CHANGED", { tool: name, reason: "post-version" });
    }
    tools[name].receipt = {
      available: true,
      rootOwned: true,
      notGroupOrWorldWritable: true,
      noSpecialBits: true,
      regularExecutable: true,
      linkCountOne: true,
      identityStable: true,
      deviceIdentityChecked: true,
      inodeIdentityChecked: true,
      bytes: inspected[name].bytes,
      ancestorCount: inspected[name].ancestorCount,
      sourceSha256: manifest.value.entries[name].sourceSha256,
      copySha256: inspected[name].sha256,
      sourceCopyHashesMatch: true,
      versionSha256: sha256(output),
      dependencies: dependencies[name],
    };
  }
  return { tools, inspected, manifest };
}

function minimalEnvironment(home) {
  return {
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TZ: "UTC",
  };
}

async function runCapture(command, args, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? minimalEnvironment("/"),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;
    const killGroup = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The process group may already be gone.
        }
      }
    };
    const append = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length > MAX_CAPTURE_BYTES) {
        overflow = true;
        killGroup();
        return combined.subarray(0, MAX_CAPTURE_BYTES);
      }
      return combined;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", () => {
      spawnFailed = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs ?? 40_000);
    timer.unref();
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal: safeToken(signal, null),
        stdout,
        stderr,
        overflow,
        timedOut,
        spawnFailed,
      });
    });
  });
}

async function assertNssIdsUnused(getentPath) {
  for (const database of ["passwd", "group"]) {
    for (const id of [REAL_UID, EFFECTIVE_UID, PROOF_GID]) {
      const result = await runCapture(getentPath, [database, String(id)], { timeoutMs: 10_000 });
      if (
        result.code !== 2 ||
        result.timedOut ||
        result.overflow ||
        result.spawnFailed ||
        result.stdout.length !== 0 ||
        result.stderr.length !== 0
      ) {
        proofError("CREDENTIAL_ID_IN_USE_OR_NSS_UNKNOWN");
      }
    }
  }
}

function parseProcIds(status) {
  const values = [];
  for (const line of status.split("\n")) {
    if (/^(?:Uid|Gid|Groups):/.test(line)) {
      const separator = line.indexOf(":");
      for (const value of line.slice(separator + 1).trim().split(/\s+/).filter(Boolean)) {
        if (/^[0-9]+$/.test(value)) values.push(Number(value));
      }
    }
  }
  return values;
}

async function assertProcIdsUnused() {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
    try {
      const status = await fs.readFile(`/proc/${entry.name}/status`, "utf8");
      const ids = parseProcIds(status);
      if (ids.includes(REAL_UID) || ids.includes(EFFECTIVE_UID) || ids.includes(PROOF_GID)) {
        proofError("CREDENTIAL_ID_IN_USE");
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    }
  }
}

async function makeSecret(directory, name, ownerUid, mode) {
  const secret = path.join(directory, name);
  await writeRootFile(secret, EXPECTED_CONTENT, 0o600);
  await fs.chown(secret, ownerUid, PROOF_GID);
  await fs.chmod(secret, mode);
  const stat = await fs.lstat(secret, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(ownerUid) ||
    stat.gid !== BigInt(PROOF_GID) ||
    (stat.mode & 0o777n) !== BigInt(mode)
  ) {
    proofError("FIXTURE_CREATION_FAILED");
  }
  const content = await fs.readFile(secret);
  if (!content.equals(EXPECTED_CONTENT)) proofError("FIXTURE_CONTENT_MISMATCH");
  return { path: secret, dev: stat.dev, ino: stat.ino, ownerUid, mode };
}

async function validateSecret(secret) {
  const stat = await fs.lstat(secret.path, { bigint: true });
  const content = await fs.readFile(secret.path);
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1n &&
    stat.dev === secret.dev &&
    stat.ino === secret.ino &&
    stat.uid === BigInt(secret.ownerUid) &&
    stat.gid === BigInt(PROOF_GID) &&
    (stat.mode & 0o777n) === BigInt(secret.mode) &&
    content.equals(EXPECTED_CONTENT)
  );
}

function parseWorkerReceipt(output, spec) {
  if (output.length === 0 || output.length > MAX_CAPTURE_BYTES) proofError("WORKER_RECEIPT_MISSING");
  const text = output.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) proofError("WORKER_RECEIPT_INVALID");
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    proofError("WORKER_RECEIPT_INVALID");
  }
  const credentialObservationComplete = (observation) =>
    observation?.all === true &&
    observation.real === true &&
    observation.effective === true &&
    observation.saved === true &&
    observation.fs === true &&
    observation.groupsCleared === true &&
    observation.capsZero === true &&
    observation.noNewPrivs === true &&
    observation.processApi === true;
  if (
    receipt?.schema !== 1 ||
    receipt.workerComplete !== true ||
    receipt.case !== spec.case ||
    receipt.libraryRole !== spec.libraryRole ||
    receipt.bounded !== spec.bounded ||
    receipt.publicPackageExports?.config !== true ||
    receipt.publicPackageExports?.secureFile !== true ||
    receipt.nativeOff !== true ||
    receipt.runtime?.versionExact !== true ||
    receipt.runtime?.execPathExact !== true ||
    !credentialObservationComplete(receipt.credential?.beforeImport) ||
    !credentialObservationComplete(receipt.credential?.afterImport) ||
    !credentialObservationComplete(receipt.credential?.afterRead) ||
    receipt.fixture?.beforeImport !== true ||
    receipt.fixture?.afterImport !== true ||
    receipt.fixture?.afterRead !== true ||
    receipt.fixture?.identityStable !== true
  ) {
    proofError("WORKER_RECEIPT_INCOMPLETE");
  }
  return receipt;
}

function parseWorkerFailureReceipt(output) {
  if (output.length === 0 || output.length > MAX_WORKER_FAILURE_RECEIPT_BYTES) return null;
  const text = output.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) return null;
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(",") !== "error,schema,stage,workerComplete" ||
    receipt.schema !== 1 ||
    receipt.workerComplete !== false ||
    !WORKER_FAILURE_STAGES.has(receipt.stage) ||
    receipt.error === null ||
    typeof receipt.error !== "object" ||
    Array.isArray(receipt.error) ||
    Object.keys(receipt.error).sort().join(",") !== "code,name" ||
    typeof receipt.error.name !== "string" ||
    !WORKER_FAILURE_CODES.has(receipt.error.code)
  ) {
    return null;
  }
  return { workerStage: receipt.stage, workerCode: receipt.error.code };
}

function workerExecutionFailureDiagnostic(run) {
  const reason = run.spawnFailed
    ? "spawn-failed"
    : run.timedOut
      ? "timeout"
      : run.overflow
        ? "overflow"
        : run.signal !== null
          ? "signal"
          : run.code !== 0
            ? "nonzero-exit"
            : run.stderr.length !== 0
              ? "stderr"
              : "unknown";
  const workerFailure = parseWorkerFailureReceipt(run.stdout);
  return {
    reason,
    ...(Number.isSafeInteger(run.code) && run.code >= 0 ? { exitCode: run.code } : {}),
    stdoutBytes: run.stdout.length,
    stderrBytes: run.stderr.length,
    ...(workerFailure ?? {}),
  };
}

function parseTrace(trace, secretPath) {
  if (trace.length === 0 || trace.length > MAX_TRACE_BYTES) proofError("TRACE_INCOMPLETE");
  const text = trace.toString("utf8");
  if (text.includes("<unfinished ...>") || text.includes("resumed>") || text.includes("detached")) {
    proofError("TRACE_INCOMPLETE");
  }
  const targetFds = new Set();
  let successfulOpen = 0;
  let successfulClose = 0;
  let readAttempts = 0;
  let positiveReadBytes = 0;
  for (const line of text.split("\n").filter(Boolean)) {
    if (/\b(?:open|openat|openat2)\(/.test(line)) {
      const result = line.match(/=\s*(-?[0-9]+)(?:<([^>]*)>)?\s*$/);
      if (!line.includes(secretPath) || result === null) proofError("TRACE_UNKNOWN_OPEN");
      const fd = Number(result[1]);
      if (fd >= 0) {
        if (
          !line.includes("O_RDONLY") ||
          /\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b/u.test(line)
        ) {
          proofError("TRACE_UNSAFE_OPEN");
        }
        successfulOpen += 1;
        targetFds.add(fd);
      }
      continue;
    }
    const read = line.match(/\b(read|readv|pread64|preadv|preadv2)\(([0-9]+)(?:<([^>]*)>)?.*=\s*(-?[0-9]+)(?:\s|$)/);
    if (read !== null) {
      const fd = Number(read[2]);
      const decodedPath = read[3];
      if (targetFds.has(fd) || decodedPath === secretPath) {
        readAttempts += 1;
        const bytes = Number(read[4]);
        if (bytes > 0) positiveReadBytes += bytes;
      }
      continue;
    }
    const close = line.match(/\bclose\(([0-9]+)(?:<([^>]*)>)?\)\s*=\s*(-?[0-9]+)/);
    if (close !== null) {
      const fd = Number(close[1]);
      const decodedPath = close[2];
      if (targetFds.has(fd) || decodedPath === secretPath) {
        if (Number(close[3]) === 0) successfulClose += 1;
        targetFds.delete(fd);
      }
      continue;
    }
    proofError("TRACE_UNKNOWN_MECHANISM");
  }
  if (successfulOpen !== 1 || successfulClose !== 1 || targetFds.size !== 0) {
    proofError("TRACE_LIFECYCLE_INCOMPLETE");
  }
  return { successfulOpen, successfulClose, readAttempts, positiveReadBytes };
}

function modeString(mode) {
  return mode.toString(8).padStart(4, "0");
}

async function runProofCase(spec, libraries, secrets, tools) {
  stage = `case-${spec.case}-${spec.libraryRole}`;
  await assertProcIdsUnused();
  const library = spec.libraryRole === "candidate" ? libraries.candidate : libraries.baseline;
  const worker = path.join(library, "worker.mjs");
  const secret = spec.ownerUid === EFFECTIVE_UID
    ? (spec.case === "equal-owner" ? secrets.equal : secrets.effective)
    : secrets.real;
  const tracePath = path.join(fixturePath, "traces", `${caseReceipts.length}.trace`);
  const workerArgs = [
    "--case", spec.case,
    "--library-role", spec.libraryRole,
    "--secret", secret.path,
    "--real-uid", String(spec.realUid),
    "--effective-uid", String(spec.effectiveUid),
    "--gid", String(PROOF_GID),
    "--owner-uid", String(spec.ownerUid),
    "--mode", modeString(spec.mode),
    "--allow-readable", String(spec.allowReadable),
    "--bounded", String(spec.bounded),
    "--node", tools.node.path,
    "--expected-node", safeToken(process.version, "UNKNOWN"),
  ];
  const setprivArgs = [
    "--ruid", String(spec.realUid),
    "--euid", String(spec.effectiveUid),
    "--rgid", String(PROOF_GID),
    "--egid", String(PROOF_GID),
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--no-new-privs",
    tools.node.path,
    worker,
    ...workerArgs,
  ];
  const straceArgs = [
    "--quiet=all",
    "--follow-forks",
    "--decode-fds=path",
    "--string-limit=1",
    "--signal=none",
    "--trace=open,openat,openat2,read,readv,pread64,preadv,preadv2,mmap,sendfile,copy_file_range,splice,close",
    `--trace-path=${secret.path}`,
    `--output=${tracePath}`,
    "--kill-on-exit",
    tools.setpriv.path,
    ...setprivArgs,
  ];
  let trace;
  try {
    const run = await runCapture(tools.timeout.path, [
      "--signal=TERM",
      "--kill-after=5s",
      "30s",
      tools.prlimit.path,
      "--fsize=1048576:1048576",
      "--core=0:0",
      "--",
      tools.strace.path,
      ...straceArgs,
    ], {
      cwd: library,
      env: minimalEnvironment(fixturePath),
      timeoutMs: 40_000,
    });
    if (
      run.code !== 0 ||
      run.signal !== null ||
      run.timedOut ||
      run.overflow ||
      run.spawnFailed ||
      run.stderr.length !== 0
    ) {
      proofError("WORKER_EXECUTION_FAILED", workerExecutionFailureDiagnostic(run));
    }
    const workerReceipt = parseWorkerReceipt(run.stdout, spec);
    const traceStat = await fs.lstat(tracePath, { bigint: true });
    if (traceStat.uid !== 0n || traceStat.gid !== 0n || (traceStat.mode & 0o077n) !== 0n) {
      proofError("UNTRUSTED_TRACE_FILE");
    }
    if (traceStat.size >= BigInt(MAX_TRACE_BYTES)) {
      proofError("TRACE_SIZE_LIMIT_REACHED");
    }
    trace = await stableReadFile(tracePath, 0, MAX_TRACE_BYTES);
    const traced = parseTrace(trace, secret.path);
    const apiRead = workerReceipt.outcome?.kind === "read" && workerReceipt.read?.apiReturned === true;
    const actualErrorName = safeToken(workerReceipt.outcome?.errorName, null);
    const actualErrorCode = safeToken(workerReceipt.outcome?.errorCode, null);
    const errorMatched = spec.expectedErrorCode === null
      ? workerReceipt.outcome?.errorCode === null && workerReceipt.outcome?.errorName === null
      : workerReceipt.outcome?.kind === "error" &&
        actualErrorName === spec.expectedErrorName &&
        actualErrorCode === spec.expectedErrorCode;
    const traceReadAttempted = traced.readAttempts > 0;
    const tracePositiveBytes = traced.positiveReadBytes > 0;
    const readMatched = spec.expectedRead
      ? apiRead && traceReadAttempted && tracePositiveBytes
      : !apiRead && !traceReadAttempted && !tracePositiveBytes;
    const contentMatched = spec.expectedRead
      ? workerReceipt.content?.positiveBytes === true && workerReceipt.content?.exact === true
      : workerReceipt.content?.positiveBytes === false && workerReceipt.content?.exact === false;
    const closeMatched = traced.successfulOpen === 1 && traced.successfulClose === 1;
    if (!errorMatched || !readMatched || !contentMatched || !closeMatched) {
      proofError("CASE_EXPECTATION_FAILED");
    }
    if (!await validateSecret(secret)) proofError("FIXTURE_CHANGED");
    return {
      case: spec.case,
      fixtureRole: spec.fixtureRole,
      libraryRole: spec.libraryRole,
      auditOnly: spec.auditOnly,
      bounded: spec.bounded,
      credential: {
        beforeImport: true,
        afterImport: true,
        afterRead: true,
        expectedReal: true,
        expectedEffective: true,
        expectedSaved: true,
        expectedFs: true,
        groupsCleared: true,
        capsZero: true,
        noNewPrivs: true,
      },
      fixture: { beforeImport: true, afterImport: true, afterRead: true, identityStable: true },
      publicPackageExports: { config: true, secureFile: true },
      nativeOff: true,
      runtime: { versionExact: true, execPathExact: true },
      roleMatched: workerReceipt.libraryRole === spec.libraryRole,
      error: {
        expectedName: spec.expectedErrorName ?? null,
        actualName: actualErrorName,
        expectedCode: spec.expectedErrorCode,
        actualCode: actualErrorCode,
        matched: errorMatched,
      },
      read: {
        expected: spec.expectedRead,
        apiReturned: apiRead,
        traceAttempted: traceReadAttempted,
        positiveBytes: tracePositiveBytes,
        matched: readMatched,
      },
      close: { openSuccessful: true, closeSuccessful: true, matched: closeMatched },
      content: {
        expected: spec.expectedRead,
        positiveBytes: workerReceipt.content.positiveBytes,
        exact: workerReceipt.content.exact,
        matched: contentMatched,
      },
    };
  } finally {
    trace = undefined;
    try {
      await fs.unlink(tracePath);
    } catch (error) {
      if (error?.code !== "ENOENT") rawTracesRemoved = false;
    }
  }
}

async function validateRootTree(root) {
  const rootStat = await fs.lstat(root, { bigint: true });
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== 0n ||
    rootStat.gid !== 0n ||
    (rootStat.mode & 0o022n) !== 0n
  ) return false;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    const stat = await fs.lstat(child, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      stat.uid !== 0n ||
      stat.gid !== 0n ||
      (stat.mode & 0o022n) !== 0n ||
      (stat.mode & 0o7000n) !== 0n ||
      (stat.isFile() && stat.nlink !== 1n)
    ) return false;
    if (stat.isDirectory() && !await validateRootTree(child)) return false;
    if (!stat.isDirectory() && !stat.isFile()) return false;
  }
  return true;
}

async function safeCleanup() {
  let cleanup = true;
  if (fixturePath !== undefined) {
    try {
      const stat = await fs.lstat(fixturePath, { bigint: true });
      const basename = path.basename(fixturePath);
      if (
        path.dirname(fixturePath) !== proofParentPath ||
        !/^fixture-[A-Za-z0-9]{6}$/.test(basename) ||
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !identitiesMatch(stat, fixtureIdentity)
      ) {
        return false;
      }
      await fs.chmod(fixturePath, 0o700);
      await fs.rm(fixturePath, { recursive: true, force: false });
      try {
        await fs.lstat(fixturePath);
        cleanup = false;
      } catch (error) {
        if (error?.code !== "ENOENT") cleanup = false;
      }
    } catch {
      cleanup = false;
    }
  }
  if (proofParentPath !== undefined && proofParentIdentity !== undefined) {
    try {
      const stat = await fs.lstat(proofParentPath, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !identitiesMatch(stat, proofParentIdentity) ||
        path.dirname(proofParentPath) === proofParentPath
      ) {
        return false;
      }
      await fs.chmod(proofParentPath, 0o700);
      await fs.rmdir(proofParentPath);
    } catch {
      cleanup = false;
    }
  }
  return cleanup;
}

function buildReceipt(metadata, failure, cleanup) {
  const allCasesComplete = caseReceipts.length === CASES.length;
  const allWorkersValidated = allCasesComplete && caseReceipts.every((item) =>
    item.credential.expectedSaved &&
    item.credential.expectedFs &&
    item.credential.groupsCleared &&
    item.credential.capsZero &&
    item.credential.noNewPrivs);
  credentialReceipt.savedAndFsIdsValidatedByWorker = allWorkersValidated;
  credentialReceipt.groupsClearedByWorker = allWorkersValidated;
  credentialReceipt.capsZeroByWorker = allWorkersValidated;
  credentialReceipt.noNewPrivsByWorker = allWorkersValidated;
  fixtureReceipt.rawTracesRemoved = rawTracesRemoved && cleanup;
  fixtureReceipt.cleanup = cleanup;
  durationsMs.total = Math.round((performance.now() - proofStartedAt) * 1000) / 1000;
  const overall =
    failure === null &&
    allCasesComplete &&
    cleanup &&
    harnessReceipt.manifestValidated &&
    harnessReceipt.sourceCopyHashesMatch &&
    artifactReceipts.candidate?.exactRoleBinding === true &&
    artifactReceipts.historical?.exactRoleBinding === true &&
    fixtureReceipt.rawTracesRemoved &&
    fixtureReceipt.secretsExactBefore &&
    fixtureReceipt.secretsExactAfter &&
    credentialReceipt.nssUnusedBefore &&
    credentialReceipt.procUnusedBefore &&
    credentialReceipt.procUnusedAfter &&
    allWorkersValidated;
  return {
    schema: 1,
    proof: PROOF,
    overall,
    failure,
    workflow: {
      name: "ci",
      event: "workflow_dispatch",
      manualOnly: true,
      booleanInputPresent: true,
      defaultDisabled: true,
      explicitTrueRequired: true,
      sha256: harnessReceipt.workflowSha256,
      receiptAllowlisted: true,
      rawArtifactsUploaded: false,
      candidateBuildRunnerSeparated: true,
      historicalBuildRunnerSeparated: true,
      proofRunnerClean: true,
      packageManagerCommandsExecutedOnProofRunner: false,
      candidateBuildCommandsExecutedOnProofRunner: false,
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      release: safeToken(os.release(), "UNKNOWN"),
      runnerImage: metadata.runnerImage,
      runnerImageVersion: metadata.runnerImageVersion,
      osRelease: metadata.osRelease,
    },
    library: {
      candidate: {
        role: "candidate",
        auditOnly: false,
        head: metadata.candidateHead,
        tree: metadata.candidateTree,
        ...libraryReceipts.candidate,
      },
      historical: {
        role: "historical-negative-control",
        auditOnly: true,
        fixed: metadata.historicalHead === BASE_HEAD && metadata.historicalTree === BASE_TREE,
        head: metadata.historicalHead,
        tree: metadata.historicalTree,
        ...libraryReceipts.baseline,
      },
    },
    base: {
      fixed: metadata.historicalHead === BASE_HEAD && metadata.historicalTree === BASE_TREE,
      head: metadata.historicalHead,
      tree: metadata.historicalTree,
      auditOnly: true,
    },
    artifacts: artifactReceipts,
    harness: harnessReceipt,
    tools: toolReceipts,
    node: {
      expected: metadata.expectedNode,
      actual: safeToken(process.version, "UNKNOWN"),
      exact: process.version === metadata.expectedNode,
    },
    credential: credentialReceipt,
    fixture: fixtureReceipt,
    cases: caseReceipts,
    durationsMs,
  };
}

async function writeReceipt(receipt) {
  const parent = path.dirname(receiptPath);
  const canonicalParent = await fs.realpath(parent);
  const parentStat = await fs.lstat(parent, { bigint: true });
  if (
    canonicalParent !== parent ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.uid !== 0n && parentStat.uid !== BigInt(builderUid)) ||
    (parentStat.gid !== 0n && parentStat.gid !== BigInt(builderGid)) ||
    (parentStat.mode & 0o022n) !== 0n ||
    path.basename(receiptPath) !== "secure-file-credential-proof.json"
  ) {
    proofError("INVALID_RECEIPT_DESTINATION");
  }
  const existing = await stableReadFile(
    receiptPath,
    builderUid,
    4096,
    builderGid,
    "initial-receipt",
  );
  if (!FAILURE_RECEIPTS.has(existing.toString("utf8"))) {
    proofError("INVALID_INITIAL_RECEIPT", { subject: "receipt", reason: "content" });
  }
  const temporary = path.join(parent, `.secure-file-credential-proof-${process.pid}.tmp`);
  const buffer = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await writeRootFile(temporary, buffer, 0o644);
  await fs.rename(temporary, receiptPath);
  const written = await stableReadFile(receiptPath, 0, 1024 * 1024, 0, "receipt");
  if (!written.equals(buffer)) proofError("RECEIPT_WRITE_MISMATCH");
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    proofError("ROOT_LINUX_REQUIRED");
  }
  builderUid = parseId(parsed.get("builder-uid"));
  builderGid = parseId(parsed.get("builder-gid"));
  if (
    builderUid === 0 ||
    builderGid === 0 ||
    [REAL_UID, EFFECTIVE_UID, PROOF_GID].includes(builderUid) ||
    [REAL_UID, EFFECTIVE_UID, PROOF_GID].includes(builderGid) ||
    !credentialReceipt.idsDistinct
  ) {
    proofError("INVALID_BUILDER_OR_CREDENTIAL_IDS");
  }
  Object.assign(metadata, {
    candidateHead: validateSha(parsed.get("candidate-head")),
    candidateTree: validateSha(parsed.get("candidate-tree")),
    historicalHead: validateSha(parsed.get("historical-head")),
    historicalTree: validateSha(parsed.get("historical-tree")),
    candidateArtifactId: validatePositiveIntegerToken(
      parsed.get("candidate-artifact-id"),
      "INVALID_ARTIFACT_ID",
    ),
    candidateArtifactDigest: validateDigest(parsed.get("candidate-artifact-digest")),
    historicalArtifactId: validatePositiveIntegerToken(
      parsed.get("historical-artifact-id"),
      "INVALID_ARTIFACT_ID",
    ),
    historicalArtifactDigest: validateDigest(parsed.get("historical-artifact-digest")),
    runId: validatePositiveIntegerToken(parsed.get("run-id")),
    runAttempt: validatePositiveIntegerToken(parsed.get("run-attempt")),
    runnerImage: validateSafeLabel(parsed.get("runner-image"), null),
    runnerImageVersion: validateSafeLabel(parsed.get("runner-image-version"), null),
    expectedNode: parsed.get("expected-node"),
  });
  if (
    metadata.historicalHead !== BASE_HEAD ||
    metadata.historicalTree !== BASE_TREE ||
    metadata.candidateArtifactId === metadata.historicalArtifactId ||
    metadata.runnerImage === null ||
    metadata.runnerImageVersion === null ||
    !["v22.23.2", "v24.20.0"].includes(metadata.expectedNode)
  ) {
    proofError("INVALID_FIXED_INPUT");
  }
  if (process.version !== metadata.expectedNode) {
    proofError("NODE_VERSION_MISMATCH", { tool: "node", reason: "process-version" });
  }

  const absolute = (name) => {
    const supplied = parsed.get(name);
    const value = path.resolve(supplied);
    if (!path.isAbsolute(supplied) || value === path.parse(value).root) {
      proofError("INVALID_PATH_ARGUMENT", {
        ...(TOOL_NAMES.includes(name) ? { tool: name } : { subject: name }),
        reason: "absolute",
      });
    }
    return value;
  };
  const canonicalExisting = async (name) => {
    const supplied = absolute(name);
    let canonical;
    try {
      canonical = await fs.realpath(supplied);
    } catch {
      proofError("MISSING_PATH_ARGUMENT", {
        ...(TOOL_NAMES.includes(name) ? { tool: name } : { subject: name }),
        reason: "missing",
      });
    }
    if (canonical !== supplied) {
      proofError("NONCANONICAL_PATH_ARGUMENT", {
        ...(TOOL_NAMES.includes(name) ? { tool: name } : { subject: name }),
        reason: "canonical",
      });
    }
    return canonical;
  };
  receiptPath = await canonicalExisting("receipt");
  const candidateRoot = await canonicalExisting("candidate-bundle");
  const historicalRoot = await canonicalExisting("historical-bundle");
  const candidateAttestation = await canonicalExisting("candidate-attestation");
  const historicalAttestation = await canonicalExisting("historical-attestation");
  const staged = {};
  for (const name of [...STAGED_FILE_NAMES, "manifest"]) staged[name] = await canonicalExisting(name);
  proofParentPath = absolute("proof-parent");
  if (
    candidateRoot === historicalRoot ||
    candidateRoot.startsWith(`${historicalRoot}${path.sep}`) ||
    historicalRoot.startsWith(`${candidateRoot}${path.sep}`) ||
    proofParentPath.startsWith(`${candidateRoot}${path.sep}`) ||
    proofParentPath.startsWith(`${historicalRoot}${path.sep}`) ||
    receiptPath.startsWith(`${candidateRoot}${path.sep}`) ||
    receiptPath.startsWith(`${historicalRoot}${path.sep}`) ||
    receiptPath.startsWith(`${proofParentPath}${path.sep}`) ||
    staged.coordinator.startsWith(`${candidateRoot}${path.sep}`) ||
    staged.coordinator.startsWith(`${historicalRoot}${path.sep}`)
  ) {
    proofError("UNSAFE_PATH_RELATIONSHIP");
  }
  const proofParentContainer = path.dirname(proofParentPath);
  const receiptDirectory = path.dirname(receiptPath);
  const proofParentContainerCanonical = await fs.realpath(proofParentContainer);
  const proofParentContainerStat = await fs.lstat(proofParentContainerCanonical, { bigint: true });
  const nodeVersionLabel = metadata.expectedNode.slice(1);
  if (
    proofParentContainerCanonical !== proofParentContainer ||
    path.basename(proofParentPath) !== `fs-safe-secure-file-proof-${nodeVersionLabel}` ||
    path.dirname(receiptDirectory) !== proofParentContainer ||
    path.basename(receiptDirectory) !== `fs-safe-secure-file-receipt-${nodeVersionLabel}` ||
    !proofParentContainerStat.isDirectory() ||
    proofParentContainerStat.isSymbolicLink() ||
    proofParentContainerStat.uid !== BigInt(builderUid) ||
    proofParentContainerStat.gid !== BigInt(builderGid) ||
    (proofParentContainerStat.mode & 0o022n) !== 0n
  ) {
    proofError("UNSAFE_PROOF_PARENT");
  }

  stage = "process-environment";
  const loaderReceipt = await validateLoaderEnvironment();

  stage = "staged-harness-and-tools";
  const expectedStageDirectory =
    `/usr/local/lib/fs-safe-credential-proof-${metadata.runId}-${metadata.runAttempt}-${nodeVersionLabel}`;
  const stagedValidation = await timed(
    "stagedHarnessAndTools",
    () => validateStagedHarnessAndTools(staged, metadata.expectedNode, expectedStageDirectory),
  );
  const tools = stagedValidation.tools;
  for (const name of TOOL_NAMES) toolReceipts[name] = tools[name].receipt;
  toolReceipts.node.archiveSha256 = stagedValidation.manifest.value.nodeArchive.sha256;
  toolReceipts.node.officialArchivePinned = true;
  toolReceipts.loader = loaderReceipt;
  toolReceipts.strace.pathFiltered = true;
  toolReceipts.strace.runsAsRoot = true;
  toolReceipts.prlimit.appliesToStraceAndWorker = true;
  toolReceipts.prlimit.fileSizeLimitBytes = MAX_TRACE_BYTES;
  toolReceipts.prlimit.coreLimitBytes = 0;
  toolReceipts.timeout.limit30Seconds = true;
  toolReceipts.setpriv.argumentArray = true;

  const stageDirectory = path.dirname(staged.coordinator);
  const stageDirectoryStat = await fs.lstat(stageDirectory, { bigint: true });
  harnessReceipt.stagedUnderUsrLocalLib = stageDirectory === expectedStageDirectory;
  harnessReceipt.rootOwned = stageDirectoryStat.uid === 0n && stageDirectoryStat.gid === 0n;
  harnessReceipt.nonWritable = (stageDirectoryStat.mode & 0o222n) === 0n;
  harnessReceipt.regularFiles = ["coordinator", "worker", "workflow"].every(
    (name) => stagedValidation.inspected[name].stat.isFile(),
  );
  harnessReceipt.linkCountOne = ["coordinator", "worker", "workflow"].every(
    (name) => stagedValidation.inspected[name].stat.nlink === 1n,
  );
  harnessReceipt.identityStable = true;
  harnessReceipt.manifestValidated = true;
  harnessReceipt.coordinatorSha256 = stagedValidation.inspected.coordinator.sha256;
  harnessReceipt.workerSha256 = stagedValidation.inspected.worker.sha256;
  harnessReceipt.workflowSha256 = stagedValidation.inspected.workflow.sha256;
  harnessReceipt.sourceCopyHashesMatch = STAGED_FILE_NAMES.every((name) =>
    stagedValidation.manifest.value.entries[name].sourceSha256 ===
      stagedValidation.inspected[name].sha256);
  harnessReceipt.manifestSha256 = stagedValidation.manifest.sha256;
  if (
    !harnessReceipt.stagedUnderUsrLocalLib ||
    !harnessReceipt.rootOwned ||
    !harnessReceipt.nonWritable ||
    !harnessReceipt.regularFiles ||
    !harnessReceipt.linkCountOne ||
    !harnessReceipt.sourceCopyHashesMatch
  ) {
    proofError("UNTRUSTED_HARNESS", { subject: "harness", reason: "stage" });
  }

  stage = "os-provenance";
  const osReleasePath = await fs.realpath("/etc/os-release");
  await validateTrustedAncestors(osReleasePath, "os-release");
  const osReleaseBuffer = await stableReadFile(osReleasePath, 0, 64 * 1024, 0, "os-release");
  const osFields = {};
  for (const line of osReleaseBuffer.toString("utf8").split("\n")) {
    const match = line.match(/^(ID|VERSION_ID)=(?:"([A-Za-z0-9_.-]+)"|([A-Za-z0-9_.-]+))$/u);
    if (match !== null) osFields[match[1]] = match[2] ?? match[3];
  }
  metadata.osRelease = {
    id: validateSafeLabel(osFields.ID, "unknown"),
    version: validateSafeLabel(osFields.VERSION_ID, "unknown"),
    sha256: sha256(osReleaseBuffer),
  };

  stage = "artifact-attestations";
  const node = metadata.expectedNode.slice(1);
  const commonArtifact = {
    node,
    runId: metadata.runId,
    runAttempt: metadata.runAttempt,
  };
  artifactReceipts.candidate = await validateAttestation(candidateAttestation, {
    ...commonArtifact,
    role: "candidate",
    receiptRole: "candidate",
    artifactName: `secure-file-candidate-node-${node}`,
    artifactId: metadata.candidateArtifactId,
    artifactDigest: metadata.candidateArtifactDigest,
  });
  artifactReceipts.historical = await validateAttestation(historicalAttestation, {
    ...commonArtifact,
    role: "historical-negative-control",
    receiptRole: "historical",
    artifactName: `secure-file-historical-node-${node}`,
    artifactId: metadata.historicalArtifactId,
    artifactDigest: metadata.historicalArtifactDigest,
  });

  stage = "artifact-bundles";
  const bundles = await timed("artifactValidation", async () => ({
    candidate: await validateBundle(candidateRoot, {
      ...commonArtifact,
      role: "candidate",
      receiptRole: "candidate",
      head: metadata.candidateHead,
      tree: metadata.candidateTree,
    }),
    historical: await validateBundle(historicalRoot, {
      ...commonArtifact,
      role: "historical-negative-control",
      receiptRole: "historical",
      head: metadata.historicalHead,
      tree: metadata.historicalTree,
    }),
  }));
  Object.assign(artifactReceipts.candidate, {
    exactRoleBinding: true,
    provenanceSha256: bundles.candidate.provenanceSha256,
    packageSha256: bundles.candidate.packageSha256,
    distSha256: bundles.candidate.distSha256,
    files: bundles.candidate.files.length,
    entries: bundles.candidate.entries,
    bytes: bundles.candidate.bytes,
    bounded: true,
    noHarnessEntries: true,
  });
  Object.assign(artifactReceipts.historical, {
    exactRoleBinding: true,
    provenanceSha256: bundles.historical.provenanceSha256,
    packageSha256: bundles.historical.packageSha256,
    distSha256: bundles.historical.distSha256,
    files: bundles.historical.files.length,
    entries: bundles.historical.entries,
    bytes: bundles.historical.bytes,
    bounded: true,
    noHarnessEntries: true,
  });

  stage = "unused-credentials";
  await timed("unusedCredentialsBefore", async () => {
    await assertNssIdsUnused(tools.getent.path);
    credentialReceipt.nssUnusedBefore = true;
    await assertProcIdsUnused();
    credentialReceipt.procUnusedBefore = true;
  });

  const workerBuffer = await stableReadFile(staged.worker, 0, 1024 * 1024, 0, "worker");

  stage = "fixture-create";
  try {
    await fs.mkdir(proofParentPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") proofError("PROOF_PARENT_EXISTS");
    throw error;
  }
  await fs.chown(proofParentPath, 0, 0);
  await fs.chmod(proofParentPath, 0o700);
  proofParentIdentity = await fs.lstat(proofParentPath, { bigint: true });
  fixturePath = await fs.mkdtemp(path.join(proofParentPath, "fixture-"));
  fixtureIdentity = await fs.lstat(fixturePath, { bigint: true });
  if (
    !fixtureIdentity.isDirectory() ||
    fixtureIdentity.isSymbolicLink() ||
    fixtureIdentity.uid !== 0n ||
    path.dirname(fixturePath) !== proofParentPath
  ) {
    proofError("FIXTURE_CREATION_FAILED");
  }
  fixtureReceipt.created = true;
  fixtureReceipt.rootOwned = true;

  stage = "copy-libraries";
  const libraries = {
    candidate: path.join(fixturePath, "candidate"),
    baseline: path.join(fixturePath, "historical"),
  };
  await fs.mkdir(libraries.candidate, { recursive: true, mode: 0o555 });
  await fs.mkdir(libraries.baseline, { recursive: true, mode: 0o555 });
  libraryReceipts.candidate = await copyLibrary(bundles.candidate, libraries.candidate, "candidate");
  libraryReceipts.baseline = await copyLibrary(
    bundles.historical,
    libraries.baseline,
    "historical-negative-control",
  );
  for (const library of Object.values(libraries)) {
    await writeRootFile(path.join(library, "worker.mjs"), workerBuffer);
    await fs.chown(library, 0, 0);
    await fs.chmod(library, 0o555);
  }
  const candidateWorker = await stableReadFile(path.join(libraries.candidate, "worker.mjs"), 0, 1024 * 1024);
  const baselineWorker = await stableReadFile(path.join(libraries.baseline, "worker.mjs"), 0, 1024 * 1024);
  harnessReceipt.workerCopiesMatch = candidateWorker.equals(workerBuffer) && baselineWorker.equals(workerBuffer);
  if (!harnessReceipt.workerCopiesMatch) proofError("WORKER_COPY_MISMATCH");
  fixtureReceipt.packagesRootOwned =
    await validateRootTree(libraries.candidate) && await validateRootTree(libraries.baseline);
  fixtureReceipt.packagesNonWritable = fixtureReceipt.packagesRootOwned;
  if (!fixtureReceipt.packagesRootOwned) proofError("COPIED_PACKAGE_UNTRUSTED");

  stage = "create-secrets";
  const secretsDirectory = path.join(fixturePath, "secrets");
  const tracesDirectory = path.join(fixturePath, "traces");
  await fs.mkdir(secretsDirectory, { mode: 0o555 });
  await fs.mkdir(tracesDirectory, { mode: 0o700 });
  await fs.chown(secretsDirectory, 0, 0);
  await fs.chown(tracesDirectory, 0, 0);
  const secrets = {
    equal: await makeSecret(secretsDirectory, "equal.secret", EFFECTIVE_UID, 0o600),
    effective: await makeSecret(secretsDirectory, "effective.secret", EFFECTIVE_UID, 0o600),
    real: await makeSecret(secretsDirectory, "real.secret", REAL_UID, 0o640),
  };
  fixtureReceipt.secretsExactBefore = (await Promise.all(Object.values(secrets).map(validateSecret))).every(Boolean);
  if (!fixtureReceipt.secretsExactBefore) proofError("FIXTURE_CONTENT_MISMATCH");
  await fs.chmod(secretsDirectory, 0o555);
  await fs.chmod(fixturePath, 0o555);
  await fs.chmod(proofParentPath, 0o555);
  const sealedFixture = await fs.lstat(fixturePath, { bigint: true });
  const sealedParent = await fs.lstat(proofParentPath, { bigint: true });
  fixtureReceipt.nonWritable =
    sealedFixture.uid === 0n &&
    sealedFixture.gid === 0n &&
    (sealedFixture.mode & 0o222n) === 0n &&
    sealedParent.uid === 0n &&
    sealedParent.gid === 0n &&
    (sealedParent.mode & 0o222n) === 0n;
  if (!fixtureReceipt.nonWritable) proofError("FIXTURE_WRITABLE");

  stage = "credential-cases";
  await timed("credentialCases", async () => {
    for (const spec of CASES) {
      caseReceipts.push(await runProofCase(spec, libraries, secrets, tools));
    }
  });
  fixtureReceipt.secretsExactAfter = (await Promise.all(Object.values(secrets).map(validateSecret))).every(Boolean);
  if (!fixtureReceipt.secretsExactAfter) proofError("FIXTURE_CHANGED");
  await assertProcIdsUnused();
  credentialReceipt.procUnusedAfter = true;
  return metadata;
}

let metadata = {
  candidateHead: null,
  candidateTree: null,
  historicalHead: BASE_HEAD,
  historicalTree: null,
  candidateArtifactId: null,
  candidateArtifactDigest: null,
  historicalArtifactId: null,
  historicalArtifactDigest: null,
  runId: null,
  runAttempt: null,
  runnerImage: null,
  runnerImageVersion: null,
  osRelease: null,
  expectedNode: null,
};
let failure = null;
try {
  metadata = await main();
} catch (error) {
  failure = {
    stage: safeToken(stage, "unknown"),
    name: safeToken(error?.name, "UnknownError"),
    code: safeToken(error?.code, "UNKNOWN"),
    ...(failureDiagnostic === null ? {} : { diagnostic: failureDiagnostic }),
  };
}
const cleanup = await safeCleanup();
fixtureReceipt.cleanup = cleanup;
const receipt = buildReceipt(metadata, failure, cleanup);
let receiptWritten = false;
try {
  await writeReceipt(receipt);
  receiptWritten = true;
} catch {
  receiptWritten = false;
}
process.stdout.write(`${JSON.stringify({
  schema: 1,
  proof: PROOF,
  overall: receipt.overall,
  receiptWritten,
  cleanup,
})}\n`);
if (!receipt.overall || !receiptWritten) process.exitCode = 1;
