import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { benchmarkEnvironment } from "./benchmark-environment.mjs";
import { finishBenchmarkInvocation } from "./runner-cleanup.mjs";

export const NATIVE_WINDOWS_COLON_FILTER = "native-windows-colon/";
const SHA256 = /^[a-f0-9]{64}$/u;
const SID = /^s-\d+-\d+(?:-\d+)+$/i;
const REASONS = Object.freeze({
  stream: "Windows filesystem path contains alternate stream syntax",
  nul: "Windows path contains a NUL byte",
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const PUBLIC = Object.freeze({
  name: `readOwnerAndDacl/${NATIVE_WINDOWS_COLON_FILTER}public-success`,
  workloadSemantics: "successful public Windows owner and DACL inspection",
  workloadDetails: Object.freeze({
    route: "public readOwnerAndDacl via selected native binding", fixture: "existing runner input.json",
    timedOperations: "complete synchronous public call including native filesystem/security work",
    untimedOperations: "retained input identity/content checks and original owner/DACL after checks on every invocation",
  }),
});
const PRIVATE = Object.freeze(["ordinary-drive", "extended-drive"].flatMap(form => [16, 4096].flatMap(payloadBytes =>
  ["stream", "nul"].map(terminal => {
    const input = `${form === "ordinary-drive" ? "C:\\" : "\\\\?\\C:\\"}${"x".repeat(payloadBytes)}${terminal === "stream" ? ":stream" : "\0"}`;
    return Object.freeze({
      name: `nativeBinding.readOwnerAndDacl/${NATIVE_WINDOWS_COLON_FILTER}private-admission/${form}/payload=${payloadBytes}/${terminal}`,
      input,
      workloadSemantics: "private Windows N-API admission error call",
      workloadDetails: Object.freeze({
        route: "private selected binding.readOwnerAndDacl", form, payloadBytes,
        inputBytes: Buffer.byteLength(input), inputCodeUnits: input.length, inputSha256: hash(input), terminal,
        expectedCode: "EINVAL", expectedReason: REASONS[terminal],
        timedOperations: "N-API string conversion, Windows colon admission, native error construction/translation and runner catch",
        untimedOperations: "exact Error/code/message checks on every invocation",
        errorRoute: terminal === "stream" ? "forbidden-colon rejection before Windows operation" : "colon admitted; wide() rejects actual NUL before security-handle open",
        ioBoundary: "source-established rejection before filesystem work in this native call; registration/process I/O is outside this claim",
      }),
    });
  }),
)));
const ROWS = Object.freeze([PUBLIC, ...PRIVATE]);
export const nativeWindowsColonDescriptors = () => ROWS;
export const NATIVE_WINDOWS_COLON_NAMES = Object.freeze(ROWS.map(row => row.name));
const familyRow = name => typeof name === "string" && name.includes(NATIVE_WINDOWS_COLON_FILTER);
const selectedStudy = filter => filter === NATIVE_WINDOWS_COLON_FILTER;

export function ownerAndDaclBenchmark(api, input, platform = process.platform) {
  return {
    run: () => api.readOwnerAndDacl(input),
    options: {
      sync: true, skip: platform !== "win32" ? "Windows owner and DACL inspection requires Windows." : undefined,
      after: result => {
        assert.equal(result.status, "supported");
        assert(result.isLocal && result.complete && result.daclPresent);
        assert.deepEqual(result.unsupportedAceTypes, []);
        for (const sid of [result.ownerSid, result.currentUserSid]) assert.match(sid, SID);
      },
    },
  };
}

function validateLoader(loader) {
  assert(loader && typeof loader === "object", "native colon loader receipt missing");
  assert.deepEqual(Object.keys(loader).sort(), ["addonRelativePath", "addonBasename", "addonBytes", "addonSha256", "bindingMethod", "loaderModule", "loaderSha256", "mechanism", "modulesAbi", "napiVersion"].sort());
  assert.equal(loader.mechanism, "require-cache module.exports identity");
  assert.equal(loader.loaderModule, "native.js");
  assert.equal(loader.bindingMethod, "readOwnerAndDacl");
  assert.equal(loader.addonRelativePath, "packages/win32-x64-msvc/fs-safe-native.node");
  assert.equal(loader.addonBasename, "fs-safe-native.node");
  for (const field of ["addonSha256", "loaderSha256"]) assert.match(loader[field], SHA256);
  assert(typeof loader.addonBasename === "string" && /^[^/\\]+\.node$/u.test(loader.addonBasename), "native colon addon name invalid");
  assert(Number.isSafeInteger(loader.addonBytes) && loader.addonBytes > 0, "native colon addon size invalid");
  for (const field of ["modulesAbi", "napiVersion"]) assert.match(loader[field], /^[1-9]\d*$/u);
}

function fileReceipt(input) {
  const stat = fs.lstatSync(input, { bigint: true });
  assert(stat.isFile() && !stat.isSymbolicLink(), "native colon input is not an ordinary file");
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), sha256: hash(fs.readFileSync(input)) };
}

