import fs from "node:fs/promises";

const EXPECTED_CONTENT = Buffer.from("fs-safe split-credential synthetic payload\n", "utf8");
const STAGED_NODE_PATH =
  /^\/usr\/local\/lib\/fs-safe-credential-proof-([1-9][0-9]{0,19})-([1-9][0-9]{0,9})-(22\.23\.2|24\.20\.0)\/node$/u;
const ALLOWED_ARGUMENTS = new Set([
  "case",
  "library-role",
  "secret",
  "real-uid",
  "effective-uid",
  "gid",
  "owner-uid",
  "mode",
  "allow-readable",
  "bounded",
  "node",
  "expected-node",
]);

let stage = "arguments";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseArguments(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail("INVALID_ARGUMENTS");
    }
    const name = flag.slice(2);
    if (!ALLOWED_ARGUMENTS.has(name) || parsed.has(name)) {
      fail("INVALID_ARGUMENTS");
    }
    parsed.set(name, value);
  }
  if (parsed.size !== ALLOWED_ARGUMENTS.size) {
    fail("INVALID_ARGUMENTS");
  }
  return parsed;
}

function parseInteger(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail("INVALID_ARGUMENTS");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    fail("INVALID_ARGUMENTS");
  }
  return number;
}

function parseBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  fail("INVALID_ARGUMENTS");
}

function parseStatus(text) {
  const fields = new Map();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
  }
  const numbers = (name, length) => {
    const value = fields.get(name);
    const parts = value?.split(/\s+/).filter(Boolean) ?? [];
    if (parts.length !== length || parts.some((part) => !/^[0-9]+$/.test(part))) {
      fail("INCOMPLETE_PROC_STATUS");
    }
    return parts.map(Number);
  };
  const capNames = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
  const capsZero = capNames.every((name) => {
    const value = fields.get(name);
    return typeof value === "string" && /^[0-9a-fA-F]+$/.test(value) && BigInt(`0x${value}`) === 0n;
  });
  const noNewPrivs = fields.get("NoNewPrivs") === "1";
  const groups = fields.get("Groups")?.split(/\s+/).filter(Boolean) ?? [];
  return {
    uids: numbers("Uid", 4),
    gids: numbers("Gid", 4),
    groups,
    capsZero,
    noNewPrivs,
  };
}

async function inspectCredentials(expectedUids, expectedGids) {
  const status = parseStatus(await fs.readFile("/proc/self/status", "utf8"));
  const receipt = {
    real: status.uids[0] === expectedUids[0] && status.gids[0] === expectedGids[0],
    effective: status.uids[1] === expectedUids[1] && status.gids[1] === expectedGids[1],
    saved: status.uids[2] === expectedUids[2] && status.gids[2] === expectedGids[2],
    fs: status.uids[3] === expectedUids[3] && status.gids[3] === expectedGids[3],
    groupsCleared: status.groups.length === 0,
    capsZero: status.capsZero,
    noNewPrivs: status.noNewPrivs,
    processApi:
      process.getuid?.() === expectedUids[0] &&
      process.geteuid?.() === expectedUids[1] &&
      process.getgid?.() === expectedGids[0] &&
      process.getegid?.() === expectedGids[1],
  };
  return { ...receipt, all: Object.values(receipt).every(Boolean) };
}

async function inspectFixture(secret, expected, identity) {
  const stat = await fs.lstat(secret, { bigint: true });
  const currentIdentity = { dev: stat.dev, ino: stat.ino };
  const valid =
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1n &&
    stat.uid === BigInt(expected.ownerUid) &&
    stat.gid === BigInt(expected.gid) &&
    (stat.mode & 0o777n) === BigInt(expected.mode) &&
    stat.size === BigInt(EXPECTED_CONTENT.length) &&
    (identity === undefined ||
      (identity.dev === currentIdentity.dev && identity.ino === currentIdentity.ino));
  return { valid, identity: currentIdentity };
}

