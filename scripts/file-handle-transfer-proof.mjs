import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GATE_TIMEOUT_MS = 5_000;
const DRAIN_TIMEOUT_MS = 10_000;
const FIXTURE_OPERATION_TIMEOUT_MS = 10_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 5_000;
const RECEIPT_IO_TIMEOUT_MS = 5_000;
const SCENARIO_TIMEOUT_MS = 30_000;
const RECEIPT_MAX_BYTES = 32 * 1024;
const PARTIAL_WRITE_CAP = 257;
const SOURCE_BYTES = 64 * 1024 + 37;

class ProofFailure extends Error {
  constructor(proofCode) {
    super("proof invariant failed");
    this.proofCode = proofCode;
  }
}

function requireInvariant(condition, proofCode) {
  if (!condition) throw new ProofFailure(proofCode);
}

function safeCode(value) {
  return typeof value === "string" &&
    /^(?:[A-Z][A-Z0-9_]{0,31}|[a-z][a-z0-9-]{0,31})$/u.test(value)
    ? value
    : undefined;
}

// Deliberately excludes exception names, text, stacks, filesystem locations,
// descriptor numbers, machine identities, and arbitrary thrown properties.
export function sanitizeProofFailure(error) {
  const result = {
    kind: error instanceof ProofFailure
      ? "proof"
      : error instanceof Error
        ? "error"
        : "non-error",
  };
  const code = error instanceof ProofFailure
    ? error.proofCode
    : error && (typeof error === "object" || typeof error === "function")
      ? error.code
      : undefined;
  const sanitizedCode = safeCode(code);
  if (sanitizedCode !== undefined) result.code = sanitizedCode;
  return result;
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => entry === undefined ? null : canonicalValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
    }
    return result;
  }
  if (typeof value === "number") {
    requireInvariant(Number.isFinite(value), "receipt-nonfinite-number");
  }
  requireInvariant(typeof value !== "bigint", "receipt-bigint");
  return value;
}

export function canonicalReceipt(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function bounded(promise, timeoutMs, proofCode) {
  let deadline;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new ProofFailure(proofCode)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

export function observeSettlement(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ error, status: "rejected" }),
  );
}

async function waitForGateOrSettlement(gate, settlement, timeoutMs, proofCode) {
  const winner = await bounded(Promise.race([
    gate.then(
      () => ({ kind: "gate" }),
      (error) => ({ error, kind: "gate-rejected" }),
    ),
    settlement.then((result) => ({ kind: "settlement", result })),
  ]), timeoutMs, proofCode);
  if (winner.kind === "gate-rejected") throw winner.error;
  if (winner.kind === "settlement") {
    if (winner.result.status === "rejected") throw winner.result.error;
    throw new ProofFailure("transfer-settled-before-gate");
  }
  return winner;
}

export async function earlyRejectionContractReceipt(transfer) {
  const neverGate = new Promise(() => undefined);
  const settlement = observeSettlement(transfer);
  try {
    await waitForGateOrSettlement(
      neverGate,
      settlement,
      GATE_TIMEOUT_MS,
      "contract-early-rejection-timeout",
    );
    throw new ProofFailure("contract-early-rejection-missed");
  } catch (caught) {
    return canonicalReceipt({
      failure: sanitizeProofFailure(caught),
      passed: false,
      schema: "fs-safe-file-handle-transfer-proof-contract-v1",
      status: "failed",
    });
  }
}

export async function timeoutContractReceipt(timeoutMs = 1) {
  try {
    await bounded(new Promise(() => undefined), timeoutMs, "contract-timeout");
    throw new ProofFailure("contract-timeout-missed");
  } catch (error) {
    return canonicalReceipt({
      failure: sanitizeProofFailure(error),
      passed: false,
      schema: "fs-safe-file-handle-transfer-proof-contract-v1",
      status: "failed",
    });
  }
}

async function boundedCleanup(operation, timeoutMs, proofCode) {
  try {
    await bounded(Promise.resolve().then(operation), timeoutMs, proofCode);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deterministicBytes(seed, length) {
  const bytes = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (seed + index * 29 + Math.floor(index / 251)) % 251;
  }
  return bytes;
}

function replaceInstanceMethod(instance, name, implementation) {
  const prior = Object.getOwnPropertyDescriptor(instance, name);
  Object.defineProperty(instance, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: implementation,
  });
  return () => {
    if (prior === undefined) delete instance[name];
    else Object.defineProperty(instance, name, prior);
  };
}

