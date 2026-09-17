import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SYNC_LOCK_ROOT_BASE_SHA,
  SYNC_LOCK_ROOT_FILTER,
  SYNC_LOCK_ROOT_ROWS,
  SYNC_LOCK_ROOT_SCHEMA,
} from "./sync-lock-root-contract.mjs";

export {
  SYNC_LOCK_ROOT_BASE_SHA,
  SYNC_LOCK_ROOT_FILTER,
  SYNC_LOCK_ROOT_ROWS,
  SYNC_LOCK_ROOT_SCHEMA,
  validateSyncLockRootBenchmarkReport,
} from "./sync-lock-root-contract.mjs";
const RAW_HELD_KEY = Symbol.for("fsSafe.syncSidecarLocks");
const ROOT_HELD_KEY = Symbol.for("fsSafe.syncRootSidecarLocks.v1");
const PAYLOAD = Object.freeze({ owner: "benchmark" });
function heldMaps() {
  const globalState = globalThis;
  return {
    raw: Reflect.get(globalState, RAW_HELD_KEY),
    root: Reflect.get(globalState, ROOT_HELD_KEY),
  };
}
function heldEntries() {
  const maps = heldMaps();
  return [
    ...(maps.raw instanceof Map
      ? [...maps.raw.values()].map((held) => ({ domain: "raw", held })) : []),
    ...(maps.root instanceof Map
      ? [...maps.root.values()].map((held) => ({ domain: "root", held })) : []),
  ];
}
function assertNoHeldLocks(context) {
  assert.equal(heldEntries().length, 0, `${context}: synchronous held-lock map is not empty`);
}
function pinnedWorkerTempRoot(workspace) {
  if (process.env.SYNC_LOCK_ROOT_EXECUTION_SURFACE !== "wsl2-crabbox") return null;
  const selected = os.tmpdir();
  const realPath = fs.realpathSync.native(selected);
  const environment = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map((name) =>
    [name, process.env[name] ?? null]));
  assert.deepEqual(environment, { TMPDIR: realPath, TMP: realPath, TEMP: realPath },
    "worker inherited an unpinned temp environment");
  assert.equal(selected, realPath, "os.tmpdir() did not return the pinned real temp root");
  const stat = fs.statSync(realPath, { bigint: true });
  const statfs = fs.statfsSync(realPath, { bigint: true });
  const workspaceStat = fs.statSync(workspace, { bigint: true });
  const workspaceStatfs = fs.statfsSync(workspace, { bigint: true });
  assert.equal(path.dirname(workspace), realPath, "worker workspace did not use the pinned temp root");
  assert.equal(workspaceStat.dev, stat.dev, "worker workspace changed filesystem device");
  assert.equal(workspaceStatfs.type, statfs.type, "worker workspace changed filesystem type");
  const receipt = {
    path: selected,
    realPath,
    device: stat.dev.toString(),
    filesystemType: process.env.SYNC_LOCK_ROOT_WSL2_TEMP_FILESYSTEM_TYPE ?? null,
    statfsType: statfs.type.toString(),
    environment,
  };
  assert.equal(receipt.device, process.env.SYNC_LOCK_ROOT_WSL2_TEMP_DEVICE,
    "worker temp device differs from the remote admission");
  assert.equal(receipt.statfsType, process.env.SYNC_LOCK_ROOT_WSL2_TEMP_STATFS_TYPE,
    "worker temp filesystem type differs from the remote admission");
  assert.equal(typeof receipt.filesystemType, "string",
    "worker temp filesystem-name receipt is missing");
  return receipt;
}
function heldFor(handle) {
  const matches = heldEntries().filter(({ held }) =>
    held.normalizedTargetPath === handle.normalizedTargetPath);
  assert.equal(matches.length, 1, "benchmark handle does not have one exact held record");
  return matches[0];
}
function missing(candidate, context) {
  assert.equal(fs.existsSync(candidate), false, `${context}: retained ${path.basename(candidate)}`);
}
function cleanupPaths(fixture) {
  fs.rmSync(fixture.guardPath, { force: true, recursive: true });
  fs.rmSync(fixture.lockPath, { force: true });
  if (fixture.missingRoot) fs.rmSync(fixture.missingRoot, { force: true, recursive: true });
}

function assertBalanced(fixture, context) {
  assertNoHeldLocks(context);
  missing(fixture.lockPath, context);
  missing(fixture.guardPath, context);
}

