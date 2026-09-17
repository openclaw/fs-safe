import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME =
  "inspectPathPermissions/windows-owner-routing-success";
export const LIVE_PERMISSION_CONTROL_NAME = "inspectPathPermissions";

export const WINDOWS_OWNER_DIAGNOSTIC_WORKLOAD = Object.freeze({
  schemaVersion: 1,
  publicOperation: "inspectPathPermissions",
  platform: "win32-policy-on-each-runner",
  nativeModes: Object.freeze(["off", "require"]),
  query: "native-preferred-with-prebuilt-complete-owner-and-dacl-fallback",
  expectedExecutorCalls: "zero on native Windows; one otherwise",
  timedBoundary: "public-call-only",
  verification: "source+owner+acl+executor-call-count",
});

export const WINDOWS_OWNER_DIAGNOSTIC_FIXTURE = Object.freeze({
  placement: "unique-child-of-runner-workspace",
  setup: "before-timing",
  verification: "after-timing",
});

const DIVISOR = 20;
const SID_RE = /^\*?s-\d+-\d+(-\d+)+$/iu;

const OWNER_FACTS = JSON.stringify({
  ownerSid: "S-1-5-21-42",
  currentUserSid: "S-1-5-21-42",
  complete: true,
  daclPresent: true,
  aces: [],
  remote: false,
});

export function registerWindowsOwnerDiagnostic({
  api,
  workspace,
  native,
  register,
  onCleanup,
  platform = process.platform,
}) {
  const directory = path.join(workspace, "windows-owner-diagnostic");
  const target = path.join(directory, "secret.json");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(target, "{}", { mode: 0o600 });
  onCleanup(() => fs.rmSync(directory, { recursive: true, force: true }));
  let executorCalls = 0;
  const exec = async () => {
    executorCalls += 1;
    return { stdout: OWNER_FACTS, stderr: "" };
  };
  const nativeWindowsRoute = native && platform === "win32";

  register(
    WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME,
    () => api.inspectPathPermissions(target, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      exec,
    }),
    {
      divisor: DIVISOR,
      before: () => {
        executorCalls = 0;
        assert.equal(fs.readFileSync(target, "utf8"), "{}");
      },
      after: (result) => {
        assert.equal(executorCalls, nativeWindowsRoute ? 0 : 1);
        assert.equal(result.ok, true);
        assert.equal(result.source, "windows-acl");
        assert.equal(result.ownerTrusted, true);
        assert.equal(result.error, undefined);
        assert.equal(result.ownerError, undefined);
        assert.equal(result.errorDetail, undefined);
        assert.equal(result.errorCause, undefined);
        assert.equal(typeof result.ownerSid, "string");
        assert.match(result.ownerSid, SID_RE);
        assert.equal(result.worldWritable, false);
        assert.equal(result.groupWritable, false);
        assert.equal(result.worldReadable, false);
        assert.equal(result.groupReadable, false);
        if (!nativeWindowsRoute) {
          assert.equal(result.ownerSid, "s-1-5-21-42");
        }
      },
      workloadSemantics: "equivalent-output",
      workloadDetails: WINDOWS_OWNER_DIAGNOSTIC_WORKLOAD,
      fixturePlacement: WINDOWS_OWNER_DIAGNOSTIC_FIXTURE,
    },
  );
}

export function verifyLivePermissionControl(result, platform = process.platform) {
  assert.equal(result.ok, true, "live permission control did not complete");
  assert.equal(
    result.source,
    platform === "win32" ? "windows-acl" : "posix",
    "live permission control used an unverified source",
  );
  assert.equal(result.error, undefined, "live permission control retained an error");
  assert.equal(result.ownerError, undefined, "live permission control retained an owner error");
  assert.equal(result.errorDetail, undefined, "live permission control retained an error detail");
  assert.equal(result.errorCause, undefined, "live permission control retained an error cause");
  assert.equal(result.worldWritable, false, "live permission control was world-writable");
  assert.equal(result.groupWritable, false, "live permission control was group-writable");
  assert.equal(result.worldReadable, false, "live permission control was world-readable");
  assert.equal(result.groupReadable, false, "live permission control was group-readable");
  if (platform === "win32") {
    assert.equal(result.ownerTrusted, true, "live permission control owner was untrusted");
    assert.equal(typeof result.ownerSid, "string", "live permission control owner SID was missing");
    assert.match(result.ownerSid, SID_RE, "live permission control owner SID was invalid");
  }
}

export function validateWindowsOwnerDiagnosticWorkloadResult(result) {
  if (result.name !== WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME) return;
  assert.equal(result.skipped, undefined, `${result.name} must execute rather than skip`);
  assert.equal(
    result.workloadSemantics,
    "equivalent-output",
    `${result.name} workload semantics mismatch`,
  );
  assert.deepEqual(
    result.workloadDetails,
    WINDOWS_OWNER_DIAGNOSTIC_WORKLOAD,
    `${result.name} workload details mismatch`,
  );
  assert.deepEqual(
    result.fixturePlacement,
    WINDOWS_OWNER_DIAGNOSTIC_FIXTURE,
    `${result.name} fixture placement mismatch`,
  );
}

export function validateWindowsOwnerDiagnosticReport(
  report,
  filter = "",
  configuredIterations,
) {
  const sourceSelected = !filter || WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME.includes(filter);
  const liveSelected = !filter || LIVE_PERMISSION_CONTROL_NAME.includes(filter);
  const rows = (report.results ?? [])
    .filter(({ name }) => [
      LIVE_PERMISSION_CONTROL_NAME,
      WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME,
    ].includes(name));
  const expectedNames = [
    ...(liveSelected ? [LIVE_PERMISSION_CONTROL_NAME] : []),
    ...(sourceSelected ? [WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME] : []),
  ];
  assert.deepEqual(
    rows.map(({ name }) => name),
    expectedNames,
    "Windows owner diagnostic benchmark and control row set mismatch",
  );
  const mode = report.metadata?.mode;
  assert(["off", "require"].includes(mode), "Windows owner diagnostic native mode mismatch");
  const live = rows.find(({ name }) => name === LIVE_PERMISSION_CONTROL_NAME);
  if (live) {
    assert.equal(live.skipped, undefined, `${live.name} control must execute rather than skip`);
    if (configuredIterations !== undefined) {
      assert.equal(
        live.iterations,
        configuredIterations,
        "live permission control iteration count mismatch",
      );
    }
  }
  const source = rows.find(({ name }) => name === WINDOWS_OWNER_DIAGNOSTIC_BENCHMARK_NAME);
  if (source) validateWindowsOwnerDiagnosticWorkloadResult(source);
  if (source && configuredIterations !== undefined) {
    assert.equal(
      source.iterations,
      Math.max(1, Math.floor(configuredIterations / DIVISOR)),
      "Windows owner diagnostic iteration count mismatch",
    );
  }
}