function identityEvidence(sourceStat, targetStat) {
  return {
    distinct: sourceStat.dev !== targetStat.dev || sourceStat.ino !== targetStat.ino,
    sameDevice: sourceStat.dev === targetStat.dev,
    sourceRegular: sourceStat.isFile(),
    targetRegular: targetStat.isFile(),
  };
}

async function inspectFixture(fixture, scenarioName) {
  const sourceStat = await bounded(
    fixture.source.stat({ bigint: true }),
    FIXTURE_OPERATION_TIMEOUT_MS,
    `${scenarioName}-source-inspection-timeout`,
  );
  const targetStat = await bounded(
    fixture.target.stat({ bigint: true }),
    FIXTURE_OPERATION_TIMEOUT_MS,
    `${scenarioName}-target-inspection-timeout`,
  );
  const evidence = identityEvidence(sourceStat, targetStat);
  requireInvariant(evidence.sourceRegular, "source-not-regular");
  requireInvariant(evidence.targetRegular, "target-not-regular");
  requireInvariant(evidence.distinct, "descriptors-not-distinct");
  return { sourceStat, targetStat, evidence };
}

async function postOperationEvidence(fixture, initial) {
  const sourceStat = await bounded(
    fixture.source.stat({ bigint: true }),
    FIXTURE_OPERATION_TIMEOUT_MS,
    "post-source-inspection-timeout",
  );
  const targetStat = await bounded(
    fixture.target.stat({ bigint: true }),
    FIXTURE_OPERATION_TIMEOUT_MS,
    "post-target-inspection-timeout",
  );
  const sourceProbe = Buffer.alloc(1);
  const targetProbe = Buffer.alloc(1);
  const sourceRead = await bounded(
    fixture.source.read(sourceProbe, 0, 1, 0),
    FIXTURE_OPERATION_TIMEOUT_MS,
    "post-source-read-timeout",
  );
  const targetRead = await bounded(
    fixture.target.read(targetProbe, 0, 1, 0),
    FIXTURE_OPERATION_TIMEOUT_MS,
    "post-target-read-timeout",
  );
  const identitiesStable =
    sourceStat.dev === initial.sourceStat.dev &&
    sourceStat.ino === initial.sourceStat.ino &&
    targetStat.dev === initial.targetStat.dev &&
    targetStat.ino === initial.targetStat.ino;
  requireInvariant(identitiesStable, "descriptor-identity-changed");
  requireInvariant(sourceRead.bytesRead === 1, "source-handle-unusable");
  requireInvariant(targetRead.bytesRead === 1, "target-handle-unusable");
  return {
    identitiesStable,
    sourceReadable: sourceRead.bytesRead === 1,
    targetReadable: targetRead.bytesRead === 1,
  };
}

async function byteEvidence(fixture, expectedTarget) {
  const actualSource = await bounded(
    fs.readFile(fixture.sourcePath),
    FIXTURE_OPERATION_TIMEOUT_MS,
    "source-byte-read-timeout",
  );
  const actualTarget = await bounded(
    fs.readFile(fixture.targetPath),
    FIXTURE_OPERATION_TIMEOUT_MS,
    "target-byte-read-timeout",
  );
  const sourceMatches = actualSource.equals(fixture.sourceBytes);
  const targetMatches = actualTarget.equals(expectedTarget);
  requireInvariant(sourceMatches, "source-bytes-changed");
  requireInvariant(targetMatches, "target-bytes-mismatch");
  return {
    destination: {
      actualSha256: sha256(actualTarget),
      actualBytes: actualTarget.byteLength,
      expectedBytes: expectedTarget.byteLength,
      expectedSha256: sha256(expectedTarget),
      matches: targetMatches,
    },
    source: {
      actualSha256: sha256(actualSource),
      actualBytes: actualSource.byteLength,
      expectedBytes: fixture.sourceBytes.byteLength,
      expectedSha256: sha256(fixture.sourceBytes),
      matches: sourceMatches,
    },
  };
}

