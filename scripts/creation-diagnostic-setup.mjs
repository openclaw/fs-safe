import fs from 'node:fs';
const file = 'scripts/consumer-install-smoke.mjs';
let source = fs.readFileSync(file, 'utf8');
const change = (before, after) => {
  if (!source.includes(before)) throw Error(`Missing diagnostic anchor: ${before}`);
  source = source.replace(before, after);
};
change('[["npm", [process.execPath, npmCli]], ["pnpm", pnpmCommand]]', '[["npm", [process.execPath, npmCli]]]');
change('for (const omitted of [false, true])', 'for (const omitted of [true])');
const anchor = '        cases.creation = [];';
change(anchor, `        const summaries = [];
        for (let sample = 1; sample <= 3; sample++) {
          const trace = join(outputDir, 'creation-sample-' + sample + '.jsonl');
          writeFileSync(trace, '');
          const start = performance.now();
          let success = false;
          try {
            // Diagnostic only: no aggregate subprocess deadline. Production limits are untouched.
            const { stdout } = await exec(process.execPath, [
              '--import', new URL('./creation-diagnostic-preload.mjs', import.meta.url).href,
              join(directory, 'consumer-creation-probe.mjs'), 'off',
            ], { cwd: directory, env: { ...env, FS_SAFE_CREATION_DIAGNOSTIC_OUTPUT: trace },
              encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
            const receipt = JSON.parse(stdout);
            assert.equal(receipt.omitted, true);
            assert.equal(receipt.nativeLoaded, false);
            assert.equal(receipt.mode, 'off');
            assert.deepEqual(receipt.rows.map(row => row.scenario), creationScenarioNames({ omitted: true, mode: 'off', platform: process.platform }));
            success = true;
          } finally {
            const events = readFileSync(trace, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
            const launches = events.filter(event => event.kind === 'powershell');
            const summary = { sample, node: process.version, arch: process.arch, success,
              wallMs: performance.now() - start, launchCount: launches.length,
              powershellMs: launches.reduce((total, event) => total + event.durationMs, 0),
              nodeReports: events.filter(event => event.kind === 'node-report'), launches };
            summaries.push(summary);
            writeFileSync(join(outputDir, 'creation-summary.json'), JSON.stringify(summaries, null, 2));
            console.log('CREATION_DIAGNOSTIC ' + JSON.stringify(summary));
          }
        }
        return;
` + anchor);
fs.writeFileSync(file, source);
