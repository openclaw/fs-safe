import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const pathsFile = workerData?.pathsFile ?? process.argv[2];
const paths = fs.readFileSync(pathsFile, 'utf8').trim().split(/\r?\n/).map(line => line.split('\t'));
const rows = paths.flatMap(([label, path]) => [
  ['fs.statSync', () => fs.statSync(path).isDirectory()],
  ['fs.realpathSync.native', () => fs.realpathSync.native(path)],
  ['fs.realpathSync', () => fs.realpathSync(path)],
].map(([api, probe]) => {
  try { return { label, path, api, ok: true, result: probe() }; }
  catch (error) {
    return { label, path, api, ok: false, code: error.code, errno: error.errno,
      syscall: error.syscall, errorPath: error.path, message: error.message };
  }
}));

if (isMainThread) {
  const workerRows = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { pathsFile } });
    let result;
    worker.once('message', value => { result = value; });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`Diagnostic Worker exit ${code}`)));
  });
  fs.writeFileSync(process.argv[3], JSON.stringify({ arch: process.arch, version: process.version,
    main: rows, worker: workerRows }, null, 2));
} else { parentPort.postMessage(rows); }
