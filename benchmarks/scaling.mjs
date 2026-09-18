import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  registerRootWriteMutationAdmission,
  registerSharedMutationAdmission,
} from "./shared-mutation-admission.mjs";
import { registerCopyFallbackSuccess } from "./copy-fallback-success.mjs";
import { registerSyncCopyFallbackAdmission } from "./sync-copy-fallback-admission.mjs";

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
  registerRootWriteMutationAdmission({ root, workspace: w, register: add });
  registerSharedMutationAdmission({ root, workspace: w, register: add });
  registerCopyFallbackSuccess({ api: a, workspace: w, register: add });
  registerSyncCopyFallbackAdmission({ api: a, workspace: w, register: add });

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
