import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { FsSafeError } from "./errors.js";
import type { WatchSnapshot } from "./watch-scan.js";
import type { WatchOptions } from "./watch-types.js";

export type WatchObservation = Pick<BigIntStats, "dev" | "ino" | "mode" | "nlink" | "size" | "mtimeNs" | "ctimeNs">;
export const sameWatchObservation = (a: WatchObservation, b: WatchObservation): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const parent = (name: string) => path.dirname(name) === "." ? "" : path.dirname(name);
// Copied files often preserve whole-second mtimes on a high-resolution filesystem.
// A precise ctime still detects edits; require the full pass only when both are coarse.
const coarse = (stat: WatchObservation) => stat.mtimeNs % 1_000_000n === 0n && stat.ctimeNs % 1_000_000n === 0n;

/** Advisory only: these stats can suppress unchanged work, never admit new names or authority. */
export async function probeWatchSnapshot(root: RootContext, snapshot: WatchSnapshot, signal: AbortSignal,
  exclude?: WatchOptions["exclude"]): Promise<Set<string> | undefined> {
  if (!snapshot.observations || snapshot.structural?.size || snapshot.overflow) return;
  await assertRootIdentityCurrent(root);
  const unchanged = new Set(snapshot.listed?.keys());
  let count = 0;
  try {
    // Parents first: a persistent redirect stops the probe before descendant I/O.
    for (const [name, identity] of snapshot.directories) {
      signal.throwIfAborted();
      const previous = snapshot.observations.get(name);
      if (!previous || coarse(previous)) return;
      const current = fs.lstatSync(snapshot.directoryPaths!.get(name)!, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino ||
        current.mtimeNs < previous.mtimeNs || current.ctimeNs < previous.ctimeNs) return;
      if (!sameWatchObservation(previous, current)) { unchanged.delete(name); unchanged.delete(parent(name)); }
      if (++count % 64 === 0) await yieldToEventLoop();
    }
    for (const [name, previous] of snapshot.observations) {
      if (snapshot.directories.has(name)) continue;
      signal.throwIfAborted();
      const current = fs.lstatSync(path.join(root.rootReal, name), { bigint: true });
      if (coarse(previous) || current.dev !== previous.dev || current.ino !== previous.ino ||
        current.mtimeNs < previous.mtimeNs || current.ctimeNs < previous.ctimeNs) return;
      if (!sameWatchObservation(previous, current)) unchanged.delete(parent(name));
      if (++count % 64 === 0) await yieldToEventLoop();
    }
  } catch (error) { signal.throwIfAborted(); await assertRootIdentityCurrent(root); return; }
  if (exclude) for (const [name, previous] of snapshot.observations) {
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
  return unchanged;
}

/** Fence reused directory observations after traversal, including ancestors swapped during leaf probes. */
export async function verifyWatchReuse(root: RootContext, snapshot: WatchSnapshot, reused: Set<string>, signal: AbortSignal): Promise<boolean> {
  let count = 0;
  try {
    for (const [name] of snapshot.directories) {
      signal.throwIfAborted();
      const previous = snapshot.observations?.get(name);
      if (!previous) return false;
      const current = fs.lstatSync(snapshot.directoryPaths!.get(name)!, { bigint: true });
      if (!sameWatchObservation(previous, current) && reused.has(name)) return false;
      if (current.dev !== previous.dev || current.ino !== previous.ino || !current.isDirectory() || current.isSymbolicLink()) return false;
      if (++count % 64 === 0) await yieldToEventLoop();
    }
  } catch { signal.throwIfAborted(); await assertRootIdentityCurrent(root); return false; }
  await assertRootIdentityCurrent(root);
  return true;
}
