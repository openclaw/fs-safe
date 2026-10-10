import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decode, encode, firstDifference } from '../../scripts/differential-root-model.mjs';
import { portableReport } from './corpus.mjs';

const directories = process.argv.slice(2);
assert.ok(directories.length >= 2, 'pass at least two portable receipt directories');
const read = (directory, file) => decode(fs.readFileSync(path.join(directory, file), 'utf8'));
const summaries = directories.map(directory => read(directory, 'summary.json'));
for (const summary of summaries) {
  assert.equal(summary.profile, 'portable');
  assert.equal(summary.status, 'passed', 'incomplete/divergent runs are not cross-platform proof');
  assert.ok(summary.cases.length > 0);
  assert.deepEqual(summary.cases.map(item => item.seed), summaries[0].cases.map(item => item.seed));
}
let comparisons = 0;
for (const { seed } of summaries[0].cases) {
  const receipts = directories.map(directory => read(directory, `seed-${seed}.json`));
  for (let i = 0; i < receipts.length; i++) {
    assert.ok(receipts[i].reports.length > 0, 'missing platform reports');
    assert.equal(receipts[i].reports.length, summaries[i].lanes.length, 'missing lane reports');
    for (const report of receipts[i].reports) {
      assert.equal(report.platform, summaries[i].platform);
      assert.equal(report.results.length, receipts[i].spec.ops.length, 'incomplete operation receipts');
    }
  }
  for (let base = 0; base < receipts.length; base++) for (let i = base + 1; i < receipts.length; i++) {
    assert.equal(encode(receipts[i].spec), encode(receipts[base].spec), 'different scripts cannot establish equivalence');
    const windows = [summaries[base], summaries[i]].some(summary => summary.platform === 'win32');
    for (const report of receipts[i].reports) {
      const difference = firstDifference(portableReport(receipts[base].reports[0], receipts[base].spec, windows),
        portableReport(report, receipts[i].spec, windows));
      assert.equal(difference, undefined, `seed ${seed}: ${JSON.stringify(difference)}`);
      comparisons++;
    }
  }
}
console.log(JSON.stringify({ platforms: summaries.map(summary => summary.platform), comparisons, status: 'passed' }));
