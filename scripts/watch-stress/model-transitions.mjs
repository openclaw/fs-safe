import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRenameWriter } from "./rename-writer.mjs";

const lossObservers = new Map();
export function recordNativeLoss(root, phase) {
  if (phase === "received") {
    const observer = lossObservers.get(root);
    if (observer) observer.losses++;
  }
}

// Native-only diagnosis separates transport latency from the bounded guarded
// passes that every mode promises. The cache is refreshed only by invalidations.
export async function runTransitions({ root, watch }, seed, { mode, maxPendingPaths = 2 + seed % 7, nativeOnly = false, passes = nativeOnly ? 400 : 4 } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "watch-transitions-"));
  const full = name => path.join(temporary, name);
  const writer = createRenameWriter();
  const canonical = await fs.realpath(temporary), native = { losses: 0 };
  lossObservers.set(canonical, native);
  const owners = new Set(), events = [], health = [];
  const observed = new Set(), expected = new Map(), cache = new Map();
  let stage = "setup", pending = false, callbackError, owner, checks = 0;
  const features = { caseAlias: false, normalizationAlias: false, undecodable: process.platform === "linux" };
  try {
    await fs.mkdir(full("anchor"));
    await fs.mkdir(full("other"));
    await fs.writeFile(full("other/steady"), "unchanged");
    await fs.writeFile(full("anchor/Caf\u00e9"), "probe");
    const probe = await fs.stat(full("anchor/Caf\u00e9"), { bigint: true });
    for (const [feature, name] of [["caseAlias", "anchor/CAF\u00c9"], ["normalizationAlias", "anchor/Cafe\u0301"]]) {
      const alias = await fs.stat(full(name), { bigint: true }).catch(() => undefined);
      features[feature] = alias?.dev === probe.dev && alias?.ino === probe.ino;
    }
    await fs.unlink(full("anchor/Caf\u00e9"));
    const selected = path.join("anchor", "caf\u00e9", "missing");
    const actualComponent = seed % 2 && features.caseAlias ? "CAF\u00c9" : features.normalizationAlias ? "cafe\u0301" : "caf\u00e9";
    const actual = path.join("anchor", actualComponent, "missing");
    let scopes = [{ path: selected, kind: "tree", depth: 3 }];
    const capability = await root(temporary);
    const excluded = name => path.basename(name).startsWith(".save-") || name.split(path.sep).includes("excluded");
    const inScope = name => scopes.some(scope => name === scope.path || (scope.kind === "tree" && name.startsWith(scope.path + path.sep) && name.slice(scope.path.length + 1).split(path.sep).length <= scope.depth));
    async function snapshot() {
      const result = new Map();
      for (const scope of scopes) {
        let stat;
        try { stat = await capability.stat("./" + scope.path); }
        catch (error) { if (["not-found", "ENOENT"].includes(error.code)) continue; throw error; }
        if (!stat.isDirectory) { result.set(scope.path, "file:" + await capability.readText("./" + scope.path)); continue; }
        result.set(scope.path, "directory");
        async function visit(directory, depth) {
          if (!depth) return;
          for (const entry of await capability.list("./" + directory, { withFileTypes: true })) {
            const name = path.join(directory, entry.name);
            if (excluded(name)) continue;
            assert.equal(entry.isSymbolicLink, false);
            result.set(name, entry.isDirectory ? "directory" : "file:" + await capability.readText("./" + name));
            if (entry.isDirectory) await visit(name, depth - 1);
          }
        }
        if (scope.kind === "tree") await visit(scope.path, scope.depth);
      }
      return result;
    }
    const sorted = map => [...map].sort(([a], [b]) => a.localeCompare(b));
    async function checkpoint(label, requireEvent = false) {
      stage = label;
      const start = events.length;
      for (let pass = 0; pass < passes; pass++) {
        if (mode === "poll" || !nativeOnly) await owner.reconcile();
        else await delay(25);
        if (callbackError) throw callbackError;
        assert.equal(owner.health().failure, undefined, label);
        if (pending) {
          pending = false;
          const next = await snapshot();
          cache.clear();
          for (const [name, value] of next) { cache.set(name, value); observed.add(name); }
        }
        if (JSON.stringify(sorted(cache)) === JSON.stringify(sorted(expected)) && (!requireEvent || events.length > start)) {
          assert.deepEqual(sorted(await snapshot()), sorted(expected), `reference model: ${label}`);
          checks++; return;
        }
      }
      assert.deepEqual(sorted(cache), sorted(expected), `lost invalidation: ${label}`);
      assert.fail(`missing metadata invalidation: ${label}`);
    }
    function subscribe() {
      owner = watch(capability, { mode, scopes, intervalMs: 60_000, maxPendingPaths,
        exclude: entry => excluded(entry.path),
        onHealth: value => { health.push(value); },
        onInvalidate: event => {
          try {
            if (event.reason === "overflow") {
              const differences = new Set([...cache.keys(), ...expected.keys()].filter(name => cache.get(name) !== expected.get(name))).size;
              assert.ok(native.losses > 0 || differences > maxPendingPaths, `overflow without backend loss or diff exhaustion at ${stage}`);
              native.losses = 0;
            }
            for (const change of event.changes ?? []) {
              assert.ok(inScope(change.path), `outside selection: ${change.path}`);
              assert.equal(excluded(change.path), false, `excluded name: ${change.path}`);
              assert.ok(observed.has(change.path) || expected.has(change.path) || scopes.some(scope => scope.path === change.path), `unobserved name: ${change.path}`);
            }
            events.push({ stage, ...event }); pending = true;
          } catch (error) { callbackError ??= error; throw error; }
        },
      });
      owners.add(owner);
      return owner;
    }
    await subscribe().ready;
    await checkpoint("missing baseline");
    const unrelated = [];
    const other = watch(capability, { mode, scopes: [{ path: path.join("other", "steady"), kind: "entry" }], intervalMs: 60_000,
      onInvalidate: event => { unrelated.push(event); } });
    owners.add(other); await other.ready;
    await fs.writeFile(full("other/steady"), "drain setup activity");
    for (let pass = 0; pass < 8; pass++) { await delay(25); if (mode === "poll") await other.reconcile(); }
    unrelated.length = 0;
    const churn = async () => {
      for (let i = 0; i < 12 + seed % 13; i++) {
        const sibling = full(`anchor/sibling-${i}`);
        await fs.writeFile(sibling, String(seed)); await fs.unlink(sibling);
      }
    };
    if (!features.normalizationAlias) {
      const distinct = path.join("anchor", "cafe\u0301", "missing");
      await fs.mkdir(full(distinct), { recursive: true });
      await fs.writeFile(full(path.join(distinct, "file")), "unselected normalization variant");
      await checkpoint("distinct Unicode missing-descendant variant");
    }
    expected.set(selected, "directory");
    expected.set(path.join(selected, "file"), "file:created");
    await Promise.all([churn(), (async () => {
      await fs.mkdir(full(actual), { recursive: true });
      await fs.writeFile(full(path.join(actual, "file")), "created");
    })()]);
    await checkpoint("missing descendant plus sibling churn");
    // Temp noise exceeds the queue budget, but the selected diff has one entry.
    expected.set(path.join(selected, "file"), "file:atomic replacement");
    await Promise.all([churn(), (async () => {
      const temp = path.join(actual, `.save-${seed}`);
      await fs.writeFile(full(temp), "atomic replacement");
      await writer.rename(full(temp), full(path.join(actual, "file")));
    })()]);
    await checkpoint("atomic save");
    await fs.mkdir(full(path.join(actual, "excluded")));
    await fs.writeFile(full(path.join(actual, "excluded", "private")), "excluded");
    await checkpoint("excluded subtree");
    if (features.undecodable) {
      const bad = Buffer.concat([Buffer.from(full("anchor") + path.sep), Buffer.from([0xff])]);
      await fs.writeFile(bad, "undecodable unselected sibling");
      expected.set(path.join(selected, "file"), "file:after undecodable");
      await fs.writeFile(full(path.join(actual, "file")), "after undecodable");
      await checkpoint("undecodable sibling");
      await fs.unlink(bad);
    }
    if (process.platform !== "win32") {
      await fs.chmod(full(actual), 0o750);
      await checkpoint("directory chmod", true);
    }
    // Retire and replace scopes while a separate owner remains live and quiet.
    const retiring = owner;
    await retiring.close(); owners.delete(retiring);
    await subscribe().ready;
    const superseded = owner.setScopes([{ path: "absent", kind: "tree", depth: 1 }]);
    const replacement = owner.setScopes(scopes);
    await assert.rejects(superseded, { name: "AbortError" }); await replacement;
    await checkpoint("retirement and scope replacement");
    await writer.rename(full(actual), full(path.join("anchor", "retired")));
    expected.clear();
    await checkpoint("watched directory rename");
    await fs.mkdir(full(actual), { recursive: true }); expected.set(selected, "directory");
    await checkpoint("watched directory recreation");
    await fs.rm(full(actual), { recursive: true }); expected.clear();
    await checkpoint("watched directory delete");
    if (features.undecodable) {
      await fs.mkdir(full(actual), { recursive: true }); expected.set(selected, "directory");
      await checkpoint("selected undecodable preparation");
      const bad = Buffer.concat([Buffer.from(full(actual) + path.sep), Buffer.from([0xff])]);
      await fs.writeFile(bad, "selected undecodable child");
      await assert.rejects(owner.reconcile(), { code: "invalid-path" });
      assert.equal(owner.health().state, "unavailable");
      assert.equal(owner.health().failure?.code, "invalid-path");
      await fs.unlink(bad);
      checks++;
    }
    if (mode === "poll") await other.reconcile();
    await delay(100);
    assert.equal(other.health().failure, undefined, "other subscription failed closed");
    assert.ok(["ready", "reconciling"].includes(other.health().state), "other subscription stopped");
    assert.deepEqual(unrelated, [], "cross-subscription invalidation");
    assert.equal(health.some(value => value.state === "unavailable"), features.undecodable);
    return { checks, features, maxPendingPaths, invalidations: events.length, overflows: events.filter(event => event.reason === "overflow").length, ...writer.metrics };
  } catch (cause) {
    throw new Error(`watch transitions seed ${seed}, ${mode}, ${stage}: ${cause.message}`, { cause });
  } finally {
    lossObservers.delete(canonical);
    await Promise.all([...owners].map(owner => owner.close()));
    await fs.rm(temporary, { force: true, recursive: true });
  }
}