async function makeFixture(seed) {
  const directory = await bounded(
    fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-transfer-proof-")),
    FIXTURE_OPERATION_TIMEOUT_MS,
    "fixture-directory-timeout",
  );
  const sourcePath = path.join(directory, "source");
  const targetPath = path.join(directory, "target");
  const sourceBytes = deterministicBytes(seed, SOURCE_BYTES);
  const priorTarget = deterministicBytes(seed + 41, SOURCE_BYTES + 19);
  let source;
  let target;
  try {
    await bounded(
      fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 }),
      FIXTURE_OPERATION_TIMEOUT_MS,
      "fixture-source-write-timeout",
    );
    await bounded(
      fs.writeFile(targetPath, priorTarget, { mode: 0o600 }),
      FIXTURE_OPERATION_TIMEOUT_MS,
      "fixture-target-write-timeout",
    );
    source = await bounded(
      fs.open(sourcePath, "r"),
      FIXTURE_OPERATION_TIMEOUT_MS,
      "fixture-source-open-timeout",
    );
    target = await bounded(
      fs.open(targetPath, "r+"),
      FIXTURE_OPERATION_TIMEOUT_MS,
      "fixture-target-open-timeout",
    );
    return {
      directory, priorTarget, source, sourceBytes, sourcePath, target, targetPath,
    };
  } catch (error) {
    if (target !== undefined) {
      await boundedCleanup(
        () => target.close(),
        CLEANUP_OPERATION_TIMEOUT_MS,
        "fixture-target-close-timeout",
      );
    }
    if (source !== undefined) {
      await boundedCleanup(
        () => source.close(),
        CLEANUP_OPERATION_TIMEOUT_MS,
        "fixture-source-close-timeout",
      );
    }
    await boundedCleanup(
      () => fs.rm(directory, { force: true, recursive: true }),
      CLEANUP_OPERATION_TIMEOUT_MS,
      "fixture-removal-timeout",
    );
    throw error;
  }
}

async function runScenario(receipt, name, seed, body) {
  const state = {
    cleanup: {
      directoryRemovalAttempted: false,
      directoryRemoved: false,
      handleClosesAttempted: 0,
      handleClosesCompleted: 0,
    },
    name,
    passed: false,
  };
  receipt.scenarios.push(state);
  let fixture;
  let failure;
  try {
    fixture = await makeFixture(seed);
    const initial = await inspectFixture(fixture, name);
    const outcome = await bounded(
      body(fixture, initial),
      SCENARIO_TIMEOUT_MS,
      `${name}-timeout`,
    );
    Object.assign(state, outcome);
    state.passed = true;
  } catch (error) {
    failure = error;
    state.failure = sanitizeProofFailure(error);
  } finally {
    if (fixture !== undefined) {
      for (const handle of [fixture.target, fixture.source]) {
        state.cleanup.handleClosesAttempted += 1;
        const closed = await boundedCleanup(
          () => handle.close(),
          CLEANUP_OPERATION_TIMEOUT_MS,
          `${name}-handle-close-timeout`,
        );
        if (closed) {
          state.cleanup.handleClosesCompleted += 1;
        } else {
          state.cleanup.handleCloseFailed = true;
        }
      }
      state.cleanup.directoryRemovalAttempted = true;
      const removed = await boundedCleanup(
        () => fs.rm(fixture.directory, { force: true, recursive: true }),
        CLEANUP_OPERATION_TIMEOUT_MS,
        `${name}-directory-removal-timeout`,
      );
      if (removed) {
        state.cleanup.directoryRemoved = true;
      } else {
        state.cleanup.directoryRemovalFailed = true;
      }
      const cleanupPassed =
        state.cleanup.handleClosesCompleted === state.cleanup.handleClosesAttempted &&
        state.cleanup.directoryRemoved;
      if (!cleanupPassed && failure === undefined) {
        failure = new ProofFailure(`${name}-cleanup-failed`);
        state.failure = sanitizeProofFailure(failure);
        state.passed = false;
      }
    }
  }
  if (failure !== undefined) throw failure;
  return state;
}

