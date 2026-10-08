import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from 'node:inspector/promises';
const [baseline, candidate] = process.argv.slice(2);
const tree=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'fs-safe-walk-allocation-'));
try {
 for(let d=0;d<100;d++){const dir=path.join(tree,`package-${d}`);fs.mkdirSync(dir);for(let f=0;f<500;f++)fs.writeFileSync(path.join(dir,`${f}.js`),'x');}
 for(const [name,dist] of [['base',baseline],['candidate',candidate]]){
  const load=file=>import(pathToFileURL(path.resolve(dist,file)).href);
  (await load('config.js')).configureFsSafeNative({mode:'off'});
  const safe=await (await load('root.js')).root(tree);
  const session=new Session();session.connect();
  await session.post('HeapProfiler.startSampling',{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  for(let repeat=0;repeat<10;repeat++){let count=0;for await(const entry of safe.walk('',{symlinkPolicy:'skip'}))count++;assert.equal(count,50100);}
  const {profile}=await session.post('HeapProfiler.stopSampling');session.disconnect();
  const sum=node=>node.selfSize+node.children.reduce((total,child)=>total+sum(child),0);
  console.log(JSON.stringify({name,sampledBytes:sum(profile.head),walks:10,filesPerWalk:50000}));
 }
}finally{fs.rmSync(tree,{recursive:true,force:true});}
