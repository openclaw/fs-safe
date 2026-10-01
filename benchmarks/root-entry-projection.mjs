import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [baseDist, headDist, output, action = 'compare', selected = 'all'] = process.argv.slice(2);
const modules = await Promise.all([baseDist, headDist].map(d => import(pathToFileURL(path.resolve(d, 'root.js')))));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-safe-entry-bench-'));
try {
  for (const count of [1, 100, 1000]) {
    await fs.mkdir(path.join(workspace, `n${count}`));
    for (let i = 0; i < count; i++) await fs.writeFile(path.join(workspace, `n${count}`, `${i}.json`), '{"synthetic":true}\n');
  }
  const roots = await Promise.all(modules.map(m => m.root(workspace)));
  const cases = [
    ...[1, 100, 1000].flatMap(count => [false, true].map(metadata => ({ name: `list-${count}-${metadata ? 'metadata' : 'names'}`, iterations: count === 1000 ? 30 : 100, run: r => r.list(`n${count}`, {withFileTypes: metadata}), verify: result => assert.equal(result.length, count) }))),
    {name:'stat', iterations: 100, run: r => r.stat('n100/0.json'), verify: result => assert.equal(result.size, 19)},
    {name:'walk-sorted-1000', iterations: 10, run: async r => { const results=[]; for await (const entry of r.walk('n1000', {order:'sorted', symlinkPolicy:'skip'})) results.push(entry); return results; }, verify: result => assert.equal(result.length, 1000)},
    {name:'entries-sorted-1000', iterations: 5, run: async r => { const results=[]; for await (const entry of r.entries('n1000', {order:'sorted'})) results.push(entry); return results; }, verify: result => assert.equal(result.length, 1000)},
  ].filter(c => selected === 'all' || c.name === selected);
  assert(cases.length > 0, 'Unknown benchmark case');
  assert(['compare', 'trace'].includes(action), 'Unknown action');
  for (const c of cases) {
    const expected = await c.run(roots[0]);
    const actual = await c.run(roots[1]);
    c.verify(expected);
    c.verify(actual);
    assert.deepEqual(actual, expected);
    if (Array.isArray(expected) && expected[0] && typeof expected[0] === 'object') {
      assert.deepEqual(Object.keys(actual[0]), Object.keys(expected[0]));
    }
  }
  const results = [];
  for (const c of cases) {
    const measure = async index => { const start = performance.now(); let result; for(let j=0;j<c.iterations;j++) result = await c.run(roots[index]); const us=(performance.now()-start)*1000/c.iterations; c.verify(result); return us; };
    if(action === 'trace') { for(let i=0;i<10;i++) await measure(0); continue; }
    for(let i=0;i<3;i++) { await measure(0); await measure(1); }
    const samples=[];
    for(let pair=0;pair<24;pair++) {
      const arms = pair % 2 ? ['aaCopy','aaBase','abHead','abBase'] : ['abBase','abHead','aaBase','aaCopy'];
      const sample={pair};
      for(const arm of arms) sample[arm]=await measure(arm==='abHead'?1:0);
      samples.push(sample);
    }
    results.push({name:c.name, iterations:c.iterations, samples});
    console.error(c.name, 'complete');
  }
  await fs.writeFile(output, JSON.stringify({mode:process.env.FS_SAFE_NATIVE_MODE,node:process.version,platform:process.platform,arch:process.arch,results},null,2));
} finally { await fs.rm(workspace,{recursive:true,force:true}); }