function assertMissingParentSemantics(fixture, sourceCommit, context) {
  if (!fixture.missingParent) return null;
  const created = fs.existsSync(fixture.targetParent);
  assert.equal(created, sourceCommit === SYNC_LOCK_ROOT_BASE_SHA,
    `${context}: missing-parent behavior does not match the measured source`);
  return created;
}

function optionsFor(fixture, overrides = {}) {
  return {
    lockRoot: fixture.lockRoot,
    payload: () => PAYLOAD,
    retry: { retries: 0 },
    timeoutMs: 0,
    ...(fixture.explicit ? { lockPath: fixture.lockPath } : {}),
    ...overrides,
  };
}

async function createFixture(api, proofRoot, spec, index) {
  const directory = path.join(proofRoot, `row-${String(index).padStart(2, "0")}`);
  fs.mkdirSync(directory, { recursive: true });
  const missingParent = spec.details.layout === "deep-missing-16";
  const deep = spec.details.layout.startsWith("deep-");
  const segments = deep ? Array.from({ length: 16 }, (_, depth) => `d${depth}`) : [];
  const targetParent = path.join(directory, ...segments);
  const missingRoot = missingParent ? path.join(directory, segments[0]) : undefined;
  if (!missingParent) fs.mkdirSync(targetParent, { recursive: true });
  const targetPath = path.join(targetParent, "state.json");
  const explicit = spec.details.sidecar === "explicit";
  const lockPath = explicit
    ? path.join(missingParent ? directory : targetParent, "sidecar.lock")
    : `${targetPath}.lock`;
  const callbackState = { mutationAssertions: 0, parserCalls: 0 };
  const defaults = spec.details.authority === "root" ? {
    ...(spec.details.policySize > 0 ? {
      denyMutations: {
        paths: Array.from({ length: spec.details.policySize }, (_, entry) =>
          path.join(directory, "unrelated-policy", `entry-${entry}`)),
      },
    } : {}),
    ...(spec.details.mutationAssertion === "noop" ? {
      assertBeforeMutation: () => { callbackState.mutationAssertions += 1; },
    } : {}),
  } : undefined;
  const lockRoot = defaults === undefined ? undefined : await api.root(directory, defaults);
  return {
    actualPolicySize: defaults?.denyMutations?.paths?.length ?? 0,
    callbackState,
    depth: segments.length,
    directory,
    explicit,
    guardPath: `${lockPath}.reclaim`,
    lockPath,
    lockRoot,
    missingParent,
    missingRoot,
    spec,
    targetParent,
    targetPath,
  };
}

function releaseQuietly(handle) {
  if (!handle) return;
  try { handle.release(); } catch { /* The primary benchmark assertion remains authoritative. */ }
}

function preflightFixture(api, fixture, sourceCommit) {
  cleanupPaths(fixture);
  if (!fixture.missingParent) fs.mkdirSync(fixture.targetParent, { recursive: true });
  const monitored = fixture.spec.details.monitor === "armed";
  const handle = api.acquireFileLockSync(fixture.targetPath, optionsFor(fixture, monitored ? {
    compromiseCheckIntervalMs: 60_000,
    onCompromised: () => {},
  } : {}));
  let heldRecord;
  try {
    const observed = heldFor(handle);
    heldRecord = observed.held;
    assert.equal(typeof observed.held.fd, "number", "preflight did not retain an owned descriptor");
    assert.equal(observed.held.refCount, 1, "preflight held-reference count mismatch");
    assert.equal(Boolean(observed.held.timer), monitored, "preflight timer ownership mismatch");
    return {
      domain: observed.domain,
      fdObserved: true,
      missingParentCreated: assertMissingParentSemantics(
        fixture, sourceCommit, "preflight",
      ),
      mutationAssertions: fixture.callbackState.mutationAssertions,
      timerObserved: Boolean(observed.held.timer),
    };
  } finally {
    handle.release();
    assert.equal(heldRecord?.fd, undefined, "preflight release retained descriptor ownership");
    assert.equal(heldRecord?.timer, undefined, "preflight release retained timer ownership");
    assertBalanced(fixture, "preflight");
    cleanupPaths(fixture);
    fixture.callbackState.mutationAssertions = 0;
  }
}

