import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { assertRootIdentityCurrent } from "./root-context.js";
import { rootHandleContext } from "./root-handle-context.js";
import type { Root } from "./root.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { mergeWatchRescan, watchRescanScopes } from "./watch-rescan.js";
import { admittedNativeChanges, changedEntries, excludedWatchPath, guardedHintChanges, scopedChanges } from "./watch-hints.js";
import path from "node:path";
import { watchBinding, NativeWatchBackend, type NativeWatchBatch, type NativeWatchHint } from "./watch-native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import type { NativeBinding } from "./native.js";
import { isWatchPathError, scanWatch, watchScopes, type DirectoryIdentity, type WatchSnapshot } from "./watch-scan.js";
import type { WatchChange, WatchInvalidation, WatchFailure, WatchHealth, WatchOptions, WatchScope, WatchSubscription } from "./watch-types.js";
export type * from "./watch-types.js";

function deferred() {
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Ownership exists even when a consumer closes without awaiting startup.
  void promise.catch(() => {});
  return { promise, get settled() { return settled; },
    resolve() { settled = true; resolve(); },
    reject(error: unknown) { settled = true; reject(error); },
  };
}
function budget(value: number | undefined, fallback: number, name: string, max = 1_000_000): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new RangeError("invalid watch " + name);
  return result;
}
const retired = () => new DOMException("Watch generation retired", "AbortError");
const coalesceMs = 25;

