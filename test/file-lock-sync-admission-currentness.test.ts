import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync, type FileLockSyncAcquireOptions } from "../src/file-lock.js";
import type { SyncHeldLock } from "../src/file-lock-sync-admission.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const heldKey = Symbol.for("fsSafe.syncSidecarLocks");
const admissionsKey = Symbol.for("fsSafe.syncSidecarLockAdmissions");
const cleanupHandlerKey = Symbol.for("fsSafe.syncSidecarLockCleanupHandler");
type Loss = "token" | "holder";

function held(): Map<string, SyncHeldLock> {
  return Reflect.get(globalThis, heldKey) as Map<string, SyncHeldLock>;
}

function admissions(): Map<string, object> {
  return Reflect.get(globalThis, admissionsKey) as Map<string, object>;
}

function normalizedTarget(directory: string, targetPath: string): string {
  const parent = process.platform === "win32"
    ? fs.realpathSync.native(directory)
    : fs.realpathSync(directory);
  return path.join(parent, path.basename(targetPath));
}

function freshProbe(targetPath: string): void {
  const probe = acquireFileLockSync(targetPath, {
    timeoutMs: 0, retry: { retries: 0 }, payload: () => ({ owner: "probe" }),
  });
  expect(probe.verifyStillHeld()).toBe(true);
  probe.release();
}

afterEach(() => {
  vi.restoreAllMocks();
  (Reflect.get(globalThis, cleanupHandlerKey) as (() => void) | undefined)?.();
  held().clear();
  admissions().clear();
});