function publicInputShape(input) {
  assert(!input.includes("\0"), "native colon public input contains NUL");
  const ordinary = /^[A-Za-z]:[\\/]/u.test(input);
  const extended = input.startsWith("\\\\?\\") && /^[A-Za-z]:\\/u.test(input.slice(4));
  assert(ordinary || extended, "native colon public input is not a rooted drive spelling");
  return {
    inputUtf8Bytes: Buffer.byteLength(input), inputUtf16CodeUnits: input.length,
    inputSpelling: ordinary ? "ordinary-drive" : "extended-drive",
  };
}

export function registerNativeWindowsColon({ api, binding, native, nativeLoader, workspace, args, register,
  publicCase, platform = process.platform }) {
  // Opt-in keeps the pre-existing public row and its broader filters unchanged.
  if (!selectedStudy(args.filter)) return;
  assert.equal(platform, "win32", "native colon qualification requires actual Windows");
  assert.equal(args.mode, "require", "native colon study requires native mode require");
  assert.equal(native, true, "native colon binding was not loaded");
  assert.equal(typeof binding?.readOwnerAndDacl, "function", "native colon export missing");
  assert.equal(typeof api.readOwnerAndDacl, "function", "native colon public export missing");
  validateLoader(nativeLoader);
  const inspect = binding.readOwnerAndDacl;
  const publicInspect = api.readOwnerAndDacl;
  const input = path.win32.join(workspace, "input.json");
  const inputShape = publicInputShape(input);
  const receipt = fileReceipt(input);
  const filesystem = fs.statfsSync(workspace);
  const placement = Object.freeze({
    kind: "existing runner input.json", bytes: receipt.size, sha256: receipt.sha256,
    ...inputShape,
    canonicalParentDepth: path.win32.relative(path.win32.parse(workspace).root, workspace).split(path.win32.sep).filter(Boolean).length,
    filesystemType: filesystem.type, filesystemBlockSize: filesystem.bsize,
  });
  const original = publicCase ?? ownerAndDaclBenchmark(api, input, platform);
  const verifyBinding = () => assert.equal(binding.readOwnerAndDacl, inspect, "native colon binding method changed");
  const verifyInput = () => {
    verifyBinding();
    assert.equal(api.readOwnerAndDacl, publicInspect, "native colon public method changed");
    assert.deepEqual(fileReceipt(input), receipt, "native colon public fixture changed");
  };
  register(PUBLIC.name, original.run, {
    ...original.options, covers: ["readOwnerAndDacl"],
    workloadSemantics: PUBLIC.workloadSemantics, workloadDetails: PUBLIC.workloadDetails, fixturePlacement: placement,
    before: verifyInput,
    after: result => { original.options.after(result); verifyInput(); },
  });
  for (const row of PRIVATE) {
    const { form, payloadBytes, terminal } = row.workloadDetails;
    const prefix = form === "ordinary-drive" ? "C:\\" : "\\\\?\\C:\\";
    const suffix = terminal === "stream" ? ":stream" : "\0";
    assert.equal(row.input.slice(0, prefix.length), prefix);
    assert.equal(row.input.slice(-suffix.length), suffix);
    assert.equal(row.input.slice(prefix.length, -suffix.length), "x".repeat(payloadBytes));
    assert.equal(publicInputShape(row.input.slice(0, -suffix.length)).inputSpelling, form);
    assert.equal(Buffer.byteLength(row.input), row.workloadDetails.inputBytes);
    assert.equal(row.input.length, row.workloadDetails.inputCodeUnits);
    register(row.name, () => binding.readOwnerAndDacl(row.input), {
      sync: true, expectError: true, covers: [], before: verifyBinding,
      workloadSemantics: row.workloadSemantics, workloadDetails: row.workloadDetails,
      fixturePlacement: "prebuilt synthetic Windows pathname; no pathname filesystem lookup in selected error route",
      after: error => {
        assert(error instanceof Error, "native colon call did not return an Error");
        assert.equal(error.code, "EINVAL", "native colon error code mismatch");
        assert.equal(error.message, row.workloadDetails.expectedReason, "native colon error reason mismatch");
        verifyBinding();
      },
    });
  }
}

function qualifiedOutcome(result, isPublic) {
  return isPublic ? {
    kind: "public-success", status: result.status, isLocal: result.isLocal,
    complete: result.complete, daclPresent: result.daclPresent,
    unsupportedAceTypes: [...result.unsupportedAceTypes],
    ownerSidValid: SID.test(result.ownerSid), currentUserSidValid: SID.test(result.currentUserSid),
  } : { kind: "private-error", isError: result instanceof Error, code: result.code, message: result.message };
}