/** Advisory observation only. Hints never grant filesystem authority. */
export function watch(root: Root, input: WatchOptions): WatchSubscription {
  const context = rootHandleContext(root);
  const options = { ...input };
  const persistent = options.persistent !== false;
  if (!["auto", "events", "poll"].includes(options.mode)) throw new TypeError("invalid watch mode");
  let binding: NativeBinding | undefined;
  let selectionFailure: unknown;
  try { binding = watchBinding(options.mode); } catch (error) { selectionFailure = error; }
  let mode: "events" | "poll" = binding || options.mode === "events" ? "events" : "poll";
  let intervalMs = budget(options.intervalMs, mode === "events" ? 30_000 : 1000, "intervalMs", 2_147_483_647);
  if (intervalMs < 20) throw new RangeError("watch intervalMs must be at least 20");
  const pollIntervalMs = budget(options.pollIntervalMs, options.intervalMs ?? 1000, "pollIntervalMs", 2_147_483_647);
  if (pollIntervalMs < 20) throw new RangeError("watch pollIntervalMs must be at least 20");
  if (mode === "poll") intervalMs = pollIntervalMs;
  const maxDirectories = budget(options.maxDirectories, 4096, "maxDirectories");
  const maxEntries = budget(options.maxEntries, 100_000, "maxEntries");
  const maxPendingPaths = budget(options.maxPendingPaths, 256, "maxPendingPaths", 4096);
  if (typeof options.onInvalidate !== "function") throw new TypeError("watch requires onInvalidate");
  const callerSignal = options.signal ? AbortSignal.any([options.signal]) : undefined;
  const makeGeneration = (scopes: readonly WatchScope[]) => ({
    scopes: watchScopes(scopes), abort: new AbortController(), waiter: deferred(),
  });
  let current = makeGeneration(options.scopes);
  const ready = current.waiter.promise;
  let state: WatchHealth["state"] = "starting";
  let terminal = false;
  let failure: unknown;
  let failureInfo: WatchFailure | undefined;
  let retirementFailure: { error: unknown } | undefined;
  const retirementErrors = new Set<unknown>();
  let closing: Promise<void> | undefined;
  let active: Promise<void> | undefined;
  let backend: NativeWatchBackend | undefined;
  const registered = new Map<string, DirectoryIdentity>();
  let observedDirectories = 0;
  let snapshot: WatchSnapshot | undefined;
  let resetRequested = false;
  let refreshBackend = false;
  let pending = false;
  let fullRequested = false;
  let pendingUncertain = false;
  let pendingWaiter: ReturnType<typeof deferred> | undefined;
  let runningWaiter: ReturnType<typeof deferred> | undefined;
  let pendingHint = false;
  let pendingBackendOverflow = false;
  let pendingChanges: Map<string, NativeWatchHint> | undefined = new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  type Generation = typeof current;
  const combinedFailure = () => {
    if (!retirementFailure) return failure;
    const error = retirementFailure.error;
    if (failure === undefined || error === failure || (error as { suppressed?: unknown } | null)?.suppressed === failure) return error;
    return createSuppressedError(error, failure, "watch observation and retirement failed");
  };
  const retainRetirement = (error: unknown) => {
    if (retirementErrors.has(error)) return;
    retirementErrors.add(error);
    retirementFailure = { error: retirementFailure
      ? createSuppressedError(error, retirementFailure.error, "watch retirement failed more than once") : error };
  };
  const health = (): WatchHealth => Object.freeze({
    state, mode, directories: observedDirectories,
    ...(failure === undefined && !retirementFailure ? {} : {
      failure: retirementFailure ? Object.freeze({ operation: "close" as const, error: combinedFailure() }) : failureInfo,
    }),
  });
  const check = (g: Generation) => {
    g.abort.signal.throwIfAborted();
    if (terminal || current !== g) throw retired();
    if (failure !== undefined) throw failure;
    if (retirementFailure) throw retirementFailure.error;
  };
  const clearTimers = () => {
    clearTimeout(timer); clearTimeout(hintTimer);
    timer = undefined; hintTimer = undefined; pending = false; pendingHint = false; pendingChanges = new Map();
    pendingBackendOverflow = false;
    pendingUncertain = false;
  };
  const notifyHealth = () => {
    try {
      const result = options.onHealth?.(health());
      assertSynchronousCallbackResult(result, "watch onHealth");
    } catch (cause) { throw new FsSafeError("helper-failed", "watch health callback failed", { cause, details: { operation: "callback" } }); }
  };
  const dirty = (g: Generation, reason: WatchInvalidation["reason"], changes?: readonly WatchChange[]) => {
    check(g);
    try {
      const result = options.onInvalidate(Object.freeze({ reason, changes: changes && Object.freeze(changes) }));
      assertSynchronousCallbackResult(result, "watch onInvalidate");
    } catch (cause) { throw new FsSafeError("helper-failed", "watch dirty callback failed", { cause, details: { operation: "callback" } }); }
    check(g);
  };
  const retain = (error: unknown) => {
    if (failure === undefined) {
      failure = error;
      failureInfo = Object.freeze({ operation: "close", error });
    } else if (error !== failure) failure = createSuppressedError(error, failure, "watch and retirement both failed");
  };
  const retireBackend = async () => {
    const old = backend;
    try { await old?.close(); }
    catch (error) { retainRetirement(error); }
    if (backend === old) { backend = undefined; registered.clear(); observedDirectories = 0; }
    if (retirementFailure) throw retirementFailure.error;
  };
  const lose = (error: unknown, operation: WatchFailure["operation"] = "scan") => {
    if (terminal || failure !== undefined) return;
    if (error === undefined) error = new FsSafeError("helper-failed", "watch operation failed without an error value", { details: { operation } });
    retain(error);
    const details = error instanceof FsSafeError ? error.details : undefined;
    const code = details?.code ?? (error as { code?: unknown } | null)?.code;
    failureInfo = Object.freeze({ error, operation: details?.operation === "watch" ? "watch" : details?.operation === "callback" ? "callback" : details?.operation === "close" ? "close" : operation, ...(typeof code === "string" ? { code } : {}) });
    current.abort.abort(error);
    current.waiter.reject(error);
    pendingWaiter?.reject(error); runningWaiter?.reject(error);
    pendingWaiter = undefined; runningWaiter = undefined;
    clearTimers();
    state = "unavailable";
    // Stop backend admission before notifying. Its join remains owned by active/close.
    try { backend?.close(); } catch (error) { retainRetirement(error); }
    try { notifyHealth(); } catch (callbackError) { retain(callbackError); }
  };
  const scheduleInterval = () => {
    if (timer || fullRequested || terminal || failure !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void request().catch(() => {}); }, intervalMs);
    if (!persistent) timer.unref();
  };
  const onHint = (g: Generation, batch: NativeWatchBatch) => {
    if (terminal || current !== g || g.abort.signal.aborted || failure !== undefined) return;
    if (batch.overflow) {
      pendingBackendOverflow = true;
      try { assertSynchronousCallbackResult(getFsSafeTestHooks()?.afterWatchBackendOverflow?.(context.rootReal, "received"), "afterWatchBackendOverflow"); }
      catch (error) { lose(error, "callback"); return; }
    }
    if (batch.error === "ESTALE") refreshBackend = true;
    else if (batch.error) { lose(new FsSafeError("helper-failed", "native watch failed", { details: { operation: "watch", code: batch.error } })); return; }
    if (batch.overflow) pendingChanges = undefined;
    else if (pendingChanges) for (const hint of batch.hints) {
      if (hint.event === "rename") pendingUncertain = true;
      if (typeof hint.name === "string" && excludedWatchPath(snapshot, hint.directory ? path.join(hint.directory, hint.name) : hint.name)) {
        pendingUncertain = true;
        continue;
      }
      // Multiple bounded native batches can still fill the JS coalescing window.
      // A Root fold retains discovery while letting the guarded diff own detail.
      if (pendingChanges.get("subtree-root")?.event === "subtree") continue;
      const key = JSON.stringify([hint.directory, hint.name, hint.event === "children" || hint.event === "subtree" ? hint.event : "entry"]);
      if (!pendingChanges.has(key) && pendingChanges.size >= maxPendingPaths) {
        pendingChanges.clear();
        pendingChanges.set("subtree-root", { directory: "", name: "", event: "subtree" });
        break;
      }
      const previous = pendingChanges.get(key);
      pendingChanges.set(key, previous?.event === "rename" ? previous : hint);
    }
    if (!batch.hints.length) pendingUncertain = true;
    pendingHint = true;
    pending = true;
    if (hintTimer) return;
    hintTimer = setTimeout(() => {
      hintTimer = undefined;
      if (terminal || current !== g || failure !== undefined) return;
      // Raw backend filenames stay private. Reconcile before publishing detail.
      void request(false).catch(() => {});
    }, coalesceMs);
    if (!persistent) hintTimer.unref();
  };
  const fallBack = (error: unknown): boolean => {
    if (options.mode !== "auto" || getFsSafeNativeConfig().mode === "require" ||
      !(error instanceof FsSafeError) || error.code !== "helper-unavailable") return false;
    mode = "poll"; binding = undefined;
    intervalMs = pollIntervalMs;
    return true;
  };
  const observe = async (g: Generation) => {
    check(g);
    if (selectionFailure !== undefined) throw new FsSafeError("helper-unavailable", "native watch events are unavailable", { cause: selectionFailure, details: { operation: "watch" } });
    if (refreshBackend) { await retireBackend(); check(g); refreshBackend = false; fullRequested = true; }
    if (resetRequested) {
      await retireBackend(); check(g);
      snapshot = undefined; resetRequested = false;
    }
    const hadHints = pendingHint;
    const hadBackendOverflow = pendingBackendOverflow;
    const hints = pendingChanges;
    const full = fullRequested || pendingUncertain;
    fullRequested = false; pendingUncertain = false;
    pendingHint = false; pendingChanges = new Map();
    pendingBackendOverflow = false;
    clearTimeout(hintTimer); hintTimer = undefined;
    let scanScopes = g.scopes;
    if (snapshot && hadHints && hints && !full) {
      try {
        const admitted = await admittedNativeChanges(context, g.scopes, snapshot, snapshot, {
          hints: [...hints.values()], overflow: false,
        }, g.abort.signal, maxPendingPaths, true);
        check(g);
        if (admitted?.length === 0) return;
        if (admitted) scanScopes = watchRescanScopes(g.scopes, snapshot, admitted) ?? g.scopes;
      } catch (error) {
        check(g);
        await assertRootIdentityCurrent(context);
        if (!isWatchPathError(error)) throw error;
        // An uncertain alias or stale identity never suppresses reconciliation.
      }
    }
    state = snapshot ? "reconciling" : "starting";
    notifyHealth();
    check(g);
    if (mode === "events" && !backend && g.scopes.length) {
      try {
        const candidate = new NativeWatchBackend(binding!, context, batch => {
          if (backend === candidate) onHint(g, batch);
        }, maxPendingPaths, persistent);
        backend = candidate;
        if (snapshot) candidate.configure(snapshot, g.scopes);
        const hookResult = getFsSafeTestHooks()?.afterWatchBackendCreated?.(context.rootReal, batch => {
          if (backend === candidate) onHint(g, batch);
        }, (path, flags) => candidate.testEvent(path, flags));
        assertSynchronousCallbackResult(hookResult, "afterWatchBackendCreated");
      } catch (error) { if (!fallBack(error)) throw error; }
      check(g);
    }
    let next: WatchSnapshot;
    for (let attempt = 0; ; attempt++) {
      if (scanScopes === g.scopes) { clearTimeout(timer); timer = undefined; }
      try { next = await scanWatch(context, scanScopes, { exclude: options.exclude, maxDirectories, maxEntries, maxPendingPaths, admitting: !snapshot, previous: snapshot }, g.abort.signal,
        async (name, identity, guard) => {
          check(g);
          const existing = registered.get(name);
          const acquire = !existing || existing.dev !== identity.dev || existing.ino !== identity.ino;
          await getFsSafeTestHooks()?.beforeWatchRegistration?.(guard.realPath);
          check(g);
          if (acquire) {
            try { backend?.add(name, identity); }
            catch (error) {
              if (snapshot || !fallBack(error)) throw error;
              await retireBackend(); check(g);
            }
          }
          await getFsSafeTestHooks()?.afterWatchRegistration?.(guard.realPath);
          check(g);
          if (acquire) registered.set(name, identity);
        }, retainRetirement); }
      catch (error) {
        // A slice can repeat ancestor lookups that a full traversal shares.
        // Let the authoritative full pass decide whether the configured limit is exceeded.
        if (scanScopes !== g.scopes && error instanceof FsSafeError && error.code === "too-large") {
          scanScopes = g.scopes;
          continue;
        }
        throw error;
      }
      check(g);
      if (scanScopes !== g.scopes) {
        const merged = mergeWatchRescan(g.scopes, snapshot!, next, scanScopes);
        if (!merged || merged.scanned > maxEntries || merged.directories.size > maxDirectories || (merged.excluded?.size ?? 0) > maxEntries) {
          scanScopes = g.scopes;
          continue;
        }
        next = merged;
      }
      try {
        const entriesChanged = backend?.entries(next);
        const streamsChanged = backend?.configure(next, g.scopes);
        if (entriesChanged || streamsChanged) {
          // Complete a guarded pass with the new transport before publishing readiness.
          // Bound handovers under churn; later passes still reconcile ongoing changes.
          scanScopes = g.scopes;
          if (attempt < 2) continue;
          pending = true;
          fullRequested = true;
        }
        break;
      } catch (error) {
        await assertRootIdentityCurrent(context);
        check(g);
        if (attempt >= 2 || !isWatchPathError(error)) throw error;
        scanScopes = g.scopes;
        // A replacement between scan and descriptor admission requires a fresh identity.
      }
    }
    // Retire stale inventory before the next pass; that crawl installs fresh anchors first.
    if ([...registered.keys()].some(name => !next.directories.has(name))) {
      refreshBackend = true;
    }
    observedDirectories = backend?.directories === undefined ? next.directories.size
      : backend.directories + (g.scopes.some(scope => scope.kind === "tree") ? next.directories.size : 0);
    const initial = !snapshot;
    let observed = next.overflow ? undefined : changedEntries(snapshot, next, maxPendingPaths);
    if (observed) {
      const changes = new Map(observed.map(change => [change.path, change]));
      for (const name of next.structural ?? []) for (const change of scopedChanges(g.scopes, { path: name, type: "structural" })) changes.set(change.path, change);
      observed = changes.size > maxPendingPaths ? undefined : [...changes.values()];
    }
    let admittedHints: WatchChange[] | undefined = [];
    try {
      if (hadHints) admittedHints = await admittedNativeChanges(context, g.scopes, snapshot, next, {
        hints: hints ? [...hints.values()] : [], overflow: !hints,
      }, g.abort.signal, maxPendingPaths);
    } catch (error) {
      check(g);
      await assertRootIdentityCurrent(context);
      if (!isWatchPathError(error)) throw error;
      admittedHints = undefined;
    }
    check(g);
    await assertRootIdentityCurrent(context);
    check(g);
    let details = hadHints
      ? guardedHintChanges(g.scopes, snapshot, next, admittedHints, observed, maxPendingPaths)
      : observed;
    snapshot = next;
    if (!initial && !details && hadBackendOverflow) {
      assertSynchronousCallbackResult(getFsSafeTestHooks()?.afterWatchBackendOverflow?.(context.rootReal, "reconciled"), "afterWatchBackendOverflow");
    }
    // Publish before readiness; callbacks may synchronously retire this generation.
    if (initial || !details || details.length) dirty(g, initial ? "reconcile" : !details ? "overflow" : hadHints ? "event" : "reconcile", initial ? undefined : details);
    check(g);
    state = "ready";
    notifyHealth();
    check(g);
    // Rearm even when sustained hints keep the pump's coalesced request occupied.
    scheduleInterval();
  };
  const pump = () => {
    if (active || terminal || failure !== undefined) return;
    // Enroll before any callback. There is one active pass and one coalesced request.
    active = Promise.resolve().then(async () => {
      do {
        const g = current;
        pending = false;
        if (pendingWaiter) {
          // A scope replacement keeps reconcile requests alive until its baseline completes.
          const previous = runningWaiter;
          runningWaiter = pendingWaiter; pendingWaiter = undefined;
          if (previous) void runningWaiter.promise.then(() => previous.resolve(), error => previous.reject(error));
        }
        try {
          await observe(g);
          check(g);
          g.waiter.resolve();
          runningWaiter?.resolve(); runningWaiter = undefined;
        } catch (error) {
          g.waiter.reject(error);
          if (!g.abort.signal.aborted && current === g && !terminal) lose(error);
          try { await retireBackend(); } catch (closeError) { retainRetirement(closeError); }
        }
        if (current !== g) {
          await retireBackend(); snapshot = undefined; pending = true;
        }
      } while (pending && !terminal && failure === undefined);
    }).catch(lose).finally(() => {
      active = undefined;
      if (!terminal && failure === undefined) {
        if (pending || !current.waiter.settled) pump(); else scheduleInterval();
      }
    });
  };
  const request = (full = true): Promise<void> => {
    if (terminal) return Promise.reject(retired());
    if (failure !== undefined) return Promise.reject(failure);
    if (full) { clearTimeout(timer); timer = undefined; fullRequested = true; }
    pending = true;
    pendingWaiter ??= deferred();
    const result = pendingWaiter.promise;
    pump();
    return result;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    terminal = true;
    current.abort.abort(retired());
    current.waiter.reject(retired());
    pendingWaiter?.reject(retired()); runningWaiter?.reject(retired());
    pendingWaiter = undefined; runningWaiter = undefined;
    clearTimers();
    if (callerSignal) callerSignal.onabort = null;
    // Start physical stop immediately, without waiting behind an in-flight scan.
    try { backend?.close(); } catch (error) { retainRetirement(error); }
    closing = Promise.resolve().then(async () => {
      await active;
      try { await retireBackend(); } catch (error) { retainRetirement(error); }
      state = "closed";
      if (retirementFailure) throw combinedFailure();
    });
    void closing.catch(() => {});
    return closing;
  };
  const abort = () => { void close(); };
  const subscription: WatchSubscription = {
    ready, health, close, [Symbol.asyncDispose]: close,
    reconcile: () => request(),
    setScopes(scopes) {
      if (terminal) return Promise.reject(retired());
      if (failure !== undefined) return Promise.reject(failure);
      const previous = current;
      const next = makeGeneration(scopes);
      // Scope accessors may synchronously close this owner during validation.
      if (terminal || failure !== undefined || current !== previous) {
        next.waiter.reject(failure ?? retired());
        return next.waiter.promise;
      }
      current.abort.abort(retired());
      current.waiter.reject(retired());
      current = next;
      resetRequested = true;
      try { backend?.close(); } catch (error) { retainRetirement(error); }
      clearTimers();
      state = "starting";
      // If idle, retire the old backend before the next scan can admit anything.
      if (!active) {
        active = retireBackend().catch(error => lose(error, "close")).finally(() => {
          active = undefined; snapshot = undefined; pump();
        });
      }
      return next.waiter.promise;
    },
  };
  if (callerSignal) callerSignal.onabort = abort;
  if (callerSignal?.aborted) abort(); else pump();
  return subscription;
}
