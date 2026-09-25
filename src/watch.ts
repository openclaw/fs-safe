import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { assertRootIdentityCurrent } from "./root-context.js";
import { rootHandleContext } from "./root-handle-context.js";
import type { Root } from "./root.js";
import { createSuppressedError } from "./suppressed-error.js";
import { admittedNativeChanges } from "./watch-alias.js";
import { changedEntries, guardedHintChanges } from "./watch-hints.js";
import { NodeWatchBackend, type NodeWatchBatch, type NodeWatchHint } from "./watch-node.js";
import { sameEntries, scanWatch, watchScopes, type DirectoryIdentity, type WatchSnapshot } from "./watch-scan.js";
import type { WatchChange, WatchDirty, WatchFailure, WatchHealth, WatchOptions, WatchScope, WatchSubscription } from "./watch-types.js";
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
const restart = Symbol("reacquire");

/** Advisory observation only. Hints never grant filesystem authority. */
export function watch(root: Root, input: WatchOptions): WatchSubscription {
  const context = rootHandleContext(root);
  const options = { ...input };
  const mode = options.mode ?? "node";
  if (mode !== "node" && mode !== "poll") throw new TypeError("invalid watch mode");
  const intervalMs = budget(options.intervalMs, mode === "node" ? 30_000 : 1000, "intervalMs", 2_147_483_647);
  if (intervalMs < 20) throw new RangeError("watch intervalMs must be at least 20");
  const maxDirectories = budget(options.maxDirectories, 4096, "maxDirectories");
  const maxEntries = budget(options.maxEntries, 100_000, "maxEntries");
  const maxPendingPaths = budget(options.maxPendingPaths, 256, "maxPendingPaths", 4096);
  const maxPasses = budget(options.maxPasses, 4, "maxPasses", 32);
  if (maxPasses < 2) throw new RangeError("watch maxPasses must be at least 2");
  if (typeof options.onDirty !== "function") throw new TypeError("watch requires onDirty");
  let generation = 0;
  const makeGeneration = (scopes: readonly WatchScope[]) => ({
    id: ++generation, scopes: watchScopes(scopes), abort: new AbortController(), waiter: deferred(),
  });
  let current = makeGeneration(options.scopes);
  const ready = current.waiter.promise;
  let state: WatchHealth["state"] = "starting";
  let terminal = false;
  let failure: unknown;
  let failureInfo: WatchFailure | undefined;
  let closing: Promise<void> | undefined;
  let active: Promise<void> | undefined;
  let backend: NodeWatchBackend | undefined;
  let registered = new Map<string, DirectoryIdentity>();
  let snapshot: WatchSnapshot | undefined;
  let resetRequested = false;
  let scannedEntries = 0;
  let reconciliations = 0;
  let revision = 0;
  let pendingHint = false;
  let pendingChanges: Map<string, NodeWatchHint> | undefined = new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  type Generation = typeof current;
  const health = (): WatchHealth => Object.freeze({
    state, generation: current.id, mode, directories: backend?.directoryCount() ?? 0,
    observedDirectories: registered.size,
    workers: backend ? 1 : 0, scannedEntries, reconciliations,
    pendingInvalidations: pendingHint ? 1 : 0,
    ...(failure === undefined ? {} : { error: failure, failure: failureInfo }),
  });
  const check = (g: Generation) => {
    g.abort.signal.throwIfAborted();
    if (terminal || current !== g) throw retired();
    if (failure !== undefined) throw failure;
  };
  const clearTimers = () => {
    clearTimeout(timer); clearTimeout(hintTimer);
    timer = undefined; hintTimer = undefined; pendingHint = false; pendingChanges = new Map();
  };
  const notifyHealth = () => {
    try {
      const result = options.onHealth?.(health());
      assertSynchronousCallbackResult(result, "watch onHealth");
    } catch (cause) { throw new FsSafeError("helper-failed", "watch health callback failed", { cause, details: { operation: "callback" } }); }
  };
  const dirty = (g: Generation, reason: WatchDirty["reason"], changes?: readonly WatchChange[]) => {
    check(g);
    try {
      const result = options.onDirty(Object.freeze({ generation: g.id, scopes: g.scopes, reason, changes: changes && Object.freeze(changes) }));
      assertSynchronousCallbackResult(result, "watch onDirty");
    } catch (cause) { throw new FsSafeError("helper-failed", "watch dirty callback failed", { cause, details: { operation: "callback" } }); }
    check(g);
  };
  const retain = (error: unknown) => {
    if (failure === undefined) {
      failure = error;
      failureInfo = Object.freeze({ operation: "close" });
    } else if (error !== failure) failure = createSuppressedError(error, failure, "watch and retirement both failed");
  };
  const retireBackend = async () => {
    const old = backend;
    if (!old) { registered.clear(); return; }
    try { await old.close(); }
    finally { if (backend === old) { backend = undefined; registered.clear(); } }
  };
  const lose = (error: unknown, operation: WatchFailure["operation"] = "scan") => {
    if (terminal || failure !== undefined) return;
    retain(error);
    const details = error instanceof FsSafeError ? error.details : undefined;
    const code = details?.code ?? (error as { code?: unknown } | null)?.code;
    failureInfo = Object.freeze({ operation: details?.operation === "watch" ? "watch" : details?.operation === "callback" ? "callback" : details?.operation === "close" ? "close" : operation, ...(typeof code === "string" ? { code } : {}) });
    current.abort.abort(error);
    current.waiter.reject(error);
    clearTimers();
    state = "unavailable";
    // Stop backend admission before notifying. Its join remains owned by active/close.
    void backend?.close().catch(() => {});
    try { notifyHealth(); } catch (callbackError) { retain(callbackError); }
  };
  const scheduleInterval = () => {
    if (terminal || failure !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void request().catch(() => {}); }, intervalMs);
    if (options.persistent === false) timer.unref();
  };
  const onHint = (g: Generation, batch: NodeWatchBatch) => {
    if (terminal || current !== g || g.abort.signal.aborted || failure !== undefined) return;
    if (batch.overflow) pendingChanges = undefined;
    else if (pendingChanges) for (const hint of batch.hints) {
      const key = JSON.stringify([hint.directory, hint.name]);
      if (!pendingChanges.has(key) && pendingChanges.size >= maxPendingPaths) { pendingChanges = undefined; break; }
      const previous = pendingChanges.get(key);
      pendingChanges.set(key, previous?.event === "rename" ? previous : hint);
    }
    revision++;
    pendingHint = true;
    if (hintTimer) return;
    hintTimer = setTimeout(() => {
      hintTimer = undefined;
      if (terminal || current !== g || failure !== undefined) return;
      // Raw backend filenames stay private. Reconcile before publishing detail.
      void request().catch(() => {});
    }, 25);
    if (options.persistent === false) hintTimer.unref();
  };
  const observe = async (g: Generation) => {
    check(g);
    if (resetRequested) {
      await retireBackend(); check(g);
      snapshot = undefined; resetRequested = false;
    }
    state = snapshot ? "reconciling" : "starting";
    notifyHealth();
    check(g);
    let prior: WatchSnapshot | undefined;
    let reacquired = false;
    const retryChurn = async (error: unknown) => {
      check(g);
      // Descendant churn never grants a replacement authority Root.
      await assertRootIdentityCurrent(context);
      if (error !== restart && !isNotFoundPathError(error) &&
        !(error instanceof FsSafeError && ["not-found", "path-mismatch"].includes(error.code))) throw error;
      dirty(g, "reconcile");
      await retireBackend();
      prior = undefined; reacquired = true;
    };
    for (let pass = 0; pass < maxPasses; pass++) {
      check(g);
      if (mode === "node" && !backend && g.scopes.length) {
        backend = new NodeWatchBackend(batch => onHint(g, batch), error => { if (current === g && !g.abort.signal.aborted) lose(error, "watch"); }, options.persistent !== false, maxPendingPaths);
      }
      const before = revision;
      let next: WatchSnapshot;
      try {
        next = await scanWatch(context, g.scopes, { exclude: options.exclude, maxDirectories, maxEntries }, g.abort.signal,
          async (name, identity) => {
            check(g);
            const existing = registered.get(name);
            if (existing && (existing.dev !== identity.dev || existing.ino !== identity.ino)) throw restart;
            if (existing) return;
            // Admission budget includes registrations from the previous scan.
            if (registered.size >= maxDirectories) throw restart;
            await backend?.add(path.join(context.rootReal, name), name);
            check(g);
            registered.set(name, identity);
          });
        check(g);
        if ([...registered.keys()].some(name => !next.directories.has(name))) throw restart;
        // IPC ordering only, NOT an OS stream flush or coverage receipt.
        await backend?.drainCommands();
        check(g);
      } catch (error) {
        await retryChurn(error);
        continue;
      }
      scannedEntries = next.scanned;
      reconciliations++;
      if (sameEntries(prior, next) && before === revision) {
        const changed = reacquired || !sameEntries(snapshot, next);
        const hadHints = pendingHint;
        const observed = reacquired ? undefined : changedEntries(snapshot, next, maxPendingPaths);
        const nativeRevision = revision;
        let admittedHints: WatchChange[] | undefined = [];
        try {
          if (hadHints) admittedHints = await admittedNativeChanges(context, g.scopes, snapshot, next, {
            hints: pendingChanges ? [...pendingChanges.values()] : [], overflow: !pendingChanges,
          }, g.abort.signal, maxPendingPaths);
        } catch (error) { await retryChurn(error); continue; }
        check(g);
        if (nativeRevision !== revision) { prior = next; continue; }
        const details = hadHints
          ? guardedHintChanges(g.scopes, snapshot, next, admittedHints, observed, maxPendingPaths)
          : observed;
        pendingHint = false; pendingChanges = new Map();
        clearTimeout(hintTimer); hintTimer = undefined;
        snapshot = next;
        state = "ready";
        // Publish invalidation before readiness; callbacks may synchronously retire us.
        if (changed || (hadHints && (!details || details.length))) dirty(g, hadHints ? (details ? "event" : "overflow") : "reconcile", details);
        check(g);
        notifyHealth();
        check(g);
        return;
      }
      prior = next;
    }
    throw new FsSafeError("timeout", "watch reconciliation did not converge within its pass budget", { details: { operation: "scan" } });
  };
  const pump = () => {
    if (active || terminal || failure !== undefined) return;
    // Enroll the operation before any user callback or asynchronous acquisition.
    active = Promise.resolve().then(async () => {
      while (!terminal && failure === undefined) {
        const g = current;
        const waiter = g.waiter;
        try {
          await observe(g);
          check(g);
          waiter.resolve();
        } catch (error) {
          waiter.reject(error);
          if (!g.abort.signal.aborted && current === g && !terminal) lose(error);
          try { await retireBackend(); } catch (closeError) { retain(closeError); }
        }
        if (current === g) break;
        await retireBackend();
        snapshot = undefined;
      }
    }).catch(lose).finally(() => {
      active = undefined;
      if (!terminal && failure === undefined) {
        if (!current.waiter.settled) pump(); else scheduleInterval();
      }
    });
  };
  const request = (): Promise<void> => {
    if (terminal) return Promise.reject(retired());
    if (failure !== undefined) return Promise.reject(failure);
    clearTimeout(timer); timer = undefined;
    if (current.waiter.settled) current.waiter = deferred();
    if (!active) pump();
    return current.waiter.promise;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    terminal = true;
    current.abort.abort(retired());
    current.waiter.reject(retired());
    clearTimers();
    options.signal?.removeEventListener("abort", abort);
    state = "closing";
    // Start physical stop immediately, without waiting behind an in-flight scan.
    const stopped = backend?.close();
    void stopped?.catch(() => {});
    closing = Promise.resolve().then(async () => {
      await active;
      try { await stopped; } catch (error) { retain(error); }
      try { await retireBackend(); } catch (error) { retain(error); }
      state = "closed";
      if (failure !== undefined) throw failure;
    });
    void closing.catch(() => {});
    return closing;
  };
  const abort = () => { void close(); };
  const subscription: WatchSubscription = {
    ready, health, close, [Symbol.asyncDispose]: close,
    reconcile: request,
    update(scopes) {
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
      void backend?.close().catch(() => {});
      clearTimers();
      state = "starting";
      // If idle, retire the old worker before the next scan can admit anything.
      if (!active) {
        active = retireBackend().catch(lose).finally(() => {
          active = undefined; snapshot = undefined; pump();
        });
      }
      return next.waiter.promise;
    },
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort(); else pump();
  return subscription;
}