function safeToken(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : fallback;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const caseName = args.get("case");
  const libraryRole = args.get("library-role");
  if (![
    "equal-owner",
    "split-effective-owner",
    "split-real-owner-bounded",
    "split-real-owner-unbounded",
  ].includes(caseName) || !["candidate", "historical-negative-control"].includes(libraryRole)) {
    fail("INVALID_ARGUMENTS");
  }
  const secret = args.get("secret");
  if (!secret.startsWith("/") || secret.includes("\0")) {
    fail("INVALID_ARGUMENTS");
  }
  const realUid = parseInteger(args.get("real-uid"));
  const effectiveUid = parseInteger(args.get("effective-uid"));
  const gid = parseInteger(args.get("gid"));
  const expectedUids = [realUid, effectiveUid, effectiveUid, effectiveUid];
  const expectedGids = [gid, gid, gid, gid];
  const fixtureExpected = {
    ownerUid: parseInteger(args.get("owner-uid")),
    gid,
    mode: Number.parseInt(args.get("mode"), 8),
  };
  if (!/^[0-7]{4}$/.test(args.get("mode")) || fixtureExpected.mode > 0o777) {
    fail("INVALID_ARGUMENTS");
  }
  const allowReadableByOthers = parseBoolean(args.get("allow-readable"));
  const bounded = parseBoolean(args.get("bounded"));
  const expectedNode = args.get("expected-node");
  const expectedNodePath = args.get("node");
  const nodePathMatch = STAGED_NODE_PATH.exec(expectedNodePath);
  if (
    !/^v(?:22\.23\.2|24\.20\.0)$/u.test(expectedNode) ||
    nodePathMatch?.[3] !== expectedNode.slice(1)
  ) {
    fail("INVALID_ARGUMENTS");
  }

  stage = "runtime-identity";
  const processExecutable = await fs.realpath(process.execPath);
  const runtime = {
    versionExact: process.version === expectedNode,
    execPathExact: processExecutable === expectedNodePath,
  };
  if (!runtime.versionExact || !runtime.execPathExact) fail("RUNTIME_IDENTITY_MISMATCH");

  stage = "credential-before-import";
  const credentialBeforeImport = await inspectCredentials(expectedUids, expectedGids);
  if (!credentialBeforeImport.all) fail("CREDENTIAL_MISMATCH");
  stage = "fixture-before-import";
  const fixtureBefore = await inspectFixture(secret, fixtureExpected);
  if (!fixtureBefore.valid) fail("FIXTURE_MISMATCH");

  stage = "public-import";
  const config = await import("@openclaw/fs-safe/config");
  if (
    typeof config.configureFsSafeNative !== "function" ||
    typeof config.getFsSafeNativeConfig !== "function"
  ) {
    fail("PUBLIC_EXPORT_MISMATCH");
  }
  config.configureFsSafeNative({ mode: "off" });
  const nativeOff = config.getFsSafeNativeConfig().mode === "off";
  if (!nativeOff) fail("NATIVE_MODE_MISMATCH");
  const secureFile = await import("@openclaw/fs-safe/secure-file");
  if (typeof secureFile.readSecureFile !== "function") fail("PUBLIC_EXPORT_MISMATCH");

  stage = "credential-after-import";
  const credentialAfterImport = await inspectCredentials(expectedUids, expectedGids);
  if (!credentialAfterImport.all) fail("CREDENTIAL_MISMATCH");
  stage = "fixture-after-import";
  const fixtureAfterImport = await inspectFixture(secret, fixtureExpected, fixtureBefore.identity);
  if (!fixtureAfterImport.valid) fail("FIXTURE_MISMATCH");

  stage = "public-read";
  let buffer;
  let outcome;
  try {
    const result = await secureFile.readSecureFile({
      filePath: secret,
      label: "Credential proof fixture",
      permissions: { allowReadableByOthers },
      ...(bounded ? { io: { maxBytes: EXPECTED_CONTENT.length } } : {}),
    });
    buffer = result.buffer;
    outcome = { kind: "read", errorName: null, errorCode: null };
  } catch (error) {
    outcome = {
      kind: "error",
      errorName: safeToken(error?.name, "UnknownError"),
      errorCode: safeToken(error?.code, "UNKNOWN"),
    };
  }

  stage = "credential-after-read";
  const credentialAfterRead = await inspectCredentials(expectedUids, expectedGids);
  if (!credentialAfterRead.all) fail("CREDENTIAL_MISMATCH");
  stage = "fixture-after-read";
  const fixtureAfter = await inspectFixture(secret, fixtureExpected, fixtureBefore.identity);
  if (!fixtureAfter.valid) fail("FIXTURE_MISMATCH");

  const positiveBytes = Buffer.isBuffer(buffer) && buffer.length > 0;
  const exact = Buffer.isBuffer(buffer) && buffer.equals(EXPECTED_CONTENT);
  process.stdout.write(`${JSON.stringify({
    schema: 1,
    workerComplete: true,
    case: caseName,
    libraryRole,
    bounded,
    publicPackageExports: { config: true, secureFile: true },
    nativeOff,
    runtime,
    credential: {
      beforeImport: credentialBeforeImport,
      afterImport: credentialAfterImport,
      afterRead: credentialAfterRead,
    },
    fixture: {
      beforeImport: fixtureBefore.valid,
      afterImport: fixtureAfterImport.valid,
      afterRead: fixtureAfter.valid,
      identityStable: true,
    },
    outcome,
    read: { apiReturned: outcome.kind === "read" },
    content: { positiveBytes, exact },
  })}\n`);
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schema: 1,
    workerComplete: false,
    stage: safeToken(stage, "unknown"),
    error: {
      name: safeToken(error?.name, "UnknownError"),
      code: safeToken(error?.code, "UNKNOWN"),
    },
  })}\n`);
  process.exitCode = 1;
}
