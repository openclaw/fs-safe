import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const WINDOWS_OWNER_CAUGHT_FAILURE_FILTER = "windows-owner-caught";
export const WINDOWS_OWNER_CAUGHT_FAILURE_CONTROL_DIVISOR = 20;

const PLATFORM_CONTROL =
  "inspectPathPermissions/windows-owner-caught/platform-control";
const POSIX_CONTROL =
  "inspectPathPermissions/windows-owner-caught/posix-control";
const ACL_PREFIX = "inspectWindowsAcl/windows-owner-caught";
const PATH_CONTROL_PREFIX = "inspectPathPermissions/windows-owner-caught";

const EMPTY_FACTS = JSON.stringify({
  ownerSid: "S-1-5-21-42",
  currentUserSid: "S-1-5-21-42",
  complete: true,
  daclPresent: true,
  aces: [],
  remote: false,
});
const POPULATED_FACTS = JSON.stringify({
  ownerSid: "S-1-5-21-42",
  currentUserSid: "S-1-5-21-42",
  complete: true,
  daclPresent: true,
  aces: [
    { sid: "S-1-5-21-42", mask: 0x001f_01ff, deny: false, inheritOnly: false },
    { sid: "S-1-1-0", mask: 1, deny: false, inheritOnly: false },
  ],
  remote: false,
});

const CASES = Object.freeze([
  Object.freeze({ name: PLATFORM_CONTROL, kind: "platform-control" }),
  Object.freeze({ name: POSIX_CONTROL, kind: "posix-control" }),
  Object.freeze({ name: `${ACL_PREFIX}/empty-success`, kind: "empty-success" }),
  Object.freeze({ name: `${ACL_PREFIX}/populated-success`, kind: "populated-success" }),
  Object.freeze({ name: `${ACL_PREFIX}/ordinary-error`, kind: "ordinary-error" }),
  Object.freeze({ name: `${ACL_PREFIX}/raw-command-buffer`, kind: "raw-command-buffer" }),
  Object.freeze({ name: `${ACL_PREFIX}/wrapped-timeout`, kind: "wrapped-timeout" }),
  Object.freeze({ name: `${ACL_PREFIX}/malformed-json`, kind: "malformed-json" }),
]);

export const WINDOWS_OWNER_CAUGHT_FAILURE_NAMES = Object.freeze(
  CASES.map(({ name }) => name),
);

export function windowsOwnerCaughtFailureDivisor(name) {
  return name.startsWith(`${ACL_PREFIX}/`)
    ? 1 : WINDOWS_OWNER_CAUGHT_FAILURE_CONTROL_DIVISOR;
}

export function windowsOwnerCaughtFailureIterations(name, iterations) {
  return Math.max(1, Math.floor(iterations / windowsOwnerCaughtFailureDivisor(name)));
}

export const WINDOWS_OWNER_CAUGHT_FAILURE_RECEIPT = Object.freeze({
  schemaVersion: 1,
  publicOperations: Object.freeze(["inspectPathPermissions", "inspectWindowsAcl"]),
  nativeModes: Object.freeze(["off", "require"]),
  sourceCohorts: Object.freeze([
    "prebuilt-empty-dacl-success",
    "prebuilt-populated-dacl-success",
    "ordinary-error",
    "raw-command-buffer-stderr",
    "wrapped-timeout",
    "malformed-json",
  ]),
  controls: Object.freeze(["windows-native-or-prebuilt-fallback", "forced-posix-policy"]),
  timedBoundary: "one-public-call-with-injected-executor-for-source-cohorts",
  hostileCases: "correctness-only-because-the-fix-changes-rejection-into-an-unverified-result",
  verification: "exact-route-result-cause-command-details-and-source-executor-count-outside-timing",
});

export const WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE = Object.freeze({
  target: "existing-0600-child-of-runner-workspace",
  windowsAclPreparation:
    "workspace-prepared-before-registration-by-registerCore/applyBenchmarkPrivateWindowsAcl",
  executorInputs: "immutable-and-created-before-timing",
  filesystemChecks: "before-and-after-timing",
});

function workloadDetails(kind) {
  return Object.freeze({
    ...WINDOWS_OWNER_CAUGHT_FAILURE_RECEIPT,
    cohort: kind,
  });
}

function assertNoFailure(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.errorDetail, undefined);
  assert.equal(result.errorCause, undefined);
}

