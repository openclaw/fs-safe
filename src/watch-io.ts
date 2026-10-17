import { decodeWatchError as decodeError } from "./watch-io-error.js";
import path from "node:path";
import fs, { type BigIntStats } from "node:fs";
import { Worker } from "node:worker_threads";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { FsSafeError } from "./errors.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { assertRootIdentityCurrent, resolvePathInRoot, type RootContext } from "./root-context.js";
import { assertRootDirectoryObservationGuard, createRootDirectoryObservationGuard, openRootDirectoryListing, type RootDirectoryObservationGuard } from "./root-directory-list.js";
import { lookupRootDirectoryEntry } from "./root-directory-entry.js";
import type { WatchObservation } from "./watch-probe.js";
import type { RootDirectoryListingOptions, RootDirectoryListing } from "./root-directory-list-types.js";

const owners = new WeakMap<RootContext, WatchIo>();
const diagnostics = new Set<WatchEndpoint>();
const endpoints = new Map<string, WatchEndpoint>();
let measureIo = false;
/** Internal benchmark support; never enables logging or records pathnames. */
export function enableWatchIoDiagnostics() { measureIo = true; }
export async function watchIoMetrics(): Promise<Record<string, number>> {
  const total: Record<string, number> = {};
  for (const owner of diagnostics) for (const [name, count] of Object.entries(await owner.call<Record<string, number>>(undefined, undefined, "metrics"))) total[name] = (total[name] ?? 0) + count;
  return total;
}
function statMethods(stat: BigIntStats): BigIntStats {
  const kind = stat.mode & 0o170000n;
  return Object.assign(stat, { isDirectory: () => kind === 0o040000n,
    isSymbolicLink: () => kind === 0o120000n, isFile: () => kind === 0o100000n });
}

export class WatchEndpoint {
  private worker: Worker;
  private next = 0;
  private failure: unknown;
  private requests = new Map<number, { resolve(value: any): void; reject(error: unknown): void; cleanup?: (error: unknown) => void }>();
  references = 0;
  persistent = 0;
  constructor() {
    const module = new URL("./watch-io-worker.js", import.meta.url);
    // Default inheritance handles V8/process flags correctly. A data-URL entry
    // also lets eval/STDIN callers retain --input-type without applying it to a file.
    const entry = process.execArgv.some(arg => arg === "--input-type" || arg.startsWith("--input-type="))
      ? new URL(`data:text/javascript,${encodeURIComponent(`import ${JSON.stringify(module.href)};`)}`) : module;
    this.worker = new Worker(entry, {
      // Replies are short-lived; bound nursery growth without capping retained listings.
      resourceLimits: { maxYoungGenerationSizeMb: 4 },
      workerData: { native: getFsSafeNativeConfig(), diagnostics: measureIo },
    });
    this.worker.on("message", ({ id, value, error, failed, cleanupErrors }) => {
      const request = this.requests.get(id);
      this.requests.delete(id);
      const failure = failed ? decodeError(error) : undefined;
      for (const item of cleanupErrors ?? []) request?.cleanup?.(item === error ? failure : decodeError(item));
      if (failed) request?.reject(failure); else request?.resolve(value);
      this.updateRef();
    });
    const fail = (cause: unknown) => {
      this.failure = new FsSafeError("helper-failed", "watch observation worker stopped", { cause });
      for (const request of this.requests.values()) request.reject(this.failure);
      this.requests.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", code => fail(new Error(`watch observation worker exited (${code})`)));
    this.updateRef();
  }
  updateRef() { if (this.persistent || this.requests.size) this.worker.ref(); else this.worker.unref(); }
  call<T>(root: RootContext | undefined, cleanup: ((error: unknown) => void) | undefined, method: string, ...args: unknown[]): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.requests.set(id, { resolve, reject, cleanup });
      this.worker.ref();
      try { this.worker.postMessage({ id, method, args, root }); }
      catch (error) { this.requests.delete(id); reject(error); }
    });
  }
  async close() { await this.worker.terminate(); }
}

class WatchIo {
  private root: RootContext;
  constructor(private endpoint: WatchEndpoint, root: RootContext, private cleanup?: (error: unknown) => void) {
    this.root = { rootDir: root.rootDir, rootReal: root.rootReal, rootWithSep: root.rootWithSep, rootIdentity: root.rootIdentity };
  }
  call<T>(method: string, ...args: unknown[]) { return this.endpoint.call<T>(this.root, this.cleanup, method, ...args); }
}

