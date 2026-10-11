import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

async function probe(entry) {
  const { createDirectorySync, createFileSync } = await import(entry);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-path-repro-'));
  const rows = [];
  try {
    for (const parentLength of [120, 225, 290]) {
      let parent = path.join(root, String(parentLength));
      while (parent.length < parentLength) {
        const remaining = parentLength - parent.length;
        parent = remaining === 1 ? parent + 'p' : path.join(parent, 'p'.repeat(Math.min(50, remaining - 1)));
      }
      assert.equal(parent.length, parentLength);
      fs.mkdirSync(path.toNamespacedPath(parent), { recursive: true });
      for (const kind of ['directory', 'file']) {
        for (const namespaced of [false, true]) {
          const leaf = kind === 'directory'
            ? `.sqlite-publish-${'0'.repeat(36)}-${'1'.repeat(36)}`
            : `private-${namespaced}.sqlite`;
          const ordinary = path.join(parent, leaf);
          const target = namespaced ? path.toNamespacedPath(ordinary) : ordinary;
          const row = { context: isMainThread ? 'main' : 'worker', kind, namespaced,
            parentLength, targetLength: ordinary.length };
          try {
            if (kind === 'directory') {
              createDirectorySync(target, { private: true });
              assert.equal(fs.statSync(target).isDirectory(), true);
              fs.rmdirSync(target);
            } else {
              const owned = createFileSync(target, { private: true });
              try { fs.writeSync(owned.fd, 'synthetic'); } finally { owned.close(); }
              assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic');
              fs.unlinkSync(target);
            }
            row.result = 'success';
          } catch (error) {
            row.result = 'error';
            row.code = error.code;
            row.errno = error.errno;
            row.message = error.message;
            row.cause = error.cause?.message;
          }
          row.remainingEntries = fs.readdirSync(path.toNamespacedPath(parent));
          rows.push(row);
        }
      }
    }
    return rows;
  } finally {
    fs.rmSync(path.toNamespacedPath(root), { recursive: true, force: true });
  }
}

if (!isMainThread) {
  parentPort.postMessage(await probe(workerData.entry));
} else {
  assert.equal(process.platform, 'win32');
  const require = createRequire(path.resolve('package.json'));
  const entry = pathToFileURL(require.resolve('@openclaw/fs-safe/advanced')).href;
  const rows = await probe(entry);
  rows.push(...await new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { entry } });
    let result;
    worker.once('message', value => { result = value; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0 || !result) reject(new Error(`Worker failed: ${code}`));
      else resolve(result);
    });
  }));
  const output = { platform: process.platform, arch: process.arch, runtime: process.version,
    bun: process.versions.bun, rows };
  fs.mkdirSync('.proof-results', { recursive: true });
  fs.writeFileSync(`.proof-results/private-directory-${process.versions.bun ? 'bun' : 'node'}.json`,
    JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
  for (const row of rows) {
    assert.deepEqual(row.remainingEntries, []);
    if (row.namespaced || row.parentLength === 120) assert.equal(row.result, 'success');
    else {
      // Private files create an internal .fs-safe-create-<UUID> directory: even
      // a short leaf under the 225-character parent crosses MAX_PATH there.
      assert.equal(row.result, 'error');
      assert.match(row.message, /Windows error 3/);
    }
  }
}