export function registerCase(context, proof, fixture, hooks) {
  const spec = fixture.spec;
  const observation = proof.observations[spec.name];
  context.register(spec.name, hooks.run, {
    sync: true,
    divisor: spec.divisor,
    workloadDetails: spec.details,
    before: () => {
      assertNoHeldLocks(`${spec.name} before`);
      cleanupPaths(fixture);
      if (!fixture.missingParent) fs.mkdirSync(fixture.targetParent, { recursive: true });
      return hooks.before?.() ?? {};
    },
    after: (output, input) => {
      let didFail = false;
      let failure;
      try {
        hooks.after(output, input);
        assertMissingParentSemantics(fixture, proof.sourceCommit, `${spec.name} after`);
        assertBalanced(fixture, `${spec.name} after`);
      } catch (error) {
        didFail = true;
        failure = error;
      } finally {
        releaseQuietly(input?.nested);
        releaseQuietly(input?.handle);
        cleanupPaths(fixture);
      }
      if (didFail) throw failure;
      observation.invocations += 1;
      observation.mutationAssertions += fixture.callbackState.mutationAssertions;
      fixture.callbackState.mutationAssertions = 0;
    },
  });
}

function registerAcquireRelease(context, proof, fixture, overrides = {}) {
  registerCase(context, proof, fixture, {
    before: () => ({ handle: undefined }),
    run: (input) => {
      input.handle = context.api.acquireFileLockSync(
        fixture.targetPath,
        optionsFor(fixture, overrides),
      );
      input.handle.release();
      input.handle = undefined;
      return true;
    },
    after: (output) => assert.equal(output, true),
  });
}

function registerStaleReclaim(context, proof, fixture) {
  const staleRaw = `${JSON.stringify({ createdAt: "1970-01-01T00:00:00.000Z", owner: "stale" })}\n`;
  registerCase(context, proof, fixture, {
    before: () => {
      fs.writeFileSync(fixture.lockPath, staleRaw, { mode: 0o600 });
      fs.utimesSync(fixture.lockPath, new Date(0), new Date(0));
      return { handle: undefined };
    },
    run: (input) => {
      input.handle = context.api.acquireFileLockSync(fixture.targetPath, optionsFor(fixture, {
        shouldReclaim: () => true,
        shouldRemoveStaleLock: () => true,
        staleMs: 1,
        staleRecovery: "remove-if-unchanged",
      }));
      input.handle.release();
      input.handle = undefined;
      return true;
    },
    after: (output) => assert.equal(output, true),
  });
}

function registerVerify(context, proof, fixture, customParser) {
  registerCase(context, proof, fixture, {
    before: () => {
      const parser = customParser ? (raw) => {
        fixture.callbackState.parserCalls += 1;
        return JSON.parse(raw);
      } : undefined;
      const handle = context.api.acquireFileLockSync(
        fixture.targetPath,
        optionsFor(fixture, parser ? { parsePayload: parser } : {}),
      );
      fixture.callbackState.parserCalls = 0;
      return { handle };
    },
    run: (input) => input.handle.verifyStillHeld(),
    after: (output, input) => {
      assert.equal(output, true);
      if (customParser) assert.equal(fixture.callbackState.parserCalls, 1);
      input.handle.release();
      input.handle = undefined;
    },
  });
}

function registerReentrantAcquire(context, proof, fixture) {
  const reentrantOwner = "same-owner";
  registerCase(context, proof, fixture, {
    before: () => ({
      handle: context.api.acquireFileLockSync(
        fixture.targetPath,
        optionsFor(fixture, { reentrantOwner }),
      ),
      nested: undefined,
    }),
    run: (input) => {
      input.nested = context.api.acquireFileLockSync(
        fixture.targetPath,
        optionsFor(fixture, { reentrantOwner }),
      );
      return input.nested;
    },
    after: (output, input) => {
      assert.equal(output, input.nested);
      assert.equal(heldFor(input.handle).held.refCount, 2);
      input.nested.release();
      input.nested = undefined;
      input.handle.release();
      input.handle = undefined;
    },
  });
}