function isGovernedWindowsOwnerCaughtFailureName(name) {
  return typeof name === "string" && (
    name === PATH_CONTROL_PREFIX || name.startsWith(`${PATH_CONTROL_PREFIX}/`) ||
    name === ACL_PREFIX || name.startsWith(`${ACL_PREFIX}/`)
  );
}

function verifyWindowsControl(result) {
  assert.equal(result.ok, true);
  assert.equal(result.source, "windows-acl");
  assertNoFailure(result);
  assert.equal(result.ownerTrusted, true);
  assert.match(result.ownerSid, /^s-\d+-\d+(-\d+)+$/iu);
  assert.equal(result.worldWritable, false);
  assert.equal(result.groupWritable, false);
  assert.equal(result.worldReadable, false);
  assert.equal(result.groupReadable, false);
}

function createSourceCases(PermissionCommandError) {
  const ordinary = new Error("ordinary owner failure");
  const rawCommand = Object.assign(new Error("raw command failure"), {
    code: 5,
    killed: false,
    signal: null,
    stderr: Buffer.from("access denied\n"),
  });
  const timeoutCause = Object.assign(new Error("deadline"), {
    code: null,
    killed: true,
    signal: "SIGKILL",
    stderr: "deadline\n",
  });
  const wrappedTimeout = new PermissionCommandError(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    30_125,
    timeoutCause,
  );
  return new Map([
    ["empty-success", {
      exec: async () => ({ stdout: EMPTY_FACTS, stderr: "" }),
      verify(result) {
        assert.equal(result.ok, true);
        assert.equal(result.entries.length, 0);
        assert.equal(result.untrustedWorld.length, 0);
        assertNoFailure(result);
      },
    }],
    ["populated-success", {
      exec: async () => ({ stdout: POPULATED_FACTS, stderr: "" }),
      verify(result) {
        assert.equal(result.ok, true);
        assert.equal(result.entries.length, 2);
        assert.equal(result.untrustedWorld.length, 1);
        assert.equal(result.untrustedWorld[0].sid, "s-1-1-0");
        assertNoFailure(result);
      },
    }],
    ["ordinary-error", {
      exec: async () => { throw ordinary; },
      verify(result) {
        assert.equal(result.ok, false);
        assert.equal(result.error, "Error: ordinary owner failure");
        assert.equal(result.errorDetail, undefined);
        assert.equal(result.errorCause, ordinary);
      },
    }],
    ["raw-command-buffer", {
      exec: async () => { throw rawCommand; },
      verify(result) {
        assert.equal(result.ok, false);
        assert.equal(result.error, "Error: raw command failure");
        assert.equal(result.errorCause, rawCommand);
        assert.match(result.errorDetail?.command, /powershell\.exe$/iu);
        assert(Number.isInteger(result.errorDetail?.durationMs));
        assert.equal(result.errorDetail?.exitCode, 5);
        assert.equal(result.errorDetail?.timedOut, false);
        assert.equal(result.errorDetail?.signal, null);
        assert.equal(result.errorDetail?.stderr, "access denied\\u000a");
      },
    }],
    ["wrapped-timeout", {
      exec: async () => { throw wrappedTimeout; },
      verify(result) {
        assert.equal(result.ok, false);
        assert.equal(result.errorCause, wrappedTimeout);
        assert.equal(
          result.error,
          "PermissionCommandError: Windows permission inspection timed out after 30000ms",
        );
        assert.match(result.errorDetail?.command, /powershell\.exe$/iu);
        assert.equal(result.errorDetail?.durationMs, 30_125);
        assert.equal(result.errorDetail?.timedOut, true);
        assert.equal(result.errorDetail?.signal, "SIGKILL");
        assert.equal(result.errorDetail?.stderr, "deadline\\u000a");
      },
    }],
    ["malformed-json", {
      exec: async () => ({ stdout: "{", stderr: "" }),
      verify(result) {
        assert.equal(result.ok, false);
        assert.match(result.error, /^SyntaxError:/u);
        assert.equal(result.errorDetail, undefined);
        assert(result.errorCause instanceof SyntaxError);
      },
    }],
  ]);
}

