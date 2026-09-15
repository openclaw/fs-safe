import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROOF = "secure-file-split-credential";
const BASE_HEAD = "914cd7b41388876b55e1cca76b46b8eb01e46364";
const BASE_TREE = "eb1d05638cd0ec21cea68a8b189ec3e253a8d903";
const REAL_UID = 61001;
const EFFECTIVE_UID = 61002;
const PROOF_GID = 61003;
const EXPECTED_CONTENT = Buffer.from("fs-safe split-credential synthetic payload\n", "utf8");
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_TRACE_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const ALLOWED_ARGUMENTS = new Set([
  "candidate",
  "baseline",
  "worker",
  "proof-parent",
  "receipt",
  "node",
  "prlimit",
  "setpriv",
  "strace",
  "timeout",
  "getent",
  "builder-uid",
  "builder-gid",
  "candidate-head",
  "candidate-tree",
  "baseline-head",
  "baseline-tree",
  "expected-node",
]);
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
const caseReceipts = [];
const toolReceipts = {};
const libraryReceipts = {};
const harnessReceipt = {
  argumentArraySpawn: true,
  shellDisabled: true,
  coordinatorSha256: null,
  workerSha256: null,
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

function proofError(code) {
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identitiesMatch(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function stableReadFile(file, expectedOwner, limit = MAX_PACKAGE_BYTES) {
  const before = await fs.lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.uid !== BigInt(expectedOwner) ||
    before.gid !== BigInt(expectedOwner === 0 ? 0 : builderGid) ||
    before.size < 0n ||
    before.size > BigInt(limit)
  ) {
    proofError("UNTRUSTED_SOURCE_FILE");
  }
  const handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !identitiesMatch(before, opened) || opened.size !== before.size) {
      proofError("SOURCE_FILE_CHANGED");
    }
    const buffer = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!identitiesMatch(opened, after) || after.size !== opened.size || BigInt(buffer.length) !== opened.size) {
      proofError("SOURCE_FILE_CHANGED");
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

async function validateSourceDirectory(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(builderUid) ||
    stat.gid !== BigInt(builderGid)
  ) {
    proofError("UNTRUSTED_SOURCE_DIRECTORY");
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

async function listSourceFiles(root, relative = "") {
  const directory = relative === "" ? root : path.join(root, relative);
  await validateSourceDirectory(directory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") proofError("INVALID_SOURCE_ENTRY");
    const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const child = path.join(root, ...childRelative.split("/"));
    const stat = await fs.lstat(child, { bigint: true });
    if (stat.isSymbolicLink()) proofError("UNTRUSTED_SOURCE_SYMLINK");
    if (stat.isDirectory()) {
      files.push(...await listSourceFiles(root, childRelative));
    } else if (stat.isFile()) {
      files.push(childRelative);
    } else {
      proofError("UNTRUSTED_SOURCE_ENTRY");
    }
  }
  return files;
}

async function copyDirectory(source, destination) {
  const files = await listSourceFiles(source);
  let total = 0;
  const manifest = [];
  await fs.mkdir(destination, { recursive: true, mode: 0o555 });
  for (const relative of files) {
    const sourceFile = path.join(source, ...relative.split("/"));
    const destinationFile = path.join(destination, ...relative.split("/"));
    const buffer = await stableReadFile(sourceFile, builderUid);
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

async function copyLibrary(sourceRoot, destinationRoot, role) {
  await validateSourceDirectory(sourceRoot);
  const packageBuffer = await stableReadFile(path.join(sourceRoot, "package.json"), builderUid, 1024 * 1024);
  let packageJson;
  try {
    packageJson = JSON.parse(packageBuffer.toString("utf8"));
  } catch {
    proofError("INVALID_PACKAGE_JSON");
  }
  if (
    packageJson.name !== "@openclaw/fs-safe" ||
    packageJson.type !== "module" ||
    packageJson.exports?.["./config"]?.default !== "./dist/config.js" ||
    packageJson.exports?.["./secure-file"]?.default !== "./dist/secure-file.js"
  ) {
    proofError("PUBLIC_EXPORT_MISMATCH");
  }
  const packageRoot = path.join(destinationRoot, "node_modules", "@openclaw", "fs-safe");
  await fs.mkdir(packageRoot, { recursive: true, mode: 0o555 });
  await writeRootFile(path.join(packageRoot, "package.json"), packageBuffer);
  const dist = await copyDirectory(path.join(sourceRoot, "dist"), path.join(packageRoot, "dist"));
  if (dist.files === 0 || dist.bytes === 0) proofError("EMPTY_DIST");
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
    copyExact: true,
  };
}

async function validateTool(toolPath, options = {}) {
  if (!path.isAbsolute(toolPath)) proofError("INVALID_TOOL_PATH");
  const canonical = await fs.realpath(toolPath);
  const stat = await fs.lstat(canonical, { bigint: true });
  const allowedOwner = stat.uid === 0n || stat.uid === BigInt(builderUid);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !allowedOwner ||
    (stat.mode & 0o022n) !== 0n ||
    (options.requireRoot === true && stat.uid !== 0n)
  ) {
    proofError("UNTRUSTED_TOOL");
  }
  const version = await runCapture(canonical, ["--version"], { timeoutMs: 10_000 });
  if (version.code !== 0 || version.timedOut || version.overflow || version.stdout.length === 0) {
    proofError("TOOL_VERSION_FAILED");
  }
  return {
    path: canonical,
    receipt: {
      available: true,
      rootOwned: stat.uid === 0n,
      notGroupOrWorldWritable: true,
      versionSha256: sha256(version.stdout),
    },
  };
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
      proofError("WORKER_EXECUTION_FAILED");
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
      (stat.mode & 0o022n) !== 0n
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
  const overall =
    failure === null &&
    allCasesComplete &&
    cleanup &&
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
      sha256: metadata.workflowSha256,
      receiptAllowlisted: true,
      rawArtifactsUploaded: false,
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
        fixed: metadata.baselineHead === BASE_HEAD && metadata.baselineTree === BASE_TREE,
        head: metadata.baselineHead,
        tree: metadata.baselineTree,
        ...libraryReceipts.baseline,
      },
    },
    base: {
      fixed: metadata.baselineHead === BASE_HEAD && metadata.baselineTree === BASE_TREE,
      head: metadata.baselineHead,
      tree: metadata.baselineTree,
      auditOnly: true,
    },
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
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  await fs.chown(receiptPath, 0, 0);
  await fs.chmod(receiptPath, 0o644);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    proofError("ROOT_LINUX_REQUIRED");
  }
  builderUid = parseId(args.get("builder-uid"));
  builderGid = parseId(args.get("builder-gid"));
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
    candidateHead: validateSha(args.get("candidate-head")),
    candidateTree: validateSha(args.get("candidate-tree")),
    baselineHead: validateSha(args.get("baseline-head")),
    baselineTree: validateSha(args.get("baseline-tree")),
    expectedNode: args.get("expected-node"),
    workflowSha256: null,
  });
  if (
    metadata.baselineHead !== BASE_HEAD ||
    metadata.baselineTree !== BASE_TREE ||
    !["v22.23.2", "v24.20.0"].includes(metadata.expectedNode)
  ) {
    proofError("INVALID_FIXED_INPUT");
  }
  if (process.version !== metadata.expectedNode) proofError("NODE_VERSION_MISMATCH");

  const absolute = (name) => {
    const value = path.resolve(args.get(name));
    if (!path.isAbsolute(args.get(name)) || value === path.parse(value).root) proofError("INVALID_PATH_ARGUMENT");
    return value;
  };
  const canonicalExisting = async (name) => {
    const supplied = absolute(name);
    const canonical = await fs.realpath(supplied);
    if (canonical !== supplied) proofError("NONCANONICAL_PATH_ARGUMENT");
    return canonical;
  };
  const candidateRoot = await canonicalExisting("candidate");
  const baselineRoot = await canonicalExisting("baseline");
  const workerSource = await canonicalExisting("worker");
  proofParentPath = absolute("proof-parent");
  receiptPath = absolute("receipt");
  if (
    candidateRoot === baselineRoot ||
    candidateRoot.startsWith(`${baselineRoot}${path.sep}`) ||
    baselineRoot.startsWith(`${candidateRoot}${path.sep}`) ||
    proofParentPath.startsWith(`${candidateRoot}${path.sep}`) ||
    proofParentPath.startsWith(`${baselineRoot}${path.sep}`) ||
    receiptPath.startsWith(`${candidateRoot}${path.sep}`) ||
    receiptPath.startsWith(`${baselineRoot}${path.sep}`) ||
    receiptPath.startsWith(`${proofParentPath}${path.sep}`)
  ) {
    proofError("UNSAFE_PATH_RELATIONSHIP");
  }
  const expectedWorkerSource = path.join(candidateRoot, "scripts", "secure-file-credential-proof-worker.mjs");
  if (
    workerSource !== expectedWorkerSource ||
    fileURLToPath(import.meta.url) !== path.join(candidateRoot, "scripts", "secure-file-credential-proof.mjs")
  ) {
    proofError("UNEXPECTED_HARNESS_SOURCE");
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

  stage = "tools";
  const tools = {};
  for (const [name, requireRoot] of [["node", false], ["prlimit", true], ["setpriv", true], ["strace", true], ["timeout", true], ["getent", true]]) {
    tools[name] = await validateTool(absolute(name), { requireRoot });
    toolReceipts[name] = tools[name].receipt;
  }
  toolReceipts.strace.pathFiltered = true;
  toolReceipts.strace.runsAsRoot = true;
  toolReceipts.prlimit.appliesToStraceAndWorker = true;
  toolReceipts.prlimit.fileSizeLimitBytes = MAX_TRACE_BYTES;
  toolReceipts.prlimit.coreLimitBytes = 0;
  toolReceipts.timeout.limit30Seconds = true;
  toolReceipts.setpriv.argumentArray = true;

  stage = "unused-credentials";
  await assertNssIdsUnused(tools.getent.path);
  credentialReceipt.nssUnusedBefore = true;
  await assertProcIdsUnused();
  credentialReceipt.procUnusedBefore = true;

  stage = "source-validation";
  await validateSourceDirectory(candidateRoot);
  await validateSourceDirectory(baselineRoot);
  const coordinatorBuffer = await stableReadFile(fileURLToPath(import.meta.url), builderUid, 1024 * 1024);
  const workerBuffer = await stableReadFile(workerSource, builderUid, 1024 * 1024);
  const workflowBuffer = await stableReadFile(
    path.join(candidateRoot, ".github", "workflows", "ci.yml"),
    builderUid,
    1024 * 1024,
  );
  harnessReceipt.coordinatorSha256 = sha256(coordinatorBuffer);
  harnessReceipt.workerSha256 = sha256(workerBuffer);
  metadata.workflowSha256 = sha256(workflowBuffer);

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
  libraryReceipts.candidate = await copyLibrary(candidateRoot, libraries.candidate, "candidate");
  libraryReceipts.baseline = await copyLibrary(
    baselineRoot,
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
  for (const spec of CASES) {
    caseReceipts.push(await runProofCase(spec, libraries, secrets, tools));
  }
  fixtureReceipt.secretsExactAfter = (await Promise.all(Object.values(secrets).map(validateSecret))).every(Boolean);
  if (!fixtureReceipt.secretsExactAfter) proofError("FIXTURE_CHANGED");
  await assertProcIdsUnused();
  credentialReceipt.procUnusedAfter = true;
  return metadata;
}

let metadata = {
  candidateHead: null,
  candidateTree: null,
  baselineHead: BASE_HEAD,
  baselineTree: null,
  expectedNode: null,
  workflowSha256: null,
};
let failure = null;
try {
  metadata = await main();
} catch (error) {
  failure = {
    stage: safeToken(stage, "unknown"),
    name: safeToken(error?.name, "UnknownError"),
    code: safeToken(error?.code, "UNKNOWN"),
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
