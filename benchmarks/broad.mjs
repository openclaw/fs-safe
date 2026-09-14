import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export async function registerBroad({ api: a, workspace: w, register: add, onCleanup }) {
  for (const depth of [0, 8, 32]) {
    const base = path.join(w, "lexical", ...Array.from({ length: depth }, (_, i) => `level-${i}`));
    const scope = a.pathScope(base, { label: "benchmark" });
    const store = a.fileStore({ rootDir: base });
    add(`PathScope.resolve/depth=${depth}`, () => scope.resolve("group/value"), {
      sync: true, batch: 100, verify: result => assert.equal(result.path, path.join(base, "group/value")),
    });
    add(`FileStore.path/depth=${depth}`, () => store.path("group/value"), {
      sync: true, batch: 100, verify: result => assert.equal(result, path.join(base, "group/value")),
    });
    for (const count of [100, 1000]) {
      const names = Array.from({ length: count }, (_, i) => `group-${i % 10}/value-${i}`);
      add(`PathScope.resolveAll/count=${count}/depth=${depth}`, () => scope.resolveAll(names), {
        sync: true, divisor: 10, verify: result => assert.deepEqual(result.paths, names.map(name => path.join(base, name))),
      });
    }
  }

  const directoryRoot = path.join(w, "broad-directories"), wide = path.join(directoryRoot, "wide");
  fs.mkdirSync(wide, { recursive: true });
  const names = Array.from({ length: 1000 }, (_, i) => `entry-${i}`);
  for (const name of names) fs.writeFileSync(path.join(wide, name), "x");
  const sorted = [...names].sort();
  const root = await a.root(directoryRoot);
  for (const withFileTypes of [false, true]) {
    add(`Root.list/1000/metadata=${withFileTypes}`, () => root.list("wide", { withFileTypes }), {
      divisor: 100, verify: entries => assert.deepEqual(withFileTypes ? entries.map(entry => entry.name) : entries, sorted),
    });
  }
  for (const order of ["filesystem", "sorted"]) {
    add(`Root.entries/1000/${order}`, async () => {
      const result = []; for await (const entry of root.entries("wide", { order, maxEntries: 1000 })) result.push(entry.name);
      return result;
    }, { divisor: 100, verify: result => assert.deepEqual(order === "sorted" ? result : result.sort(), sorted) });
    add(`Root.entries/first-of-1000/${order}`, async () => {
      for await (const entry of root.entries("wide", { order, maxEntries: 1000 })) return entry.name;
    }, { divisor: 100, verify: name => assert.ok(names.includes(name)) });
    add(`Root.walk/1000/${order}`, async () => {
      const result = []; for await (const entry of root.walk("wide", { order, maxEntries: 1000, symlinkPolicy: "skip" })) result.push(entry);
      return result;
    }, { divisor: 100, verify: entries => {
      assert.equal(entries.length, 1000); assert.ok(entries.every(entry => entry.kind === "file" && entry.size === 1));
    } });
  }
  const deepName = Array.from({ length: 8 }, (_, i) => `level-${i}`).join("/");
  fs.mkdirSync(path.join(directoryRoot, deepName), { recursive: true });
  fs.writeFileSync(path.join(directoryRoot, deepName, "value"), "fixture");
  add("Root.resolve/depth=8", () => root.resolve(`${deepName}/value`), {
    verify: value => assert.equal(value, path.join(directoryRoot, deepName, "value")),
  });

  for (const privateMode of [false, true]) {
    const storeRoot = path.join(w, `broad-store-${privateMode}`);
    fs.mkdirSync(storeRoot, { mode: 0o700 });
    const store = a.fileStore({ rootDir: storeRoot, private: privateMode });
    for (const size of [128, 64 * 1024, 1024 * 1024]) {
      const payload = Buffer.alloc(size, 42), key = `value-${size}`;
      fs.writeFileSync(path.join(storeRoot, key), payload, { mode: 0o600 });
      add(`FileStore.readBytes/private=${privateMode}/${size}`, () => store.readBytes(key), {
        divisor: 10, verify: bytes => assert.ok(bytes.equals(payload)),
      });
      for (const durable of [false, true]) add(`FileStore.write/private=${privateMode}/${size}/durable=${durable}`,
        () => store.write(key, payload, { durable }), {
          divisor: 100, verify: () => assert.ok(fs.readFileSync(path.join(storeRoot, key)).equals(payload)),
        });
    }
  }
  const jsonFile = path.join(w, "broad-json.json");
  const json = a.jsonStore({ filePath: jsonFile, durable: false });
  const document = { revision: 0, items: Array.from({ length: 1000 }, (_, id) => ({ id, text: "x".repeat(100) })) };
  await json.write(document);
  const verifyDocument = value => assert.equal(value.items.length, document.items.length);
  add("JsonStore.readRequired/1000-items", () => json.readRequired(), { divisor: 10, verify: verifyDocument });
  add("JsonStore.update/1000-items", () => json.update(value => ({ ...value, revision: value.revision + 1 })), {
    divisor: 100, verify: verifyDocument,
  });
  add("JsonStore.update/concurrent-8", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => json.update(value => ({ ...value, revision: value.revision + 1 }))));
    return results.map(value => value.revision);
  }, { divisor: 100, verify: revisions => {
    revisions.sort((a, b) => a - b);
    assert.deepEqual(revisions, Array.from({ length: 8 }, (_, i) => revisions[0] + i));
    assert.equal(JSON.parse(fs.readFileSync(jsonFile, "utf8")).revision, revisions.at(-1));
  } });

  const lockDir = path.join(w, "broad-locks"); fs.mkdirSync(lockDir);
  const manager = a.createFileLockManager(`broad:${w}`);
  onCleanup(() => manager.drain());
  const lockOptions = { payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
    timeoutMs: 30_000, retry: { retries: 1000, factor: 1, minTimeout: 1, maxTimeout: 1, randomize: false } };
  for (const contended of [false, true]) {
    add(`FileLockManager.withLock/${contended ? "contended" : "distinct"}-8`, async () => {
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
        manager.withLock(path.join(lockDir, contended ? "shared" : `target-${i}`), lockOptions, async () => i)));
      for (const result of results) if (result.status === "rejected") throw result.reason;
      return results.map(result => result.value);
    }, { divisor: 100, verify: result => assert.deepEqual(result, Array.from({ length: 8 }, (_, i) => i)) });
  }
  const asyncLock = a.createAsyncLock();
  add("createAsyncLock/contended-32", async () => {
    let next = 0;
    return await Promise.all(Array.from({ length: 32 }, () => asyncLock(async () => next++)));
  }, { verify: values => assert.deepEqual(values, Array.from({ length: 32 }, (_, i) => i)) });

  const queueDir = path.join(w, "broad-queue"), failedDir = path.join(w, "broad-failed");
  await a.ensureJsonDurableQueueDirs({ queueDir, failedDir });
  const queuePaths = Array.from({ length: 100 }, (_, id) => a.resolveJsonDurableQueueEntryPaths(queueDir, `entry-${id}`));
  for (const resumed of [false, true]) {
    add(`loadPendingJsonDurableQueueEntries/100${resumed ? "-resumed" : ""}`, () => a.loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "bench" }), {
      divisor: 100,
      before: async () => {
        for (const [id, paths] of queuePaths.entries()) fs.writeFileSync(paths.jsonPath, JSON.stringify({ id }));
        if (resumed) {
          const claimed = await a.loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "bench" });
          assert.equal(claimed.length, queuePaths.length);
        }
      },
      verify: entries => assert.deepEqual(entries.map(entry => entry.id).sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i)),
      after: async () => { for (const paths of queuePaths) await a.ackJsonDurableQueueEntry(paths); },
    });
  }
}