async function stableReplacementScenario(copyFileHandle, fixture, initial) {
  const statGate = deferred();
  const statRelease = deferred();
  const statCounts = {
    completions: 0,
    delegations: 0,
    heldResults: 0,
    peakHeldResults: 0,
    submissions: 0,
  };
  const genuineStat = fixture.source.stat.bind(fixture.source);
  const restoreStat = replaceInstanceMethod(fixture.source, "stat", async (...args) => {
    statCounts.submissions += 1;
    const pending = genuineStat(...args);
    statCounts.delegations += 1;
    const result = await pending;
    statCounts.completions += 1;
    statCounts.heldResults += 1;
    statCounts.peakHeldResults = Math.max(statCounts.peakHeldResults, statCounts.heldResults);
    statGate.resolve();
    await statRelease.promise;
    statCounts.heldResults -= 1;
    return result;
  });
  const selectedController = new AbortController();
  const replacementController = new AbortController();
  const replacementReason = Object.freeze({ proof: "replacement-signal" });
  const getterReads = { assertBeforeMutation: 0, maxBytes: 0, onChunk: 0, signal: 0 };
  const callbacks = {
    originalAuthority: 0,
    originalObserver: 0,
    originalObservedBytes: 0,
    replacementAuthority: 0,
    replacementObserver: 0,
  };
  const originalObserver = (chunk) => {
    callbacks.originalObserver += 1;
    callbacks.originalObservedBytes += chunk.byteLength;
  };
  const originalAuthority = () => { callbacks.originalAuthority += 1; };
  const replacementObserver = () => {
    callbacks.replacementObserver += 1;
    throw new ProofFailure("replacement-observer-used");
  };
  const replacementAuthority = () => {
    callbacks.replacementAuthority += 1;
    throw new ProofFailure("replacement-authority-used");
  };
  let selectedSignal = selectedController.signal;
  let selectedMaxBytes = fixture.sourceBytes.byteLength;
  let selectedObserver = originalObserver;
  let selectedAuthority = originalAuthority;
  const options = Object.defineProperties({}, {
    assertBeforeMutation: {
      configurable: true,
      enumerable: true,
      get() { getterReads.assertBeforeMutation += 1; return selectedAuthority; },
    },
    maxBytes: {
      configurable: true,
      enumerable: true,
      get() { getterReads.maxBytes += 1; return selectedMaxBytes; },
    },
    onChunk: {
      configurable: true,
      enumerable: true,
      get() { getterReads.onChunk += 1; return selectedObserver; },
    },
    signal: {
      configurable: true,
      enumerable: true,
      get() { getterReads.signal += 1; return selectedSignal; },
    },
  });
  let copiedBytes;
  let settlement;
  try {
    // Attach both fulfillment and rejection handlers in the same turn as the
    // transfer call. The observed promise never rejects, including when stat
    // fails before the gate can be reached.
    settlement = observeSettlement(copyFileHandle(fixture.source, fixture.target, options));
    await waitForGateOrSettlement(
      statGate.promise,
      settlement,
      GATE_TIMEOUT_MS,
      "stable-stat-gate-timeout",
    );
    requireInvariant(statCounts.completions === 1, "stable-stat-not-completed");
    requireInvariant(statCounts.heldResults === 1, "stable-stat-result-not-held");
    selectedSignal = replacementController.signal;
    selectedMaxBytes = 0;
    selectedObserver = replacementObserver;
    selectedAuthority = replacementAuthority;
    replacementController.abort(replacementReason);
    statRelease.resolve();
    const completed = await bounded(
      settlement,
      DRAIN_TIMEOUT_MS,
      "stable-transfer-settlement-timeout",
    );
    if (completed.status === "rejected") throw completed.error;
    copiedBytes = completed.value;
  } finally {
    statRelease.resolve();
    let drainFailure;
    if (settlement !== undefined) {
      try {
        await bounded(settlement, DRAIN_TIMEOUT_MS, "stable-transfer-drain-timeout");
      } catch (error) {
        drainFailure = error;
      }
    }
    restoreStat();
    if (drainFailure !== undefined) throw drainFailure;
  }
  requireInvariant(copiedBytes === fixture.sourceBytes.byteLength, "stable-byte-count");
  requireInvariant(statCounts.submissions === 1, "stable-stat-submission-count");
  requireInvariant(statCounts.delegations === 1, "stable-stat-delegation-count");
  requireInvariant(statCounts.completions === 1, "stable-stat-completion-count");
  requireInvariant(statCounts.heldResults === 0, "stable-stat-result-not-released");
  requireInvariant(statCounts.peakHeldResults === 1, "stable-stat-result-not-observed");
  requireInvariant(
    Object.values(getterReads).every((count) => count === 1),
    "stable-options-reread",
  );
  requireInvariant(callbacks.originalObserver > 0, "stable-observer-unused");
  requireInvariant(callbacks.originalAuthority > 0, "stable-authority-unused");
  requireInvariant(callbacks.originalObservedBytes === copiedBytes, "stable-observer-byte-count");
  requireInvariant(callbacks.replacementObserver === 0, "stable-replacement-observer-used");
  requireInvariant(callbacks.replacementAuthority === 0, "stable-replacement-authority-used");
  requireInvariant(!selectedController.signal.aborted, "stable-original-signal-aborted");
  requireInvariant(replacementController.signal.aborted, "stable-replacement-signal-live");
  const expectedTarget = Buffer.concat([
    fixture.sourceBytes,
    fixture.priorTarget.subarray(fixture.sourceBytes.byteLength),
  ]);
  return {
    bytes: await byteEvidence(fixture, expectedTarget),
    callbacks,
    descriptors: {
      initial: initial.evidence,
      postOperation: await postOperationEvidence(fixture, initial),
    },
    getterReads,
    instrumentation: {
      sourceStat: {
        ...statCounts,
        delegateTiming: "before-first-await",
        holdTiming: "after-genuine-completion",
        scope: "source-instance-only",
      },
    },
    policy: {
      copiedBytes,
      originalSignalAborted: selectedController.signal.aborted,
      replacementSignalAborted: replacementController.signal.aborted,
      replacementsInstalled: {
        assertBeforeMutation: true,
        maxBytes: true,
        onChunk: true,
        signal: true,
      },
      replacementsInstalledWhileRealStatHeld: true,
    },
  };
}