function expectedQualifiedOutcome(row) {
  return row === PUBLIC ? {
    kind: "public-success", status: "supported", isLocal: true, complete: true,
    daclPresent: true, unsupportedAceTypes: [], ownerSidValid: true, currentUserSidValid: true,
  } : { kind: "private-error", isError: true, code: "EINVAL", message: row.workloadDetails.expectedReason };
}

export function validateNativeWindowsColonQualification(receipt, nativeLoader) {
  assert(receipt && typeof receipt === "object", "native colon upfront qualification missing");
  assert.deepEqual(Object.keys(receipt).sort(), ["schemaVersion", "phase", "timer", "passes", "calls", "nativeLoader", "outcomes"].sort());
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.phase, "upfront before all selected row timing");
  assert.equal(receipt.timer, "not read by qualification driver");
  assert.equal(receipt.passes, 2);
  assert.equal(receipt.calls, 18);
  validateLoader(receipt.nativeLoader);
  assert.deepEqual(receipt.nativeLoader, nativeLoader, "native colon qualified loader mismatch");
  const expected = [1, 2].flatMap(pass => ROWS.map(row => ({
    pass, name: row.name, outcome: expectedQualifiedOutcome(row),
  })));
  assert.deepEqual(receipt.outcomes, expected, "native colon upfront outcomes incomplete or invalid");
}

export async function qualifyNativeWindowsColon({ cases, args, nativeLoader, platform = process.platform }) {
  if (!selectedStudy(args.filter)) return null;
  assert.equal(platform, "win32", "native colon qualification requires actual Windows");
  assert.equal(args.mode, "require", "native colon study requires native mode require");
  validateLoader(nativeLoader);
  const selected = cases.filter(row => familyRow(row.name));
  assert.deepEqual(selected.map(row => row.name), NATIVE_WINDOWS_COLON_NAMES, "native colon qualification row set mismatch");
  for (const [index, row] of selected.entries()) {
    assert.equal(row.sync, true);
    assert.equal(row.skip, undefined);
    assert.equal(row.expectError, index === 0 ? undefined : true);
    assert.equal(row.divisor ?? 1, 1);
    assert.equal(row.batch ?? 1, 1);
    for (const method of ["before", "run", "after"]) assert.equal(typeof row[method], "function");
  }
  const receipt = { schemaVersion: 1, phase: "upfront before all selected row timing",
    timer: "not read by qualification driver", passes: 2, calls: 0,
    nativeLoader: { ...nativeLoader }, outcomes: [] };
  for (const pass of [1, 2]) {
    for (const [index, row] of selected.entries()) {
      const input = await row.before();
      let output;
      const failures = [];
      try {
        let rejected = false;
        receipt.calls += 1;
        try { output = row.run(input); }
        catch (error) {
          if (!row.expectError) throw error;
          output = error;
          rejected = true;
        }
        if (row.expectError && !rejected) throw new Error(`${row.name} unexpectedly succeeded during upfront qualification`);
      } catch (error) { failures.push(error); }
      await finishBenchmarkInvocation(failures, () => row.after(output, input), `${row.name} upfront qualification and settlement failed`);
      const outcome = qualifiedOutcome(output, index === 0);
      assert.deepEqual(outcome, expectedQualifiedOutcome(ROWS[index]), "native colon upfront outcome mismatch");
      receipt.outcomes.push({ pass, name: row.name, outcome });
    }
  }
  validateNativeWindowsColonQualification(receipt, nativeLoader);
  return receipt;
}

