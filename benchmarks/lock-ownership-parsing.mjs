import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { attemptBenchmarkCleanup, throwBenchmarkFailures } from "./runner-cleanup.mjs";

const TOKEN_BYTES = 138;
const MAX_SIDECAR_BYTES = 1024 * 1024;
const ITERATION_DIVISOR = 100;
const PAYLOAD_SIZES = Object.freeze([
  Object.freeze({ label: "128B-json", jsonBytes: 128 }),
  Object.freeze({ label: "64KiB-json", jsonBytes: 64 * 1024 }),
  Object.freeze({ label: "near-cap", jsonBytes: MAX_SIDECAR_BYTES - TOKEN_BYTES - 1 }),
]);
const FIXTURE_PLACEMENT = "unique child directory on the runner workspace filesystem";

function recordCount(jsonBytes) {
  return Math.max(1, Math.floor(jsonBytes / 110));
}

function buildCases() {
  const rows = [];
  for (const rooted of [false, true]) {
    for (const sync of [false, true]) {
      for (const method of ["verifyStillHeld", "release"]) {
        for (const size of PAYLOAD_SIZES) {
          for (const shape of ["string", "records"]) {
            for (const parser of ["default", "custom-json"]) {
              const handleType = `FileLock${sync ? "Sync" : ""}Handle`;
              rows.push(Object.freeze({
                name: `${handleType}.${method}/ownership-parsing/${parser}/${rooted ? "root" : "raw"}/${size.label}/${shape}`,
                divisor: ITERATION_DIVISOR,
                workloadSemantics: "equivalent-output",
                workloadDetails: Object.freeze({
                  schema: "lock-ownership-parsing-v1",
                  api: `${handleType}.${method}`,
                  method,
                  rooted,
                  sync,
                  parser,
                  payloadShape: shape,
                  jsonBytes: size.jsonBytes,
                  sidecarBytes: size.jsonBytes + TOKEN_BYTES,
                  ownershipWhitespaceBytes: TOKEN_BYTES,
                  recordCount: shape === "records" ? recordCount(size.jsonBytes) : 0,
                  recordShape: shape === "records" ? "{ id, values: [id, id + 1] }" : null,
                  padding: "ASCII x; JSON uses two-space indentation",
                  customParserCalls: parser === "custom-json" && (method === "verifyStillHeld" || !sync) ? 1 : 0,
                  timedOperation: `one complete public ${handleType}.${method} call`,
                  untimedOperations: Object.freeze([
                    "payload construction", "acquisition", "byte and ownership verification", "cleanup",
                  ]),
                  cleanupContract: "no lock or reclaim file remains; custom parser observations are checked",
                }),
              }));
            }
          }
        }
      }
    }
  }
  return Object.freeze(rows);
}

export const LOCK_OWNERSHIP_PARSING_CASES = buildCases();
const CASES_BY_NAME = new Map(LOCK_OWNERSHIP_PARSING_CASES.map((row) => [row.name, row]));

function makePayload({ payloadShape, jsonBytes }) {
  const payload = payloadShape === "string" ? { data: "" } : {
    records: Object.freeze(Array.from({ length: recordCount(jsonBytes) }, (_, id) =>
      Object.freeze({ id, values: Object.freeze([id, id + 1]) }))),
    padding: "",
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(payload, null, 2));
  assert(baseBytes <= jsonBytes, "structured lock payload exceeds its JSON byte budget");
  payload[payloadShape === "string" ? "data" : "padding"] = "x".repeat(jsonBytes - baseBytes);
  Object.freeze(payload);
  const json = JSON.stringify(payload, null, 2);
  assert.equal(Buffer.byteLength(json), jsonBytes);
  assert(jsonBytes + TOKEN_BYTES < MAX_SIDECAR_BYTES);
  return Object.freeze({ payload, json });
}

function assertEmpty(fixture) {
  assert.deepEqual(fs.readdirSync(fixture.directory), [],
    `${fixture.row.name} left a lock or reclaim file`);
}

function inspectOwnedSidecar(fixture, expected) {
  assert.deepEqual(fs.readdirSync(fixture.directory), ["target.lock"]);
  const stat = fs.lstatSync(fixture.lockPath, { bigint: true });
  assert(stat.isFile() && !stat.isSymbolicLink(), "sidecar is not a regular file");
  assert.equal(stat.nlink, 1n, "sidecar has an unexpected hardlink");
  assert.equal(stat.size, BigInt(fixture.row.workloadDetails.sidecarBytes));
  if (process.platform !== "win32") assert.equal(stat.mode & 0o077n, 0n);
  const raw = fs.readFileSync(fixture.lockPath, "utf8");
  assert.equal(Buffer.byteLength(raw), fixture.row.workloadDetails.sidecarBytes);
  assert.equal(raw.slice(0, fixture.payload.json.length), fixture.payload.json);
  assert.match(raw.slice(fixture.payload.json.length), /^\n\t{8}[ \t]{128}\n$/u,
    "sidecar has no intact ownership token");
  const identity = [stat.dev, stat.ino, stat.nlink, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs];
  if (expected) {
    assert.equal(raw, expected.raw, "verification changed the owned sidecar bytes");
    assert.deepEqual(identity, expected.identity, "verification changed the owned sidecar identity");
  }
  return { raw, identity };
}

function verifyParser(fixture, expectedCalls) {
  assert.equal(fixture.parserCalls, expectedCalls, "custom parser invocation count changed");
  if (expectedCalls > 0) {
    assert.equal(fixture.parserReceiver, undefined, "custom parser receiver changed");
    assert.equal(fixture.parserRaw, fixture.receipt.raw, "custom parser received different sidecar bytes");
  }
}

