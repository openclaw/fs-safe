import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "../../dist/root.js";
import { watch } from "../../dist/watch.js";

export { assert, fs, os, path, delay, root, watch };
export const wholeTree = [{ path: "", kind: "tree" }];
export const errorInfo = error => ({ name: error?.name, code: error?.code, message: error?.message, stack: error?.stack });
export const diagnostics = { invalidations: 0, overflows: 0, unavailable: undefined, cleanupErrors: [] };
export async function cleanup(...phases) {
  for (const phase of phases) for (const outcome of await Promise.allSettled(phase.map(action => Promise.resolve().then(action)))) {
    if (outcome.status === "rejected") diagnostics.cleanupErrors.push(errorInfo(outcome.reason));
  }
}
const digest = data => createHash("sha256").update(data).digest("hex");
const below = (parent, child) => !parent || child === parent || child.startsWith(parent + path.sep);
const missing = error => ["ENOENT", "ENOTDIR", "not-found", "not-file"].includes(error?.code);

export async function truthWalk(directory, scopes = wholeTree) {
  const result = new Map();
  async function visit(relative, depth) {
    const full = path.join(directory, relative);
    let entry;
    try { entry = await fs.lstat(full); } catch (error) { if (missing(error)) return; throw error; }
    const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
    result.set(relative, kind === "file" ? "file:" + digest(await fs.readFile(full)) : kind);
    if (kind === "directory" && depth > 0) for (const name of await fs.readdir(full)) {
      await visit(path.join(relative, name), depth - 1);
    }
  }
  for (const scope of scopes) await visit(scope.path, scope.kind === "tree" ? scope.depth ?? 32 : 0);
  return result;
}

export function compare(cache, truth) {
  const differences = [...new Set([...cache.keys(), ...truth.keys()])]
    .filter(name => cache.get(name) !== truth.get(name));
  assert.equal(differences.length, 0, `consumer cache diverged: ${JSON.stringify(differences.slice(0, 20))} (${differences.length} paths)`);
}

export async function fixture(prefix = "fixture") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `fs-safe-stress-${prefix}-`));
  return { directory, capability: await root(directory), async remove() { await fs.rm(directory, { recursive: true, force: true }); } };
}