export function registerWindowsOwnerCaughtFailure({
  api,
  workspace,
  native,
  PermissionCommandError,
  register,
  onCleanup,
  platform = process.platform,
}) {
  assert.equal(typeof PermissionCommandError, "function",
    "selected build does not expose its internal permission command error");
  const directory = path.join(workspace, "windows-owner-caught-failure");
  const target = path.join(directory, "secret.json");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(target, "{}", { mode: 0o600 });
  onCleanup(() => fs.rmSync(directory, { recursive: true, force: true }));

  let controlCalls = 0;
  const controlExec = async () => {
    controlCalls += 1;
    return { stdout: EMPTY_FACTS, stderr: "" };
  };
  register(PLATFORM_CONTROL, () => api.inspectPathPermissions(target, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    exec: controlExec,
  }), {
    divisor: windowsOwnerCaughtFailureDivisor(PLATFORM_CONTROL),
    before: () => {
      controlCalls = 0;
      assert.equal(fs.readFileSync(target, "utf8"), "{}");
    },
    after: (result) => {
      assert.equal(controlCalls, platform === "win32" && native ? 0 : 1);
      verifyWindowsControl(result);
      assert.equal(fs.readFileSync(target, "utf8"), "{}");
    },
    workloadSemantics: "equivalent-output",
    workloadDetails: workloadDetails("platform-control"),
    fixturePlacement: WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE,
  });
  register(POSIX_CONTROL, () => api.inspectPathPermissions(target, { platform: "linux" }), {
    divisor: windowsOwnerCaughtFailureDivisor(POSIX_CONTROL),
    before: () => assert.equal(fs.readFileSync(target, "utf8"), "{}"),
    after: (result) => {
      assert.equal(result.ok, true);
      assert.equal(result.source, "posix");
      assertNoFailure(result);
      assert.equal(fs.readFileSync(target, "utf8"), "{}");
    },
    workloadSemantics: "equivalent-output",
    workloadDetails: workloadDetails("posix-control"),
    fixturePlacement: WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE,
  });

  for (const [kind, source] of createSourceCases(PermissionCommandError)) {
    let calls = 0;
    register(`${ACL_PREFIX}/${kind}`, () => api.inspectWindowsAcl("C:\\fixture", {
      env: { SystemRoot: "C:\\Windows" },
      exec: async (...args) => {
        calls += 1;
        return await source.exec(...args);
      },
    }), {
      divisor: windowsOwnerCaughtFailureDivisor(`${ACL_PREFIX}/${kind}`),
      before: () => {
        calls = 0;
        assert.equal(fs.readFileSync(target, "utf8"), "{}");
      },
      after: (result) => {
        assert.equal(calls, 1);
        source.verify(result);
        assert.equal(fs.readFileSync(target, "utf8"), "{}");
      },
      workloadSemantics: "equivalent-output",
      workloadDetails: workloadDetails(kind),
      fixturePlacement: WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE,
    });
  }
}

export function validateWindowsOwnerCaughtFailureResult(result) {
  const governed = isGovernedWindowsOwnerCaughtFailureName(result?.name);
  if (!governed) return;
  const spec = CASES.find(({ name }) => name === result.name);
  assert(spec, `${result.name} is not a declared Windows owner caught-failure row`);
  assert.equal(result.skipped, undefined, `${result.name} must execute rather than skip`);
  assert.equal(result.workloadSemantics, "equivalent-output",
    `${result.name} workload semantics mismatch`);
  assert.deepEqual(result.workloadDetails, workloadDetails(spec.kind),
    `${result.name} workload receipt mismatch`);
  assert.deepEqual(result.fixturePlacement, WINDOWS_OWNER_CAUGHT_FAILURE_FIXTURE,
    `${result.name} fixture receipt mismatch`);
}

export function validateWindowsOwnerCaughtFailureReport(report, filter = "", iterations) {
  const expected = CASES.filter(({ name }) => !filter || name.includes(filter));
  const results = report.results ?? [];
  assert(Array.isArray(results), "Windows owner caught-failure results must be an array");
  const rows = results.filter(({ name }) =>
    isGovernedWindowsOwnerCaughtFailureName(name));
  assert.deepEqual(rows.map(({ name }) => name), expected.map(({ name }) => name),
    "Windows owner caught-failure row set mismatch");
  if (rows.length === 0 && expected.length === 0) return;
  if (filter.includes(WINDOWS_OWNER_CAUGHT_FAILURE_FILTER)) {
    assert(["off", "require"].includes(report.metadata?.mode),
      "Windows owner caught-failure native mode mismatch");
  }
  for (const row of rows) {
    validateWindowsOwnerCaughtFailureResult(row);
    if (iterations !== undefined) {
      assert.equal(
        row.iterations,
        windowsOwnerCaughtFailureIterations(row.name, iterations),
        `${row.name} iteration count mismatch`,
      );
    }
  }
}
