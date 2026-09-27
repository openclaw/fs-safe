import assert from "node:assert/strict";
import path from "node:path";
import { below, selectedDepth } from "./model-operations.mjs";

export const sorted = map => [...map].sort(([a], [b]) => a.localeCompare(b));
// Listings admit literal entries, never following a symbolic parent or leaf.
export async function guardedSnapshot(capability, scopes) {
  const result = new Map();
  async function entry(name) {
    if (!name) return { isDirectory: true };
    let parent = "", found;
    for (const part of name.split(path.sep)) {
      const entries = await capability.list(parent ? "./" + parent : "", { withFileTypes: true });
      found = entries.find(item => item.name === part);
      if (!found) return;
      parent = path.join(parent, part);
      if (parent !== name && (found.isSymbolicLink || !found.isDirectory)) return;
    }
    return found;
  }
  async function visit(name, depth, known) {
    const item = known ?? await entry(name);
    if (!item) return;
    const kind = item.isSymbolicLink ? "symlink" : item.isDirectory ? "directory" : item.isFile ? "file" : "other";
    result.set(name, kind === "file" ? "file:" + Buffer.from(await capability.readBytes("./" + name)).toString("utf8") : kind);
    if (kind === "directory" && depth > 0) {
      for (const child of await capability.list(name ? "./" + name : "", { withFileTypes: true })) {
        await visit(path.join(name, child.name), depth - 1, child);
      }
    }
  }
  for (const scope of scopes) await visit(scope.path, scope.kind === "tree" ? scope.depth ?? 32 : 0);
  return result;
}

export function consumer(capability, subscribe, mode, initialScopes, maxPendingPaths) {
  let scopes = initialScopes, closed = false, epoch = 0, baseline = true;
  const cache = new Map(), pending = [], events = [], health = [];
  let callbackError;
  const subscription = subscribe(capability, {
    mode, scopes, intervalMs: 60_000, maxPendingPaths,
    onHealth(value) { health.push(value); },
    onInvalidate(event) {
      try {
        assert.equal(closed, false, "invalidation after close began");
        if (event.reason === "reconcile" && !event.changes) {
          assert.equal(baseline, true, "superseded or duplicate generation baseline");
          baseline = false;
        }
        for (const change of event.changes ?? []) {
          assert.equal(path.isAbsolute(change.path), false, "absolute change path");
          assert.equal(change.path.split(path.sep).includes(".."), false, "escaping change path");
          assert.equal(change.path.includes("OUTSIDE_SENTINEL"), false, "outside name in change path");
          assert.ok(selectedDepth(scopes, change.path) >= 0, "change from superseded/unselected scope");
        }
        events.push({ epoch, ...event });
        pending.push({ epoch, scopes, event });
      } catch (error) { callbackError ??= error; throw error; }
    },
  });
  return {
    subscription, cache, events, health,
    get scopes() { return scopes; },
    setScopes(next) {
      scopes = next; epoch++; baseline = true;
      return subscription.setScopes(next);
    },
    async flush() {
      if (callbackError) throw callbackError;
      // Only onInvalidate queues work. Checkpoints never manufacture refreshes.
      while (pending.length) {
        const request = pending.shift();
        if (request.epoch !== epoch) continue;
        if (!request.event.changes) {
          const next = await guardedSnapshot(capability, request.scopes);
          cache.clear(); for (const [name, value] of next) cache.set(name, value);
        } else for (const change of request.event.changes) {
          const depth = selectedDepth(request.scopes, change.path);
          assert.ok(depth >= 0);
          const affected = [{ path: change.path, kind: "tree", depth },
            ...request.scopes.filter(scope => below(change.path, scope.path))];
          const next = await guardedSnapshot(capability, affected);
          for (const name of cache.keys()) if (below(change.path, name)) cache.delete(name);
          for (const [name, value] of next) cache.set(name, value);
        }
      }
    },
    async close() { closed = true; await subscription.close(); if (callbackError) throw callbackError; },
  };
}