// This cache has exactly one source of refresh requests: onInvalidate.
// Coalescing bounds consumer work without silently turning checkpoints into scans.
export function observe(f, options = {}) {
  let scopes = options.scopes ?? wholeTree;
  const cache = new Map();
  const metrics = { invalidations: 0, overflows: 0, wholeInvalidations: 0, consumerReadErrors: 0, checkpoints: 0 };
  const pending = new Set();
  let all = false, draining, callbackFailure, readsAfterClose = false, unavailable = false;
  const listeners = new Set();
  async function admittedEntry(relative) {
    const segments = relative.split(path.sep);
    let parent = "", found;
    for (let n = 0; n < segments.length; n++) {
      const entries = await f.capability.list(parent ? "./" + parent : "", { withFileTypes: true });
      found = entries.find(entry => entry.name === segments[n]);
      if (!found) return;
      if (n < segments.length - 1 && (found.isSymbolicLink || !found.isDirectory)) return;
      parent = path.join(parent, segments[n]);
    }
    return found;
  }
  async function snapshot(relative, depth, target, known) {
    let entry = known;
    if (!relative) entry = { isDirectory: true };
    else if (!entry) {
      entry = await admittedEntry(relative);
      if (!entry) return;
    }
    const kind = entry.isSymbolicLink ? "symlink" : entry.isDirectory ? "directory" : entry.isFile ? "file" : "other";
    target.set(relative, kind === "file" ? "file:" + digest(await f.capability.readBytes("./" + relative)) : kind);
    if (kind === "directory" && depth > 0) {
      for (const child of await f.capability.list(relative ? "./" + relative : "", { withFileTypes: true })) {
        const childPath = path.join(relative, child.name);
        await snapshot(childPath, depth - 1, target, child);
      }
    }
  }
  async function refresh(relative, depth) {
    const next = new Map();
    await snapshot(relative, depth, next);
    for (const name of cache.keys()) if (below(relative, name)) cache.delete(name);
    for (const [name, value] of next) cache.set(name, value);
  }
  function schedule() {
    if (draining) return;
    draining = Promise.resolve().then(async () => {
      while (all || pending.size) {
        const everything = all, names = [...pending];
        all = false; pending.clear();
        try {
          if (everything) {
            const next = new Map();
            for (const scope of scopes) {
              await snapshot(scope.path, scope.kind === "tree" ? scope.depth ?? 32 : 0, next);
            }
            cache.clear(); for (const [name, value] of next) cache.set(name, value);
          } else for (const name of names) {
            const selected = scopes.find(scope => scope.path === name || (scope.kind === "tree" && below(scope.path, name)));
            if (selected) {
              const distance = selected.path === name ? 0 : (selected.path ? name.slice(selected.path.length + 1) : name).split(path.sep).length;
              await refresh(name, selected.kind === "tree" ? Math.max(0, (selected.depth ?? 32) - distance) : 0);
            }
          }
        } catch (error) {
          metrics.consumerReadErrors++;
          metrics.lastConsumerReadError = errorInfo(error);
          if (unavailable || readsAfterClose) return;
          if (!["path-mismatch", "symlink", "outside-workspace", "not-file", "not-found", "ENOENT", "ENOTDIR", "EBUSY"].includes(error?.code)) {
            callbackFailure ??= error; return;
          }
          // Preserve unfinished callback-requested work. This never adds work at
          // a checkpoint or retries a failed comparison; it settles guarded reads.
          if (everything) all = true;
          else for (const name of names) pending.add(name);
          await delay(25);
        }
      }
    }).finally(() => {
      draining = undefined;
      if ((all || pending.size) && !unavailable && !callbackFailure) schedule();
    });
  }
  const subscription = watch(f.capability, {
    ...options, mode: "events", scopes,
    onHealth(value) {
      if (value.state === "unavailable") { unavailable = true; all = false; pending.clear(); }
      diagnostics.lastHealth = { state: value.state, directories: value.directories };
      if (value.state === "unavailable") diagnostics.unavailable ??= { ...diagnostics.lastHealth,
        failure: { operation: value.failure?.operation, code: value.failure?.code, error: errorInfo(value.failure?.error) } };
      options.onHealth?.(value);
    },
    onInvalidate(event) {
      try {
        assert.equal(readsAfterClose, false, "callback delivered after close");
        metrics.invalidations++;
        diagnostics.invalidations++;
        if (event.reason === "overflow") { metrics.overflows++; assert.equal(event.changes, undefined); }
        if (event.reason === "overflow") diagnostics.overflows++;
        for (const change of event.changes ?? []) assert.equal(change.path.includes("OUTSIDE_SENTINEL"), false, "outside name published");
        if (!event.changes) { all = true; pending.clear(); metrics.wholeInvalidations++; }
        else if (!all) for (const change of event.changes) {
          pending.add(change.path);
          if (pending.size > 4096) { all = true; pending.clear(); break; }
        }
        schedule();
        for (const listener of listeners) listener(event);
        options.onInvalidate?.(event);
      } catch (error) { callbackFailure ??= error; throw error; }
    },
  });
  return {
    subscription, cache, metrics, listeners,
    async flush() {
      let timer;
      try {
        await Promise.race([(async () => { while (draining) await draining; })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("consumer refresh did not settle in 120 seconds")), 120_000); })]);
        if (callbackFailure) throw callbackFailure;
      } finally { clearTimeout(timer); }
    },
    async checkpoint() {
      await delay(300); // A settling interval, not an oracle retry.
      await subscription.reconcile();
      await this.flush();
      compare(cache, await truthWalk(f.directory, scopes)); metrics.checkpoints++;
      assert.equal(subscription.health().failure, undefined);
    },
    async setScopes(next) { scopes = next; return subscription.setScopes(next); },
    async close() { await subscription.close(); readsAfterClose = true; await this.flush(); },
  };
}

export async function populate(f, directories, filesPerDirectory) {
  for (let d = 0; d < directories; d++) {
    const directory = path.join(f.directory, "dir-" + d);
    await fs.mkdir(directory);
    await Promise.all(Array.from({ length: filesPerDirectory }, (_, n) => fs.writeFile(path.join(directory, "file-" + n), `initial-${d}-${n}`)));
  }
}

export async function isolatedEdit(f, observer, sequence) {
  const value = `isolated-${sequence}`;
  const begin = performance.now();
  let resolve;
  const notified = new Promise(done => { resolve = done; });
  const expected = "file:" + digest(Buffer.from(value));
  const listener = event => {
    if (!event.changes || event.changes.some(change => change.path === "latency")) {
      void observer.flush().then(() => {
        if (observer.cache.get("latency") === expected) resolve(performance.now() - begin);
      }).catch(() => resolve(undefined));
    }
  };
  observer.listeners.add(listener);
  const timer = setTimeout(() => resolve(undefined), 10_000);
  try {
    await fs.writeFile(path.join(f.directory, "latency"), value);
    const latency = await notified;
    assert.notEqual(latency, undefined, "no event for isolated edit within 10 seconds");
    await observer.flush();
    assert.equal(observer.cache.get("latency"), expected, "isolated edit notification did not refresh cache");
    return latency;
  } finally { clearTimeout(timer); observer.listeners.delete(listener); }
}