export function registerLockOwnershipParsing({ api, workspace, register, onCleanup }) {
  const directory = path.join(workspace, "lock-ownership-parsing");
  const fixtures = [];
  const payloads = new Map();
  let directoryCreated = false;
  onCleanup(async () => {
    const failures = [];
    for (const fixture of fixtures) {
      if (fixture.handle) {
        await attemptBenchmarkCleanup(failures, async () => {
          await fixture.handle.release();
          fixture.handle = undefined;
        });
      }
      if (fixture.created) await attemptBenchmarkCleanup(failures, () => assertEmpty(fixture));
    }
    if (directoryCreated) {
      await attemptBenchmarkCleanup(failures, () => fs.rmSync(directory, { recursive: true, force: true }));
    }
    throwBenchmarkFailures(failures, "lock ownership parsing benchmark cleanup failed");
  });
  fs.mkdirSync(directory, { mode: 0o700 });
  directoryCreated = true;

  for (const [index, row] of LOCK_OWNERSHIP_PARSING_CASES.entries()) {
    const details = row.workloadDetails;
    const payloadKey = `${details.payloadShape}:${details.jsonBytes}`;
    if (!payloads.has(payloadKey)) payloads.set(payloadKey, makePayload(details));
    const fixture = {
      row,
      payload: payloads.get(payloadKey),
      directory: path.join(directory, `row-${index}`),
      created: false,
      handle: undefined,
      lockRoot: undefined,
      receipt: undefined,
      parserCalls: 0,
      parserRaw: undefined,
      parserReceiver: undefined,
    };
    fixtures.push(fixture);
    const options = {
      payload: () => fixture.payload.payload,
      retry: { retries: 0 },
      timeoutMs: 1000,
      ...(details.parser === "custom-json" ? {
        parsePayload: function (raw) {
          fixture.parserCalls += 1;
          fixture.parserRaw = raw;
          fixture.parserReceiver = this;
          return JSON.parse(raw);
        },
      } : {}),
    };

    register(row.name, ({ handle }) => handle[details.method](), {
      sync: details.sync,
      divisor: row.divisor,
      covers: [details.api],
      workloadSemantics: row.workloadSemantics,
      workloadDetails: details,
      fixturePlacement: FIXTURE_PLACEMENT,
      before: async () => {
        if (!fixture.created) {
          fs.mkdirSync(fixture.directory, { mode: 0o700 });
          fixture.created = true;
          fixture.directory = fs.realpathSync.native(fixture.directory);
          if (details.rooted) {
            fixture.lockRoot = await api.root(fixture.directory);
            options.lockRoot = fixture.lockRoot;
          }
          fixture.targetPath = path.join(fixture.lockRoot?.rootReal ?? fixture.directory, "target");
          fixture.lockPath = `${fixture.targetPath}.lock`;
        }
        assert.equal(fixture.handle, undefined, "previous benchmark handle was not released");
        assertEmpty(fixture);
        fixture.parserCalls = 0;
        fixture.parserRaw = undefined;
        fixture.parserReceiver = undefined;
        fixture.handle = details.sync
          ? api.acquireFileLockSync(fixture.targetPath, options)
          : await api.acquireFileLock(fixture.targetPath, options);
        assert.equal(path.relative(fixture.lockPath, fixture.handle.lockPath), "");
        assert.equal(path.relative(fixture.targetPath, fixture.handle.normalizedTargetPath), "");
        fixture.receipt = inspectOwnedSidecar(fixture);
        verifyParser(fixture, 0);
        return { handle: fixture.handle };
      },
      after: async (result) => {
        const failures = [];
        await attemptBenchmarkCleanup(failures, () => {
          verifyParser(fixture, details.customParserCalls);
          if (details.method === "verifyStillHeld") {
            assert.equal(result, true, "owned lock verification did not succeed");
            inspectOwnedSidecar(fixture, fixture.receipt);
          } else {
            assert.equal(result, undefined, "lock release returned an unexpected value");
            // Check removal before a cleanup retry can conceal a broken release.
            assertEmpty(fixture);
          }
        });
        await attemptBenchmarkCleanup(failures, async () => {
          await fixture.handle.release();
          fixture.handle = undefined;
        });
        await attemptBenchmarkCleanup(failures, () => assertEmpty(fixture));
        fixture.receipt = undefined;
        fixture.parserRaw = undefined;
        throwBenchmarkFailures(failures, `${row.name} verification or cleanup failed`);
      },
    });
  }
}

export function validateLockOwnershipParsingReport(report, filter = "", expectedIterations) {
  const expected = LOCK_OWNERSHIP_PARSING_CASES.filter(({ name }) => !filter || name.includes(filter));
  const results = (report.results ?? []).filter(({ name }) => name.includes("/ownership-parsing/"));
  assert.deepEqual(results.map(({ name }) => name), expected.map(({ name }) => name),
    "lock ownership parsing benchmark row set mismatch");
  for (const result of results) {
    const row = CASES_BY_NAME.get(result.name);
    assert.equal(result.skipped, undefined, `${result.name} must execute rather than skip`);
    assert.equal(result.workloadSemantics, row.workloadSemantics);
    assert.deepEqual(result.workloadDetails, row.workloadDetails);
    assert.equal(result.fixturePlacement, FIXTURE_PLACEMENT);
    if (expectedIterations !== undefined) {
      assert.equal(result.iterations, Math.max(1, Math.floor(expectedIterations / row.divisor)));
    }
  }
}