export function createWatchIo(root: RootContext, persistent: boolean, cleanup?: (error: unknown) => void): () => Promise<void> {
  // Source loaders and alternate runtimes need not implement Node worker module
  // loading. Their fallback uses the same guarded helpers with bounded yields.
  if (!import.meta.url.endsWith(".js") || process.versions.bun || process.versions.deno || getFsSafeTestHooks()) return async () => {};
  const key = `${getFsSafeNativeConfig().mode}:${measureIo}`;
  let endpoint = endpoints.get(key);
  if (!endpoint) {
    endpoint = new WatchEndpoint(); endpoints.set(key, endpoint);
    if (measureIo) diagnostics.add(endpoint);
  }
  endpoint.references++; if (persistent) endpoint.persistent++; endpoint.updateRef();
  owners.set(root, new WatchIo(endpoint, root, cleanup));
  return async () => {
    owners.delete(root);
    endpoint!.references--; if (persistent) endpoint!.persistent--; endpoint!.updateRef();
    if (!endpoint!.references) {
      endpoints.delete(key); diagnostics.delete(endpoint!); await endpoint!.close();
    }
  };
}
export async function watchRootCurrent(root: RootContext): Promise<void> {
  const owner = owners.get(root);
  if (owner) await owner.call("root"); else await checkWatchRoot(root);
}
/** An unchanged inode alone cannot detect a relocated ancestor above the Root. */
export async function checkWatchRoot(root: RootContext): Promise<void> {
  await assertRootIdentityCurrent(root);
  const guard = await createRootDirectoryObservationGuard(root, root.rootReal);
  await assertRootDirectoryObservationGuard(root, guard);
}
export async function watchResolve(root: RootContext, name: string, options: Parameters<typeof resolvePathInRoot>[2]) {
  const owner = owners.get(root);
  if (owner) return owner.call<Awaited<ReturnType<typeof resolvePathInRoot>>>("resolve", name, options);
  await yieldToEventLoop();
  return resolvePathInRoot(root, name, options);
}
export async function watchGuard(root: RootContext, name: string): Promise<RootDirectoryObservationGuard> {
  const owner = owners.get(root);
  if (!owner) { await yieldToEventLoop(); return createRootDirectoryObservationGuard(root, name); }
  const guard = await owner.call<RootDirectoryObservationGuard>("guard", name);
  statMethods(guard.stat);
  return guard;
}
export async function watchAssert(root: RootContext, guard: RootDirectoryObservationGuard): Promise<void> {
  const owner = owners.get(root);
  if (owner) await owner.call("assert", { ...guard, stat: { ...guard.stat, isDirectory: undefined, isSymbolicLink: undefined, isFile: undefined } });
  else { await yieldToEventLoop(); await assertRootDirectoryObservationGuard(root, guard); }
}
export async function watchLookup(root: RootContext, guard: RootDirectoryObservationGuard, name: string, exact = false) {
  const owner = owners.get(root);
  return owner ? owner.call<Awaited<ReturnType<typeof lookupRootDirectoryEntry>>>("lookup",
    { ...guard, stat: { ...guard.stat, isDirectory: undefined, isSymbolicLink: undefined, isFile: undefined } }, name, exact) : lookupRootDirectoryEntry(root, guard, name, exact);
}
export type WatchStatRequest = { path: string; dev: bigint; ino: bigint; directory: boolean };
export function checkedWatchStat(request: WatchStatRequest): BigIntStats {
  const current = fs.lstatSync(request.path, { bigint: true });
  if (current.dev !== request.dev || current.ino !== request.ino ||
    (request.directory && (!current.isDirectory() || current.isSymbolicLink()))) {
    throw new FsSafeError("path-mismatch", "watch metadata identity changed");
  }
  return current;
}
export async function watchStats(root: RootContext, requests: WatchStatRequest[]): Promise<WatchObservation[]> {
  const owner = owners.get(root);
  if (owner) return owner.call<WatchObservation[]>("stat", requests);
  const result: BigIntStats[] = [];
  for (const request of requests) { await yieldToEventLoop(); result.push(checkedWatchStat(request)); }
  return result;
}
export async function watchListing(root: RootContext, name: string, options: RootDirectoryListingOptions, remaining: () => number): Promise<RootDirectoryListing> {
  const owner = owners.get(root);
  if (!owner) {
    const listing = await openRootDirectoryListing(root, name, options);
    return { ...listing, async next() { await yieldToEventLoop(); return listing.next(); } };
  }
  const { admitEntry, signal, onCleanupFailure, previousPaths: _hostPaths, ...wire } = options;
  const opened = await owner.call<{ id: number; paths: RootDirectoryListing["paths"] }>("open", name, wire);
  return {
    paths: opened.paths,
    assertCurrent: () => owner.call<void>("current", opened.id),
    async next() {
      signal?.throwIfAborted();
      const { entry, consumed, entryError, failed } = await owner.call<{ entry: Awaited<ReturnType<RootDirectoryListing["next"]>>; consumed: number; entryError?: unknown; failed?: boolean }>("next", opened.id, remaining());
      for (let n = 0; n < consumed; n++) {
        admitEntry();
        if (n % 32 === 31) { await yieldToEventLoop(); signal?.throwIfAborted(); }
      }
      if (failed) throw decodeError(entryError);
      if (entry?.kind === "entry") opened.paths.names.set(entry.entry.name, path.join(name, entry.entry.name));
      return entry;
    },
    async [Symbol.asyncDispose]() { try { await owner.call("close", opened.id); } catch (error) { onCleanupFailure?.(error); throw error; } },
  };
}

/** Bound pure JS loops and the source/alternate-runtime observation fallback. */
export function watchYield() {
  let count = 0;
  return async () => { if (++count % 32 === 0) await yieldToEventLoop(); };
}