function installCappedWrite(fixture, afterCompletion) {
  const counts = {
    completions: 0,
    delegatedBytes: 0,
    delegations: 0,
    firstBytesWritten: 0,
    requestedBytes: 0,
    submissions: 0,
  };
  const genuineWrite = fixture.target.write.bind(fixture.target);
  const restore = replaceInstanceMethod(
    fixture.target,
    "write",
    async (buffer, offset, length, position) => {
      counts.submissions += 1;
      counts.requestedBytes += length;
      const delegatedLength = Math.min(length, PARTIAL_WRITE_CAP);
      counts.delegatedBytes += delegatedLength;
      const pending = genuineWrite(buffer, offset, delegatedLength, position);
      counts.delegations += 1;
      const result = await pending;
      counts.completions += 1;
      if (counts.completions === 1) counts.firstBytesWritten = result.bytesWritten;
      afterCompletion(result.bytesWritten);
      return result;
    },
  );
  return { counts, restore };
}

async function selectedSignalScenario(copyFileHandle, fixture, initial) {
  const selectedController = new AbortController();
  const replacementController = new AbortController();
  const rejection = Object.freeze({ proof: "selected-original-signal" });
  let selectedSignal = selectedController.signal;
  let signalGetterReads = 0;
  const options = Object.defineProperties({ maxBytes: fixture.sourceBytes.byteLength }, {
    signal: {
      configurable: true,
      enumerable: true,
      get() { signalGetterReads += 1; return selectedSignal; },
    },
  });
  const write = installCappedWrite(fixture, () => selectedController.abort(rejection));
  let caught;
  try {
    const pending = copyFileHandle(fixture.source, fixture.target, options);
    selectedSignal = replacementController.signal;
    try {
      await pending;
      throw new ProofFailure("selected-signal-transfer-resolved");
    } catch (error) {
      caught = error;
    }
  } finally {
    write.restore();
  }
  requireInvariant(caught === rejection, "selected-signal-rejection-mismatch");
  requireInvariant(signalGetterReads === 1, "selected-signal-reread");
  requireInvariant(selectedController.signal.aborted, "selected-signal-not-aborted");
  requireInvariant(!replacementController.signal.aborted, "replacement-signal-aborted");
  requireInvariant(write.counts.submissions === 1, "selected-signal-later-write-submitted");
  requireInvariant(write.counts.delegations === 1, "selected-signal-delegation-count");
  requireInvariant(write.counts.completions === 1, "selected-signal-completion-count");
  requireInvariant(write.counts.firstBytesWritten > 0, "selected-signal-no-progress");
  requireInvariant(
    write.counts.firstBytesWritten <= PARTIAL_WRITE_CAP,
    "selected-signal-cap-exceeded",
  );
  const expectedTarget = Buffer.from(fixture.priorTarget);
  fixture.sourceBytes.copy(expectedTarget, 0, 0, write.counts.firstBytesWritten);
  return {
    bytes: await byteEvidence(fixture, expectedTarget),
    descriptors: {
      initial: initial.evidence,
      postOperation: await postOperationEvidence(fixture, initial),
    },
    instrumentation: {
      targetWrite: {
        ...write.counts,
        capBytes: PARTIAL_WRITE_CAP,
        delegateTiming: "before-first-await",
        scope: "target-instance-only",
      },
    },
    policy: {
      matchedSelectedReason: caught === rejection,
      originalSignalAborted: selectedController.signal.aborted,
      replacementSignalAborted: replacementController.signal.aborted,
      signalGetterReads,
      writesAfterCancellation: write.counts.submissions - 1,
    },
  };
}

