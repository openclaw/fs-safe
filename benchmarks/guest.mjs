import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OPERATIONS = ["write", "create", "copy", "rename", "mkdirp"];
const LAYOUTS = ["existing-parent", "missing-parent"];
const PAYLOAD = Buffer.alloc(1024, 0x61);
const SUPPORTED_PLATFORMS = ["linux", "darwin"];
const SKIP_REASON = "Guest Python filesystem execution requires Linux or macOS.";
const PROCESS_TIMEOUT_MS = 30_000;
const IDENTITY_SCOPE = "Executable bytes and stat identity; standard library and shared libraries are not content-hashed.";
export const GUEST_BENCHMARK_CASES = Object.freeze(OPERATIONS.flatMap((operation) =>
  LAYOUTS.map((layout) => Object.freeze({ name: `Guest.${operation}/${layout}`, operation, layout })),
));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertProcessResult(result) {
  assert(result, "guest benchmark produced no child result");
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "guest benchmark child was signalled");
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
}

function executableStat(executable) {
  const stat = fs.statSync(executable, { bigint: true });
  assert(stat.isFile(), "guest Python executable is not a regular file");
  return Object.fromEntries(["dev", "ino", "size", "mtimeNs", "ctimeNs"]
    .map((key) => [key, String(stat[key])]));
}

function assertInterpreterStable(interpreter) {
  assert.equal(fs.realpathSync(interpreter.executable), interpreter.realPath,
    "guest Python executable resolution changed");
  assert.deepEqual(executableStat(interpreter.realPath), interpreter.stat,
    "guest Python executable identity changed");
}