describe("synchronous admission boundary currentness", () => {
  const freshStages = [
    "staleRecovery", "payloadAccessor", "payload", "serialization",
    "onCompromised", "parsePayload",
  ] as const;

  it.each(
    (["token", "holder"] as const).flatMap((loss) =>
      freshStages.map((stage) => ({ loss, stage }))),
  )("stops fresh work after $loss loss at $stage", async ({ loss, stage }) => {
    const directory = await tempRoot(`fs-safe-sync-boundary-${stage}-${loss}-`);
    const targetPath = path.join(directory, "state.json");
    const normalized = normalizedTarget(directory, targetPath);
    const replacement = { lockPath: "replacement" } as SyncHeldLock;
    const unrelatedPath = path.join(directory, "unrelated.json");
    const unrelated = { lockPath: "unrelated" } as SyncHeldLock;
    let mutated = false;
    const mutate = () => {
      if (mutated) return;
      mutated = true;
      if (loss === "token") admissions().clear();
      else held().set(normalized, replacement);
      held().set(unrelatedPath, unrelated);
    };
    let payloadCalls = 0, serializationCalls = 0;
    let compromisedAccesses = 0, parserAccesses = 0;
    const options = {} as FileLockSyncAcquireOptions<Record<string, unknown>>;
    Object.defineProperties(options, {
      timeoutMs: { value: 0 },
      retry: { value: { retries: 0 } },
      staleRecovery: { get() { if (stage === "staleRecovery") mutate(); return "fail-closed"; } },
      payload: { get() {
        if (stage === "payloadAccessor") mutate();
        return () => {
          payloadCalls += 1;
          if (stage === "payload") mutate();
          return { toJSON() {
            serializationCalls += 1;
            if (stage === "serialization") mutate();
            return { owner: "candidate" };
          } };
        };
      } },
      onCompromised: { get() {
        compromisedAccesses += 1;
        if (stage === "onCompromised") mutate();
        return undefined;
      } },
      parsePayload: { get() {
        parserAccesses += 1;
        if (stage === "parsePayload") mutate();
        return JSON.parse;
      } },
    });
    const open = vi.spyOn(fs, "openSync");
    expect(() => acquireFileLockSync(targetPath, options))
      .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(mutated).toBe(true);
    expect(payloadCalls).toBe(freshStages.indexOf(stage) >= freshStages.indexOf("payload") ? 1 : 0);
    expect(serializationCalls).toBe(
      freshStages.indexOf(stage) >= freshStages.indexOf("serialization") ? 1 : 0,
    );
    expect(compromisedAccesses).toBe(
      freshStages.indexOf(stage) >= freshStages.indexOf("onCompromised") ? 1 : 0,
    );
    expect(parserAccesses).toBe(stage === "parsePayload" ? 1 : 0);
    expect(open).not.toHaveBeenCalled();
    expect(held().get(unrelatedPath)).toBe(unrelated);
    if (loss === "holder") expect(held().get(normalized)).toBe(replacement);
    else expect(held().has(normalized)).toBe(false);
    expect(admissions().size).toBe(0);
    held().delete(normalized);
    held().delete(unrelatedPath);
    open.mockRestore();
    freshProbe(targetPath);
  });

  const staleStages = [
    "parser", "shouldReclaimGetter", "shouldRemoveGetter",
    "shouldReclaim", "shouldRemove", "removalObservation",
  ] as const;

  it.each(
    (["token", "holder"] as const).flatMap((loss) =>
      staleStages.map((stage) => ({ loss, stage }))),
  )("stops stale work after $loss loss at $stage", async ({ loss, stage }) => {
    const directory = await tempRoot(`fs-safe-sync-stale-boundary-${stage}-${loss}-`);
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    const raw = JSON.stringify({ owner: "external" });
    fs.writeFileSync(lockPath, raw);
    const normalized = normalizedTarget(directory, targetPath);
    const replacement = { lockPath: "replacement" } as SyncHeldLock;
    const unrelatedPath = path.join(directory, "unrelated.json");
    const unrelated = { lockPath: "unrelated" } as SyncHeldLock;
    let mutated = false;
    const mutate = () => {
      if (mutated) return;
      mutated = true;
      if (loss === "token") admissions().clear();
      else held().set(normalized, replacement);
      held().set(unrelatedPath, unrelated);
    };
    let parserCalls = 0, reclaimAccesses = 0, removeAccesses = 0;
    const reclaim = vi.fn(() => { if (stage === "shouldReclaim") mutate(); return true; });
    const remove = vi.fn(() => { if (stage === "shouldRemove") mutate(); return true; });
    const options: FileLockSyncAcquireOptions<Record<string, unknown>> = {
      timeoutMs: 0, retry: { retries: 0 }, staleRecovery: "remove-if-unchanged",
      payload: () => ({ owner: "candidate" }),
      parsePayload: (value) => {
        parserCalls += 1;
        if (stage === "parser") mutate();
        return JSON.parse(value) as unknown;
      },
      get shouldReclaim() {
        reclaimAccesses += 1;
        if (stage === "shouldReclaimGetter") mutate();
        return reclaim;
      },
      get shouldRemoveStaleLock() {
        removeAccesses += 1;
        if (stage === "shouldRemoveGetter") mutate();
        return remove;
      },
    };
    const originalOpen = fs.openSync.bind(fs);
    let lockOpens = 0;
    vi.spyOn(fs, "openSync").mockImplementation(((candidate, flags, mode) => {
      if (String(candidate) === lockPath) {
        lockOpens += 1;
        if (stage === "removalObservation" && lockOpens === 3) mutate();
      }
      return originalOpen(candidate, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(() => acquireFileLockSync(targetPath, options))
        .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
      expect(mutated).toBe(true);
      expect(parserCalls).toBe(
        stage === "shouldReclaimGetter" || stage === "shouldRemoveGetter" ? 0 : 1,
      );
      expect(reclaimAccesses).toBe(1);
      expect(removeAccesses).toBe(stage === "shouldReclaimGetter" ? 0 : 1);
      expect(reclaim).toHaveBeenCalledTimes(
        (["shouldReclaim", "shouldRemove", "removalObservation"] as string[]).includes(stage) ? 1 : 0,
      );
      expect(remove).toHaveBeenCalledTimes(
        (["shouldRemove", "removalObservation"] as string[]).includes(stage) ? 1 : 0,
      );
      expect(held().get(unrelatedPath)).toBe(unrelated);
      if (loss === "holder") expect(held().get(normalized)).toBe(replacement);
      else expect(held().has(normalized)).toBe(false);
      expect(admissions().size).toBe(0);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(raw);
      expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
    } finally {
      held().delete(normalized);
      held().delete(unrelatedPath);
      fs.rmSync(lockPath, { force: true });
    }
    freshProbe(targetPath);
  });
});
