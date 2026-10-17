import path from "node:path";
import type { RootEntryObservation } from "./root-directory-list-types.js";
import { type RootContext } from "./root-context.js";
import { watchRootCurrent as assertRootIdentityCurrent, watchStats, watchYield } from "./watch-io.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { FsSafeError } from "./errors.js";
import type { WatchSnapshot } from "./watch-scan.js";
import type { WatchOptions } from "./watch-types.js";

export type WatchObservation = RootEntryObservation;
/** Do not retain or clone unused Stats fields for every cached entry. */
export function watchObservation(stat: WatchObservation): WatchObservation {
  const { dev, ino, mode, nlink, size, mtimeNs, ctimeNs } = stat;
  return { dev, ino, mode, nlink, size, mtimeNs, ctimeNs };
}
export const sameWatchObservation = (a: WatchObservation, b: WatchObservation): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const parent = (name: string) => path.dirname(name) === "." ? "" : path.dirname(name);
const preciseTimestamp = (stat: WatchObservation) => stat.mtimeNs % 1_000_000n !== 0n || stat.ctimeNs % 1_000_000n !== 0n;

/** Advisory only: these stats can suppress unchanged work, never admit new names or authority. */
export type WatchProbe = { reuse: Set<string>; stable: boolean };
export async function probeWatchSnapshot(root: RootContext, snapshot: WatchSnapshot, signal: AbortSignal,
  exclude?: WatchOptions["exclude"]): Promise<WatchProbe | undefined> {
  if (!snapshot.observations || snapshot.structural?.size || snapshot.overflow) return;
  await assertRootIdentityCurrent(root);
  const checkpoint = watchYield();
  const unchanged = new Set<string>();
  for (const name of snapshot.listed?.keys() ?? []) { unchanged.add(name); await checkpoint(); }
  // Timestamp storage precision does not prove clock update frequency (notably
  // on NTFS). Re-list recent observations until their update quantum has passed.
  let stable = !snapshot.unsettled?.size;
  for (const name of snapshot.unsettled ?? []) { unchanged.delete(name); await checkpoint(); }
  const settledBefore = BigInt(Date.now() - 1000) * 1_000_000n;
  const recent = (value: WatchObservation) => value.mtimeNs > settledBefore || value.ctimeNs > settledBefore;
  // A single valid timestamp may happen to be millisecond-aligned (common on
  // NTFS). Classify resolution per device, using only prior guarded observations.
  const preciseDevices = new Set<bigint>();
  for (const observed of snapshot.observations.values()) {
    if (preciseTimestamp(observed)) preciseDevices.add(observed.dev);
    await checkpoint();
  }
  try {
    // Parents first, including inside each worker batch. A persistent redirect
    // aborts before probing descendants; all returned metadata stays advisory.
    for await (const [name, previous, current] of observations(root, snapshot, true, signal)) {
      if (!preciseDevices.has(previous.dev) || current.mtimeNs < previous.mtimeNs || current.ctimeNs < previous.ctimeNs) return;
      if (recent(previous) || !sameWatchObservation(previous, current)) { stable = false; unchanged.delete(name); unchanged.delete(parent(name)); }
    }
    for await (const [name, previous, current] of observations(root, snapshot, false, signal)) {
      if (!preciseDevices.has(previous.dev) || current.mtimeNs < previous.mtimeNs || current.ctimeNs < previous.ctimeNs) return;
      if (recent(previous) || !sameWatchObservation(previous, current)) { stable = false; unchanged.delete(parent(name)); }
    }
  } catch (error) { signal.throwIfAborted(); await assertRootIdentityCurrent(root); return; }
  if (exclude) for (const [name, previous] of snapshot.observations) {
    await checkpoint();
    if (!snapshot.entries.has(name) && !snapshot.excluded?.has(name) || !name) continue;
    // Preserve dynamic exclusion callbacks even when no filesystem entry changed.
    const kind = (previous.mode & 0o170000n) === 0o040000n ? "directory" :
      (previous.mode & 0o170000n) === 0o100000n ? "file" : (previous.mode & 0o170000n) === 0o120000n ? "symlink" : "other";
    let excluded;
    try {
      excluded = exclude({ path: name, kind });
      assertSynchronousCallbackResult(excluded, "watch exclude");
    } catch (cause) { throw new FsSafeError("helper-failed", "watch exclusion callback failed", { cause, details: { operation: "callback" } }); }
    signal.throwIfAborted();
    if (Boolean(excluded) !== snapshot.excluded?.has(name)) return;
  }
  await assertRootIdentityCurrent(root);
  return { reuse: unchanged, stable };
}

/** Fence reused directory observations after traversal, including ancestors swapped during leaf probes. */
export async function verifyWatchReuse(root: RootContext, snapshot: WatchSnapshot, reused: Set<string>, signal: AbortSignal): Promise<boolean> {
  try {
    for await (const [name, previous, current] of observations(root, snapshot, true, signal)) {
      if (!sameWatchObservation(previous, current) && reused.has(name)) return false;
    }
  } catch { signal.throwIfAborted(); await assertRootIdentityCurrent(root); return false; }
  await assertRootIdentityCurrent(root);
  return true;
}

async function* observations(root: RootContext, snapshot: WatchSnapshot, directories: boolean, signal: AbortSignal) {
  let batch: [string, WatchObservation][] = [];
  const read = async function* () {
    signal.throwIfAborted();
    const stats = await watchStats(root, batch.map(([name, previous]) => ({
      path: directories ? snapshot.directoryPaths!.get(name)! : path.join(root.rootReal, name),
      dev: previous.dev, ino: previous.ino, directory: directories,
    })));
    for (let n = 0; n < batch.length; n++) yield [batch[n]![0], batch[n]![1], stats[n]!] as const;
  };
  const checkpoint = watchYield();
  const names = directories ? snapshot.directories.keys() : snapshot.observations!.keys();
  for (const name of names) {
    await checkpoint();
    if (!directories && snapshot.directories.has(name)) continue;
    const previous = snapshot.observations!.get(name);
    if (!previous) throw new Error("missing guarded watch observation");
    batch.push([name, previous]);
    if (batch.length === 32) { yield* read(); batch = []; }
  }
  if (batch.length) yield* read();
}
