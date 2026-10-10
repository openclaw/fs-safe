import childProcess, { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const destination = process.env.FS_SAFE_CREATION_DIAGNOSTIC_OUTPUT;
if (!destination) throw Error('Missing diagnostic output');
const started = performance.now();
let sequence = 0;
const isPowerShell = file => /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(String(file));
const label = args => {
  const index = args.findIndex(value => String(value).toLowerCase() === '-operation');
  return index >= 0 ? args[index + 1] : 'independent-acl';
};
const record = value => appendFileSync(destination, JSON.stringify({ ...value, arch: process.arch }) + '\n');
for (const name of ['spawnSync', 'execFileSync']) {
  const original = childProcess[name];
  childProcess[name] = function(file, args = [], ...rest) {
    if (!isPowerShell(file)) return Reflect.apply(original, this, [file, args, ...rest]);
    const id = ++sequence, startMs = performance.now() - started;
    record({ kind: 'start', id, api: name, operation: label(args), startMs });
    let outcome;
    try {
      const result = Reflect.apply(original, this, [file, args, ...rest]);
      outcome = { code: name === 'spawnSync' ? result.status : 0, signal: result?.signal ?? null };
      return result;
    } catch (error) {
      outcome = { code: error.status ?? null, signal: error.signal ?? null, error: error.code ?? error.name };
      throw error;
    } finally {
      record({ kind: 'powershell', id, api: name, operation: label(args), startMs,
        durationMs: performance.now() - started - startMs, ...outcome });
    }
  };
}
const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function(options) {
  if (!isPowerShell(options.file)) return Reflect.apply(spawn, this, [options]);
  const id = ++sequence, startMs = performance.now() - started;
  record({ kind: 'start', id, api: 'ChildProcess.spawn', operation: label(options.args), startMs });
  this.once('close', (code, signal) => record({ kind: 'powershell', id, api: 'ChildProcess.spawn',
    operation: label(options.args), startMs, durationMs: performance.now() - started - startMs, code, signal }));
  return Reflect.apply(spawn, this, [options]);
};
const getReport = process.report.getReport;
process.report.getReport = function(...args) {
  const begin = performance.now();
  try { return Reflect.apply(getReport, this, args); }
  finally { record({ kind: 'node-report', durationMs: performance.now() - begin }); }
};
syncBuiltinESMExports();