async function currentAuthorityScenario(copyFileHandle, fixture, initial) {
  const rejection = Object.freeze({ proof: "current-original-authority" });
  let authorized = true;
  let authorityGetterReads = 0;
  const callbacks = { originalAuthority: 0, replacementAuthority: 0 };
  const originalAuthority = () => {
    callbacks.originalAuthority += 1;
    if (!authorized) throw rejection;
  };
  const replacementAuthority = () => { callbacks.replacementAuthority += 1; };
  let selectedAuthority = originalAuthority;
  const options = Object.defineProperties({ maxBytes: fixture.sourceBytes.byteLength }, {
    assertBeforeMutation: {
      configurable: true,
      enumerable: true,
      get() { authorityGetterReads += 1; return selectedAuthority; },
    },
  });
  const write = installCappedWrite(fixture, () => { authorized = false; });
  let caught;
  try {
    const pending = copyFileHandle(fixture.source, fixture.target, options);
    selectedAuthority = replacementAuthority;
    try {
      await pending;
      throw new ProofFailure("current-authority-transfer-resolved");
    } catch (error) {
      caught = error;
    }
  } finally {
    write.restore();
  }
  requireInvariant(caught === rejection, "current-authority-rejection-mismatch");
  requireInvariant(authorityGetterReads === 1, "current-authority-reread");
  requireInvariant(callbacks.originalAuthority === 2, "current-authority-call-count");
  requireInvariant(callbacks.replacementAuthority === 0, "replacement-authority-used");
  requireInvariant(write.counts.submissions === 1, "current-authority-later-write-submitted");
  requireInvariant(write.counts.delegations === 1, "current-authority-delegation-count");
  requireInvariant(write.counts.completions === 1, "current-authority-completion-count");
  requireInvariant(write.counts.firstBytesWritten > 0, "current-authority-no-progress");
  requireInvariant(
    write.counts.firstBytesWritten <= PARTIAL_WRITE_CAP,
    "current-authority-cap-exceeded",
  );
  const expectedTarget = Buffer.from(fixture.priorTarget);
  fixture.sourceBytes.copy(expectedTarget, 0, 0, write.counts.firstBytesWritten);
  return {
    bytes: await byteEvidence(fixture, expectedTarget),
    callbacks,
    descriptors: {
      initial: initial.evidence,
      postOperation: await postOperationEvidence(fixture, initial),
    },
    instrumentation: {
      targetWrite: {
        ...write.counts,
        capBytes: PARTIAL_WRITE_CAP,
        delegateTiming: "before-first-await",
        scope: "target-instance-only",
      },
    },
    policy: {
      authorityGetterReads,
      matchedSelectedReason: caught === rejection,
      writesAfterRejection: write.counts.submissions - 1,
    },
  };
}

function gitText(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
  }).trim();
}

function validatedCommit(value, proofCode) {
  requireInvariant(typeof value === "string" && /^[0-9a-f]{40}$/u.test(value), proofCode);
  return value;
}

export function validatePullRequestMergeBinding({
  baseCommit: rawBaseCommit,
  checkoutCommit: rawCheckoutCommit,
  eventSha: rawEventSha,
  headCommit: rawHeadCommit,
  parentCommits: rawParentCommits,
}) {
  const baseCommit = validatedCommit(rawBaseCommit, "invalid-pr-base");
  const checkoutCommit = validatedCommit(rawCheckoutCommit, "invalid-checkout-commit");
  const eventSha = validatedCommit(rawEventSha, "invalid-event-sha");
  const headCommit = validatedCommit(rawHeadCommit, "invalid-pr-head");
  requireInvariant(Array.isArray(rawParentCommits), "invalid-parent-list");
  requireInvariant(rawParentCommits.length === 2, "invalid-pr-parent-count");
  const parentCommits = rawParentCommits.map(parent =>
    validatedCommit(parent, "invalid-pr-parent"));
  requireInvariant(checkoutCommit === eventSha, "checkout-event-commit-mismatch");
  requireInvariant(parentCommits[0] === baseCommit, "checkout-pr-base-parent-mismatch");
  requireInvariant(parentCommits[1] === headCommit, "checkout-pr-head-parent-mismatch");
  return Object.freeze({
    baseCommit,
    checkoutCommit,
    headCommit,
    mergeCommit: eventSha,
    parentCommits: Object.freeze(parentCommits),
  });
}

function gitTree(commit) {
  return validatedCommit(gitText(["rev-parse", `${commit}^{tree}`]), "invalid-tree");
}