function registerRelease(context, proof, fixture, nonfinal, monitored = false) {
  const reentrantOwner = "same-owner";
  registerCase(context, proof, fixture, {
    before: () => {
      const options = optionsFor(fixture, {
        ...(nonfinal ? { reentrantOwner } : {}),
        ...(monitored ? {
          compromiseCheckIntervalMs: 60_000,
          onCompromised: () => {},
        } : {}),
      });
      const handle = context.api.acquireFileLockSync(fixture.targetPath, options);
      const nested = nonfinal
        ? context.api.acquireFileLockSync(fixture.targetPath, options)
        : undefined;
      const held = heldFor(handle).held;
      assert.equal(held.refCount, nonfinal ? 2 : 1);
      assert.equal(Boolean(held.timer), monitored);
      return { handle, nested, record: held };
    },
    run: (input) => {
      const selected = nonfinal ? input.nested : input.handle;
      selected.release();
      if (nonfinal) input.nested = undefined;
      else input.handle = undefined;
      return true;
    },
    after: (output, input) => {
      assert.equal(output, true);
      if (nonfinal) {
        const held = heldFor(input.handle).held;
        assert.equal(held.refCount, 1);
        assert.equal(typeof held.fd, "number");
        input.handle.release();
        input.handle = undefined;
      }
      assert.equal(input.record.fd, undefined, "final release retained descriptor ownership");
      assert.equal(input.record.timer, undefined, "final release retained timer ownership");
    },
  });
}

function registerCompromisedVerify(context, proof, fixture) {
  registerCase(context, proof, fixture, {
    before: () => {
      const handle = context.api.acquireFileLockSync(fixture.targetPath, optionsFor(fixture));
      const original = fs.readFileSync(fixture.lockPath);
      fs.writeFileSync(fixture.lockPath, `${JSON.stringify({ owner: "replacement" })}\n`);
      return { handle, original };
    },
    run: (input) => input.handle.verifyStillHeld(),
    after: (output, input) => {
      assert.equal(output, false);
      fs.writeFileSync(fixture.lockPath, input.original);
      assert.equal(input.handle.verifyStillHeld(), true);
      input.handle.release();
      input.handle = undefined;
    },
  });
}

export async function registerSyncLockRoot(context) {
  assert.equal(context.args.filter, SYNC_LOCK_ROOT_FILTER,
    `dedicated sync lockRoot worker requires --filter ${SYNC_LOCK_ROOT_FILTER}`);
  assertNoHeldLocks("worker startup");
  const proofRoot = path.join(context.workspace, "sync-lock-root-proof");
  fs.mkdirSync(proofRoot);
  const proof = {
    schema: SYNC_LOCK_ROOT_SCHEMA,
    processId: process.pid,
    processToken: randomUUID(),
    configuredIterations: context.args.iterations,
    configuredSamples: context.args.samples,
    configuredWarmup: context.args.warmup,
    sourceCommit: context.measuredSource?.sourceCommit ?? null,
    tempRoot: pinnedWorkerTempRoot(context.workspace),
    fixtureReceipts: {},
    observations: {},
  };
  const fixtures = [];
  for (const [index, spec] of SYNC_LOCK_ROOT_ROWS.entries()) {
    const fixture = await createFixture(context.api, proofRoot, spec, index);
    fixtures.push(fixture);
    const preflight = preflightFixture(context.api, fixture, proof.sourceCommit);
    proof.fixtureReceipts[spec.name] = {
      ...preflight,
      depth: fixture.depth,
      layout: spec.details.layout,
      lockPathRelative: path.relative(fixture.directory, fixture.lockPath),
      policySize: fixture.actualPolicySize,
      rootCanonical: fixture.lockRoot ? fixture.lockRoot.rootReal === fs.realpathSync.native(fixture.directory) : null,
      sidecar: spec.details.sidecar,
    };
    proof.observations[spec.name] = { invocations: 0, mutationAssertions: 0 };
    if (spec.details.lifecycle === "create-release") {
      registerAcquireRelease(context, proof, fixture);
    } else if (spec.details.lifecycle === "stale-reclaim") {
      registerStaleReclaim(context, proof, fixture);
    } else if (spec.details.lifecycle === "verify") {
      registerVerify(context, proof, fixture, spec.details.parser === "custom");
    } else if (spec.details.lifecycle === "reentrant-acquire") {
      registerReentrantAcquire(context, proof, fixture);
    } else if (spec.details.lifecycle === "release-nonfinal") {
      registerRelease(context, proof, fixture, true);
    } else if (spec.details.lifecycle === "release-final") {
      registerRelease(context, proof, fixture, false, spec.details.monitor === "armed");
    } else if (spec.details.lifecycle === "verify-compromised") {
      registerCompromisedVerify(context, proof, fixture);
    } else {
      assert.fail(`unsupported sync lockRoot lifecycle: ${spec.details.lifecycle}`);
    }
  }
  context.onCleanup(() => {
    assertNoHeldLocks("worker cleanup");
    for (const fixture of fixtures) {
      assertBalanced(fixture, "worker cleanup");
      if (fixture.missingRoot) missing(fixture.missingRoot, "worker cleanup");
    }
  });
  return proof;
}