function inspectInterpreter() {
  const probe = spawnSync("python3", ["-c", [
    "import json, os, platform, sys",
    "print(json.dumps({'executable': sys.executable, 'version': sys.version,",
    "  'implementation': sys.implementation.name, 'platform': sys.platform,",
    "  'machine': platform.machine(), 'directoryFlags': hasattr(os, 'O_DIRECTORY') and hasattr(os, 'O_NOFOLLOW'),",
    "  'relativeDescriptors': os.open in os.supports_dir_fd and os.mkdir in os.supports_dir_fd}))",
  ].join("\n")], {
    stdio: ["ignore", "pipe", "pipe"], timeout: PROCESS_TIMEOUT_MS,
    killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
  assertProcessResult(probe);
  const observed = JSON.parse(probe.stdout.toString("utf8"));
  assert.equal(observed.platform, process.platform, "guest Python platform mismatch");
  assert.equal(observed.directoryFlags, true, "guest Python requires O_DIRECTORY and O_NOFOLLOW");
  assert.equal(observed.relativeDescriptors, true, "guest Python requires descriptor-relative operations");
  assert(path.isAbsolute(observed.executable), "guest Python must report its absolute executable");
  const realPath = fs.realpathSync(observed.executable);
  const interpreter = {
    ...observed,
    realPath,
    stat: executableStat(realPath),
    sha256: sha256(fs.readFileSync(realPath)),
    identityScope: IDENTITY_SCOPE,
  };
  assertInterpreterStable(interpreter);
  return interpreter;
}

export function createGuestFixture(workspace, operation, layout) {
  assert(OPERATIONS.includes(operation), "unknown guest benchmark operation");
  assert(LAYOUTS.includes(layout), "unknown guest benchmark parent layout");
  const directory = fs.mkdtempSync(path.join(workspace, "guest-"));
  const parent = "parent/nested";
  const parentPath = path.join(directory, parent);
  try {
    if (layout === "existing-parent") fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    assert.equal(fs.existsSync(parentPath), layout === "existing-parent");
    const transfer = operation === "copy" || operation === "rename";
    if (transfer) fs.writeFileSync(path.join(directory, "source.txt"), PAYLOAD, { mode: 0o600 });
    const argv = operation === "mkdirp" ? [operation, directory, parent]
      : transfer ? [operation, directory, "", "source.txt", directory, parent, "note.txt", "1"]
        : [operation, directory, parent, "note.txt", "1"];
    return { directory, parentPath, operation, argv };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function verifyGuestResult(result, fixture) {
  assertProcessResult(result);
  assert.equal(result.stdout.length, 0, "guest mutation unexpectedly produced stdout");
  assert.equal(result.stderr.length, 0, "guest mutation unexpectedly produced diagnostics");
  const { directory, parentPath, operation } = fixture;
  assert.deepEqual(fs.readdirSync(parentPath), operation === "mkdirp" ? [] : ["note.txt"],
    "guest result or staging cleanup mismatch");
  assert.deepEqual(fs.readdirSync(path.join(directory, "parent")), ["nested"]);
  assert.deepEqual(fs.readdirSync(directory).sort(), operation === "copy" ? ["parent", "source.txt"] : ["parent"]);
  if (operation !== "mkdirp") {
    const target = path.join(parentPath, "note.txt");
    const stat = fs.lstatSync(target);
    assert(stat.isFile() && !stat.isSymbolicLink(), "guest result is not a regular file");
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(target), PAYLOAD, "guest payload mismatch");
  }
  if (operation === "copy") {
    assert.deepEqual(fs.readFileSync(path.join(directory, "source.txt")), PAYLOAD,
      "guest copy changed its source");
  }
}

export function registerGuest({ api, workspace, register }) {
  // api is populated exclusively from the runner's selected --dist modules.
  const source = api.GUEST_FILESYSTEM_PYTHON;
  assert(typeof source === "string" && source.length > 0, "measured build lacks guest Python source");
  const metadata = {
    schemaVersion: 1,
    sourceExport: "GUEST_FILESYSTEM_PYTHON",
    sourceSha256: sha256(source),
    sourceBytes: Buffer.byteLength(source),
    interpreter: null,
  };
  for (const { name, operation, layout } of GUEST_BENCHMARK_CASES) {
    register(name, (fixture) => spawnSync(metadata.interpreter.executable,
      ["-c", source, ...fixture.argv], {
        input: operation === "write" || operation === "create" ? PAYLOAD : undefined,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: PROCESS_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      }), {
      sync: true,
      covers: [],
      skip: SUPPORTED_PLATFORMS.includes(process.platform) ? undefined : SKIP_REASON,
      workloadSemantics: "equivalent-output",
      workloadDetails: {
        operation, parentLayout: layout, parentDepth: 2,
        payloadBytes: operation === "mkdirp" ? 0 : PAYLOAD.length,
        processModel: "one-shot-python",
        processTimeoutMs: PROCESS_TIMEOUT_MS,
        sourceSha256: metadata.sourceSha256,
        hostNativeModeAffectsGuest: false,
      },
      before: () => {
        // Delayed until a selected row runs: unrelated filters need no Python.
        metadata.interpreter ??= inspectInterpreter();
        assertInterpreterStable(metadata.interpreter);
        return createGuestFixture(workspace, operation, layout);
      },
      after: (result, fixture) => {
        try {
          if (result !== undefined) verifyGuestResult(result, fixture);
          assertInterpreterStable(metadata.interpreter);
        } finally {
          fs.rmSync(fixture.directory, { recursive: true, force: true });
        }
      },
    });
  }
  return metadata;
}

export function validateGuestBenchmarkReport(report, filter = "") {
  const rows = (report.results ?? []).filter(({ name }) => name.startsWith("Guest."));
  if (!rows.length && !report.metadata?.guest && !filter.startsWith("Guest.")) return;
  const expected = GUEST_BENCHMARK_CASES.filter(({ name }) => name.includes(filter));
  assert.deepEqual(rows.map(({ name }) => name), expected.map(({ name }) => name),
    "guest benchmark row set mismatch");
  if (!rows.length) return;
  const metadata = report.metadata?.guest;
  assert.equal(metadata?.schemaVersion, 1, "guest benchmark source receipt missing");
  assert.equal(metadata.sourceExport, "GUEST_FILESYSTEM_PYTHON");
  assert.match(metadata.sourceSha256, /^[0-9a-f]{64}$/u);
  assert(Number.isSafeInteger(metadata.sourceBytes) && metadata.sourceBytes > 0);
  const supported = SUPPORTED_PLATFORMS.includes(report.metadata.platform);
  for (const [index, row] of rows.entries()) {
    const { operation, layout } = expected[index];
    assert.equal(row.workloadSemantics, "equivalent-output", "guest workload semantics mismatch");
    assert.deepEqual(row.workloadDetails, {
      operation, parentLayout: layout, parentDepth: 2,
      payloadBytes: operation === "mkdirp" ? 0 : PAYLOAD.length,
      processModel: "one-shot-python", processTimeoutMs: PROCESS_TIMEOUT_MS,
      sourceSha256: metadata.sourceSha256, hostNativeModeAffectsGuest: false,
    }, "guest workload receipt mismatch");
    assert.equal(row.skipped, supported ? undefined : SKIP_REASON, "guest platform skip mismatch");
  }
  if (!supported) {
    assert.equal(metadata.interpreter, null, "unsupported guest platform invoked Python");
    return;
  }
  const interpreter = metadata.interpreter;
  assert(interpreter, "guest Python interpreter receipt missing");
  for (const field of ["version", "implementation", "executable", "realPath", "machine"]) {
    assert(typeof interpreter[field] === "string" && interpreter[field].length > 0,
      `guest Python ${field} receipt missing`);
  }
  assert.equal(interpreter.platform, report.metadata.platform);
  assert.equal(interpreter.directoryFlags, true);
  assert.equal(interpreter.relativeDescriptors, true);
  assert.equal(interpreter.identityScope, IDENTITY_SCOPE);
  assert.match(interpreter.sha256, /^[0-9a-f]{64}$/u);
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
    assert.match(interpreter.stat?.[field], /^[0-9]+$/u, `guest Python ${field} identity missing`);
  }
}