async function sourceMetadata() {
  const commit = validatedCommit(gitText(["rev-parse", "HEAD"]), "invalid-checkout-commit");
  const tree = gitTree(commit);
  const dirty = gitText(["status", "--porcelain"]) !== "";
  const parentLine = gitText(["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/u);
  requireInvariant(parentLine[0] === commit, "invalid-parent-line");
  const eventName = process.env.GITHUB_EVENT_NAME ?? "local";
  const eventSha = process.env.GITHUB_SHA === undefined
    ? undefined
    : validatedCommit(process.env.GITHUB_SHA, "invalid-event-sha");
  let event;
  if (process.env.GITHUB_EVENT_PATH !== undefined) {
    event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  }
  const metadata = {
    checkout: {
      commit,
      dirty,
      parentCount: parentLine.length - 1,
      tree,
    },
    event: {
      eventName,
      eventSha,
      checkoutMatchesEventSha: eventSha === undefined ? undefined : commit === eventSha,
    },
    githubRun: {
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      id: process.env.GITHUB_RUN_ID,
      job: process.env.GITHUB_JOB,
      number: process.env.GITHUB_RUN_NUMBER,
    },
  };
  if (eventName === "pull_request") {
    const headCommit = validatedCommit(event?.pull_request?.head?.sha, "invalid-pr-head");
    const baseCommit = validatedCommit(event?.pull_request?.base?.sha, "invalid-pr-base");
    const binding = validatePullRequestMergeBinding({
      baseCommit,
      checkoutCommit: commit,
      eventSha,
      headCommit,
      parentCommits: parentLine.slice(1),
    });
    const mergeCommit = binding.mergeCommit;
    const headTree = gitTree(headCommit);
    const baseTree = gitTree(baseCommit);
    const mergeTree = gitTree(mergeCommit);
    metadata.event.pullRequest = {
      base: { commit: baseCommit, tree: baseTree },
      head: { commit: headCommit, tree: headTree },
      merge: { commit: mergeCommit, tree: mergeTree },
      treeComparison: {
        checkoutEqualsBase: tree === baseTree,
        checkoutEqualsHead: tree === headTree,
        checkoutEqualsMerge: tree === mergeTree,
      },
    };
    requireInvariant(tree === mergeTree, "checkout-pr-tree-mismatch");
  } else if (eventSha !== undefined) {
    requireInvariant(commit === eventSha, "checkout-event-commit-mismatch");
  }
  requireInvariant(!dirty, "checkout-dirty");
  return metadata;
}

async function hashEvidence() {
  const files = {
    builtAdvancedModule: "dist/advanced.js",
    builtTransferModule: "dist/file-handle-transfer.js",
    dependencyLock: "pnpm-lock.yaml",
    packageManifest: "package.json",
    proofProgram: "scripts/file-handle-transfer-proof.mjs",
    sourceAdvancedModule: "src/advanced.ts",
    sourceTransferModule: "src/file-handle-transfer.ts",
    workflow: ".github/workflows/ci.yml",
  };
  const result = {};
  for (const [label, file] of Object.entries(files)) {
    result[label] = sha256(await fs.readFile(file));
  }
  return result;
}

function receiptPath(argv) {
  requireInvariant(argv.length === 2, "invalid-arguments");
  requireInvariant(argv[0] === "--receipt", "invalid-arguments");
  requireInvariant(argv[1].length > 0, "invalid-receipt-output");
  return argv[1];
}

export async function atomicReplaceReceipt(outputPath, encoded, options = {}) {
  requireInvariant(typeof encoded === "string", "receipt-encoding-invalid");
  requireInvariant(Buffer.byteLength(encoded) <= RECEIPT_MAX_BYTES, "receipt-size-exceeded");
  const io = options.io ?? fs;
  const timeoutMs = options.timeoutMs ?? RECEIPT_IO_TIMEOUT_MS;
  const nextPath = `${outputPath}.next`;
  let failure;
  let replaced = false;
  try {
    await bounded(
      Promise.resolve().then(() => io.writeFile(nextPath, encoded, {
        encoding: "utf8",
        flag: "w",
      })),
      timeoutMs,
      "receipt-stage-write-timeout",
    );
    await bounded(
      Promise.resolve().then(() => io.rename(nextPath, outputPath)),
      timeoutMs,
      "receipt-replace-timeout",
    );
    replaced = true;
  } catch (error) {
    failure = error;
  }
  if (!replaced) {
    await boundedCleanup(
      () => io.rm(nextPath, { force: true }),
      timeoutMs,
      "receipt-stage-removal-timeout",
    );
  }
  if (failure !== undefined) throw failure;
}

export async function preservePendingReceipt(outputPath, pendingReceipt, options = {}) {
  const io = options.io ?? fs;
  const timeoutMs = options.timeoutMs ?? RECEIPT_IO_TIMEOUT_MS;
  const encoded = canonicalReceipt(pendingReceipt);
  requireInvariant(Buffer.byteLength(encoded) <= RECEIPT_MAX_BYTES, "receipt-size-exceeded");
  await bounded(
    Promise.resolve().then(() => io.mkdir(path.dirname(outputPath), { recursive: true })),
    timeoutMs,
    "receipt-directory-timeout",
  );
  await atomicReplaceReceipt(outputPath, encoded, { io, timeoutMs });
  return encoded;
}

async function emitReceipt(receipt, outputPath) {
  receipt.emission = { fileRequested: true, fileWritten: true, stdoutWritten: true };
  let encoded;
  try {
    encoded = canonicalReceipt(receipt);
    requireInvariant(Buffer.byteLength(encoded) <= RECEIPT_MAX_BYTES, "receipt-size-exceeded");
    await bounded(
      fs.mkdir(path.dirname(outputPath), { recursive: true }),
      RECEIPT_IO_TIMEOUT_MS,
      "receipt-directory-timeout",
    );
    await atomicReplaceReceipt(outputPath, encoded);
  } catch (error) {
    receipt.emission.fileWritten = false;
    receipt.emission.failure = sanitizeProofFailure(error);
    receipt.passed = false;
    receipt.status = "failed";
    try {
      encoded = canonicalReceipt(receipt);
      requireInvariant(Buffer.byteLength(encoded) <= RECEIPT_MAX_BYTES, "receipt-size-exceeded");
    } catch (encodingError) {
      encoded = canonicalReceipt({
        emission: receipt.emission,
        failure: sanitizeProofFailure(encodingError),
        passed: false,
        schema: receipt.schema,
      });
    }
    process.exitCode = 1;
  }
  process.stdout.write(encoded);
}

async function main() {
  const receipt = {
    bounds: {
      cleanupOperationTimeoutMs: CLEANUP_OPERATION_TIMEOUT_MS,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
      fixtureOperationTimeoutMs: FIXTURE_OPERATION_TIMEOUT_MS,
      gateTimeoutMs: GATE_TIMEOUT_MS,
      partialWriteCapBytes: PARTIAL_WRITE_CAP,
      receiptIoTimeoutMs: RECEIPT_IO_TIMEOUT_MS,
      receiptMaxBytes: RECEIPT_MAX_BYTES,
      scenarioTimeoutMs: SCENARIO_TIMEOUT_MS,
      sourceBytes: SOURCE_BYTES,
    },
    passed: false,
    runtime: {
      arch: process.arch,
      libuv: process.versions.uv,
      node: process.versions.node,
      platform: process.platform,
      v8: process.versions.v8,
    },
    scenarios: [],
    schema: "fs-safe-file-handle-transfer-proof-v1",
    status: "pending",
  };
  let outputPath;
  let phase = "arguments";
  try {
    outputPath = receiptPath(process.argv.slice(2));
    phase = "pending-receipt";
    await preservePendingReceipt(outputPath, {
      bounds: receipt.bounds,
      emission: { fileRequested: true, fileWritten: true, stdoutWritten: false },
      passed: false,
      runtime: receipt.runtime,
      schema: receipt.schema,
      status: "pending",
    });
    phase = "provenance";
    receipt.provenance = await sourceMetadata();
    receipt.hashes = await hashEvidence();
    phase = "load-built-package";
    const { copyFileHandle } = await import("@openclaw/fs-safe/advanced");
    requireInvariant(typeof copyFileHandle === "function", "built-export-missing");
    phase = "stable-replacement";
    await runScenario(receipt, phase, 17, (fixture, initial) =>
      stableReplacementScenario(copyFileHandle, fixture, initial));
    phase = "selected-signal";
    await runScenario(receipt, phase, 53, (fixture, initial) =>
      selectedSignalScenario(copyFileHandle, fixture, initial));
    phase = "current-authority";
    await runScenario(receipt, phase, 91, (fixture, initial) =>
      currentAuthorityScenario(copyFileHandle, fixture, initial));
    receipt.passed = receipt.scenarios.every((scenario) =>
      scenario.passed && scenario.cleanup.directoryRemoved &&
      scenario.cleanup.handleClosesAttempted === scenario.cleanup.handleClosesCompleted);
    requireInvariant(receipt.passed, "scenario-summary-failed");
    receipt.status = "passed";
  } catch (error) {
    receipt.passed = false;
    receipt.failure = { phase, ...sanitizeProofFailure(error) };
    receipt.status = "failed";
    process.exitCode = 1;
  }
  if (outputPath === undefined) {
    receipt.emission = { fileRequested: false, fileWritten: false, stdoutWritten: true };
    let encoded;
    try {
      encoded = canonicalReceipt(receipt);
      requireInvariant(Buffer.byteLength(encoded) <= RECEIPT_MAX_BYTES, "receipt-size-exceeded");
    } catch (error) {
      encoded = canonicalReceipt({
        emission: receipt.emission,
        failure: sanitizeProofFailure(error),
        passed: false,
        schema: receipt.schema,
      });
    }
    process.stdout.write(encoded);
    return;
  }
  await emitReceipt(receipt, outputPath);
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
