import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const [action, directory, count = '2000', baseline = 'dist', candidate = baseline, selectedMode = 'poll'] = process.argv.slice(2);
const directories = Number(count);
assert(Number.isInteger(directories) && directories > 0);
if (action === 'setup') {
  fs.mkdirSync(directory);
  for (let d = 0; d < directories; d++) {
    const child = path.join(directory, `dir-${d}`);
    fs.mkdirSync(child);
    for (let f = 0; f < 25; f++) fs.writeFileSync(path.join(child, `file-${f}`), `content-${d}-${f}`);
  }
  console.log(JSON.stringify({fixture: directory, directories, files: directories * 25}));
} else {
  const load = async (dist, name) => import(pathToFileURL(path.resolve(dist, `${name}.js`)));
  const api = async dist => {
    const { root } = await load(dist, 'root');
    const { watch } = await load(dist, 'watch');
    const { configureFsSafeNative } = await load(dist, 'native-config');
    configureFsSafeNative({mode: 'require'});
    return {capability: await root(directory), watch};
  };
  const measure = async (library, mode) => {
    const start = performance.now();
    const owner = library.watch(library.capability, {
      mode, scopes: [{path: '', kind: 'tree'}], intervalMs: 3_600_000, pollIntervalMs: 3_600_000,
      onInvalidate() {},
    });
    try {
      await owner.ready;
      const readyMs = performance.now() - start;
      assert.deepEqual(owner.health(), {state: 'ready', mode, directories: directories + 1});
      const next = performance.now();
      await owner.reconcile();
      const reconcileMs = performance.now() - next;
      assert.deepEqual(owner.health(), {state: 'ready', mode, directories: directories + 1});
      return {files: directories * 25, directories, mode, readyMs, reconcileMs};
    } finally { await owner.close(); }
  };
  const before = await api(baseline);
  if (action === 'once') {
    console.log(JSON.stringify(await measure(before, selectedMode)));
  } else if (action === 'compare') {
    const after = await api(candidate);
    for (const mode of ['poll', 'events']) {
      await measure(before, mode); await measure(after, mode);
      for (const order of ['ABBA', 'BAAB']) for (let block = 0; block < 5; block++) {
        for (const arm of order) console.log(JSON.stringify({
          order, block, arm, ...await measure(arm === 'A' ? before : after, mode),
        }));
      }
    }
  } else throw new Error('unknown action');
}