export function validateNativeWindowsColonReport(report, filter = "", iterations, samples) {
  const results = (report.results ?? []).filter(row => familyRow(row.name));
  assert.deepEqual(results.map(row => row.name), selectedStudy(filter) ? NATIVE_WINDOWS_COLON_NAMES : [], "native colon row set mismatch");
  if (!selectedStudy(filter)) return;
  assert.equal(report.results.length, ROWS.length, "native colon report contains extra rows");
  const environment = benchmarkEnvironment(report.metadata);
  assert.equal(environment.platform, "win32", "native colon report is not Windows");
  assert.equal(environment.arch, "x64", "native colon addon target is Windows x64");
  assert.equal(report.metadata.mode, "require");
  assert.equal(report.metadata.native, true);
  validateLoader(report.metadata.nativeLoader);
  assert.equal(report.metadata.nativeHash, report.metadata.nativeLoader.addonSha256);
  validateNativeWindowsColonQualification(report.metadata.nativeWindowsColonQualification, report.metadata.nativeLoader);
  for (const [index, result] of results.entries()) {
    const row = ROWS[index];
    assert.equal(result.skipped, undefined, "native colon row skipped");
    assert.equal(result.workloadSemantics, row.workloadSemantics);
    assert.deepEqual(result.workloadDetails, row.workloadDetails, "native colon workload mismatch");
    if (iterations !== undefined) assert.equal(result.iterations, iterations, "native colon iterations mismatch");
    if (samples !== undefined) assert(Array.isArray(result.samplesUs) && result.samplesUs.length === samples, "native colon sample count mismatch");
    if (index > 0) {
      assert.equal(result.fixturePlacement, "prebuilt synthetic Windows pathname; no pathname filesystem lookup in selected error route");
    } else {
      const fixture = result.fixturePlacement;
      assert(fixture && typeof fixture === "object", "native colon public fixture missing");
      assert.deepEqual(Object.keys(fixture).sort(), ["kind", "bytes", "sha256", "canonicalParentDepth", "filesystemType", "filesystemBlockSize", "inputUtf8Bytes", "inputUtf16CodeUnits", "inputSpelling"].sort());
      assert.equal(fixture.kind, "existing runner input.json");
      assert(Number.isSafeInteger(fixture.bytes) && fixture.bytes > 0);
      assert.match(fixture.sha256, SHA256);
      assert(Number.isSafeInteger(fixture.canonicalParentDepth) && fixture.canonicalParentDepth > 0);
      for (const field of ["inputUtf8Bytes", "inputUtf16CodeUnits"]) assert(Number.isSafeInteger(fixture[field]) && fixture[field] > 0);
      assert(fixture.inputUtf8Bytes >= fixture.inputUtf16CodeUnits);
      assert(["ordinary-drive", "extended-drive"].includes(fixture.inputSpelling));
      assert.equal(fixture.filesystemType, environment.workspaceFilesystem.type);
      assert.equal(fixture.filesystemBlockSize, environment.workspaceFilesystem.blockSize);
    }
  }
}

function validateDependencies(value) {
  assert(value && value.schemaVersion === 1 && value.scope === "pnpm-layout-manifests-locks-native-v1", "native colon dependency receipt missing");
  assert.match(value.hash, SHA256);
  assert(Number.isSafeInteger(value.entries) && value.entries > 0);
  assert(Number.isSafeInteger(value.hashedBytes) && value.hashedBytes > 0);
  assert.deepEqual(value.limits, { maxEntries: 100_000, maxHashedBytes: 128 * 1024 * 1024 });
  assert(value.entries <= value.limits.maxEntries && value.hashedBytes <= value.limits.maxHashedBytes);
  assert(typeof value.limitation === "string" && value.limitation.trim().length > 0, "native colon dependency scope limitation missing");
}

export function validateNativeWindowsColonReportSet(plan, reports, before) {
  if (!selectedStudy(plan.settings.filter)) return;
  assert.match(plan.planHash, SHA256);
  assert.equal(before.planHash, plan.planHash, "native colon snapshot is not bound to plan");
  validateDependencies(before.harness.dependencySnapshot);
  for (const build of Object.values(before.builds)) {
    validateDependencies(build.dependencySnapshot);
    assert.equal(build.installationSchemaVersion, 1);
    assert.match(build.runnerDistHash, SHA256);
    assert.equal(build.distTreeHash?.algorithm, "bounded-tree-sha256-v1");
    assert.match(build.distTreeHash.hash, SHA256);
    for (const field of ["entries", "bytes"]) assert(Number.isSafeInteger(build.distTreeHash[field]) && build.distTreeHash[field] > 0);
  }
  let environment;
  let fixture;
  const loaders = new Map();
  for (const spec of plan.reports) {
    const report = reports.get(spec.file);
    validateNativeWindowsColonReport(report, plan.settings.filter, plan.settings.iterations, plan.settings.samples);
    const current = { ...benchmarkEnvironment(report.metadata),
      modulesAbi: report.metadata.nativeLoader.modulesAbi, napiVersion: report.metadata.nativeLoader.napiVersion };
    if (environment) assert.deepEqual(current, environment, "native colon environment changed within dispatch");
    else environment = current;
    if (fixture) assert.deepEqual(report.results[0].fixturePlacement, fixture, "native colon fixture changed within dispatch");
    else fixture = report.results[0].fixturePlacement;
    const loader = report.metadata.nativeLoader;
    if (loaders.has(spec.buildId)) assert.deepEqual(loader, loaders.get(spec.buildId), "native colon loader changed within measured build");
    else loaders.set(spec.buildId, loader);
    const build = before.builds[spec.buildId];
    assert(build.nativeArtifacts.some(artifact => artifact.sha256 === loader.addonSha256 && artifact.size === loader.addonBytes &&
      artifact.path === loader.addonRelativePath), "native colon loaded addon is not the staged Windows artifact");
  }
}
