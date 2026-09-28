import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const configurations = [
  ['linux-openat2', 'require', {}],
  ['linux-no-openat2', 'require', { FS_SAFE_TEST_NO_OPENAT2: '1' }],
  ['linux-off', 'off', {}],
];
fs.mkdirSync('.artifacts', { recursive: true });
const directory = fs.mkdtempSync('.artifacts/campaign-');
console.log(JSON.stringify({ campaignDirectory: directory }));
const running = configurations.map(([name, mode, environment]) => {
  const file = `${directory}/${name}.jsonl`;
  const log = fs.openSync(`${directory}/${name}.log`, 'w');
  const child = spawn(process.execPath, ['scripts/root-race/run.mjs', `--mode=${mode}`, '--seeds=60', '--seconds=20', `--output=${file}`], {
    env: { ...process.env, ...environment }, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  return { name, file, child, completion: once(child, 'exit') };
});
const heartbeat = setInterval(() => {
  for (const job of running) {
    const rows = fs.existsSync(job.file) ? fs.readFileSync(job.file, 'utf8').trim().split('\n').map(row => JSON.parse(row)) : [];
    const seeds = rows.filter(row => row.event === 'seed');
    console.log(JSON.stringify({ progress: job.name, seeds: seeds.length, operations: seeds.reduce((n, row) => n + row.operations, 0), affected: seeds.filter(row => row.observations.length || row.finalOutside.length || row.finalDenied.length).length }));
  }
}, 30000);
const outcomes = await Promise.all(running.map(async job => ({ name: job.name, exit: await job.completion })));
clearInterval(heartbeat);
console.log(JSON.stringify({ outcomes }));
for (const job of running) console.log(fs.readFileSync(job.file, 'utf8'));
if (outcomes.some(job => job.exit[0] !== 0)) process.exitCode = 1;
