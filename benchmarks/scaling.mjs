import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

async function settledValues(pending) {
  const results = await Promise.allSettled(pending);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map(result => result.value);
}

export async function registerScaling({ api: a, workspace: w, register: add, onCleanup }) {
  const root = await a.root(w), store = a.fileStore({ rootDir: w });
  for (const size of [128, 64 * 1024, 1024 * 1024]) {
    const payload = Buffer.alloc(size, 0x5a), name = `concurrent-read-${size}`;
    fs.writeFileSync(path.join(w, name), payload, { mode: 0o600 });
    for (const concurrency of [1, 8, 32]) {
      for (const [type, reader] of [["Root", root], ["FileStore", store]]) {
        add(`${type}.readBytes/${size}/concurrent=${concurrency}`, () =>
          settledValues(Array.from({ length: concurrency }, () => reader.readBytes(name))), {
          divisor: 10,
          verify: buffers => {
            assert.equal(buffers.length, concurrency);
            for (const buffer of buffers) assert.ok(buffer.equals(payload));
          },
        });
      }
    }
  }

  const mutationDenied = path.join(w, "mutation-admission-denied");
  fs.mkdirSync(mutationDenied);
  const mutationOptions = {
    denyMutations: { prefixes: [mutationDenied] },
    mutationSymlinks: "reject",
    durable: false,
  };
  for (const depth of [1, 8, 32]) {
    const components = Array.from({ length: depth - 1 }, (_, index) => `d${index}`);
    const existingParent = path.join(w, `mutation-admission-existing-${depth}`, ...components);
    const existingRelative = path.relative(w, path.join(existingParent, "value"));
    fs.mkdirSync(existingParent, { recursive: true });
    fs.writeFileSync(path.join(existingParent, "value"), "original");
    add(`Root.write/mutation-admission/existing/depth=${depth}`, () =>
      root.write(existingRelative, "replacement", mutationOptions), {
      divisor: 10,
      verify: () => assert.equal(fs.readFileSync(path.join(existingParent, "value"), "utf8"), "replacement"),
    });

    const missingRoot = path.join(w, `mutation-admission-missing-${depth}`);
    const missingTarget = path.join(missingRoot, ...components, "value");
    const missingRelative = path.relative(w, missingTarget);
    add(`Root.write/mutation-admission/mkdir/depth=${depth}`, () =>
      root.write(missingRelative, "replacement", mutationOptions), {
      divisor: 10,
      before: () => fs.rmSync(missingRoot, { recursive: true, force: true }),
      verify: () => assert.equal(fs.readFileSync(missingTarget, "utf8"), "replacement"),
      after: () => fs.rmSync(missingRoot, { recursive: true, force: true }),
    });
  }

  const renameDenied = () => { throw Object.assign(new Error("benchmark forces copy fallback"), { code: "EPERM" }); };
  const asyncFs = { promises: { ...fs.promises, rename: async () => renameDenied() } };
  const syncFs = { ...fs, renameSync: renameDenied };
  const dest = path.join(w, "fallback-output");
  for (const size of [128, 1024 * 1024, 16 * 1024 * 1024]) {
    const original = Buffer.alloc(size, 0xa5), content = Buffer.alloc(size, 0x5a);
    for (const restore of ["none", "restore-original"]) {
      for (const sync of [false, true]) {
        const name = sync ? "replaceFileAtomicSync" : "replaceFileAtomic";
        add(`${name}/copy-fallback/${restore}/${size}`, () => a[name]({
          filePath: dest, content, fileSystem: sync ? syncFs : asyncFs,
          copyFallbackOnPermissionError: true, copyFallbackRestore: restore,
          maxRestoreBytes: restore === "restore-original" ? size : undefined,
          syncTempFile: false, syncParentDir: false,
        }), {
          sync, divisor: 100,
          before: () => fs.writeFileSync(dest, original, { mode: 0o600 }),
          verify: result => {
            assert.equal(result.method, "copy-fallback");
            assert.ok(fs.readFileSync(dest).equals(content));
          },
        });
      }
    }
  }

  for (const count of [0, 32, 128]) {
    const key = `scaling:${w}:${count}`, manager = a.createFileLockManager(key);
    onCleanup(() => manager.drain());
    add(`createFileLockManager/held=${count}/batch=100`, () => {
      let result;
      for (let index = 0; index < 100; index++) result = a.createFileLockManager(key);
      return result;
    }, {
      sync: true, divisor: 100,
      before: async () => {
        for (let index = 0; index < count; index++) {
          await manager.acquire(path.join(w, `held-${count}-${index}`), {
            payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
          });
        }
      },
      verify: result => assert.equal(result.heldEntries().length, count),
      after: async () => {
        await manager.drain();
        assert.equal(manager.heldEntries().length, 0);
      },
    });
  }

  for (const count of [100, 1000]) {
    const rootDir = path.join(w, `prune-current-${count}`);
    fs.mkdirSync(rootDir);
    for (let index = 0; index < count; index++) fs.writeFileSync(path.join(rootDir, `entry-${index}`), "x");
    const files = a.fileStore({ rootDir });
    add(`FileStore.pruneExpired/current=${count}`, () => files.pruneExpired({ ttlMs: Infinity }), {
      divisor: 100, verify: () => assert.equal(fs.readdirSync(rootDir).length, count),
    });
  }
}
