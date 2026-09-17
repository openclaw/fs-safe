import assert from "node:assert/strict";
import { SYNC_LOCK_ROOT_ROWS } from "./sync-lock-root-contract.mjs";

export const SYNC_LOCK_ROOT_GATES = Object.freeze({
  medianAbsoluteUs: 50,
  medianRelativePercent: 10,
  maxAbsoluteUs: 100,
  maxRelativePercent: 20,
});

function median(values) {
  assert(values.length > 0, "cannot calculate an empty median");
  const sorted = [...values].sort((left, right) => left - right);
  return (sorted[Math.floor((sorted.length - 1) / 2)] +
    sorted[Math.floor(sorted.length / 2)]) / 2;
}

function delta(candidate, baseline, control) {
  const directional = candidate - baseline;
  const absoluteUs = control === "source-comparison" ? directional : Math.abs(directional);
  const relativePercent = baseline === 0
    ? (absoluteUs > 0 ? "infinite" : 0)
    : absoluteUs * 100 / baseline;
  return { absoluteUs, relativePercent };
}

function gate(candidate, baseline, control, absoluteLimit, relativeLimit) {
  const observed = delta(candidate, baseline, control);
  return {
    ...observed,
    failed: observed.absoluteUs > absoluteLimit || observed.relativePercent === "infinite" ||
      observed.relativePercent > relativeLimit,
  };
}

function samplesFor(study, rowName, role, block) {
  return study.reports.filter(({ plan }) => plan.role === role &&
    (block === undefined || plan.block === block)).flatMap(({ report }) => {
    const result = report.results.find(({ name }) => name === rowName);
    assert(result && !result.skipped, `${rowName} result is missing or skipped`);
    assert.equal(result.samplesUs.length, 9, `${rowName} sample count mismatch`);
    assert(result.samplesUs.every((sample) => Number.isFinite(sample) && sample >= 0),
      `${rowName} contains an invalid sample average`);
    return result.samplesUs;
  });
}

function gatedMedian(candidateSamples, baselineSamples, control) {
  const candidate = median(candidateSamples);
  const baseline = median(baselineSamples);
  return { baseline, candidate, ...gate(
    candidate, baseline, control,
    SYNC_LOCK_ROOT_GATES.medianAbsoluteUs,
    SYNC_LOCK_ROOT_GATES.medianRelativePercent,
  ) };
}

function gatedMaximum(candidateSamples, baselineSamples, control) {
  const candidate = Math.max(...candidateSamples);
  const baseline = Math.max(...baselineSamples);
  return { baseline, candidate, ...gate(
    candidate, baseline, control,
    SYNC_LOCK_ROOT_GATES.maxAbsoluteUs,
    SYNC_LOCK_ROOT_GATES.maxRelativePercent,
  ) };
}

export function analyzeSyncLockRootStudy(study) {
  const rows = [];
  for (const { name } of SYNC_LOCK_ROOT_ROWS) {
    const blocks = [];
    for (let block = 1; block <= 5; block += 1) {
      const candidateSamples = samplesFor(study, name, "candidate", block);
      const baselineSamples = samplesFor(study, name, "baseline", block);
      assert.equal(candidateSamples.length, 18, `${name} candidate block is incomplete`);
      assert.equal(baselineSamples.length, 18, `${name} baseline block is incomplete`);
      const blockMedian = gatedMedian(candidateSamples, baselineSamples, study.control);
      const maximum = gatedMaximum(candidateSamples, baselineSamples, study.control);
      blocks.push({
        block,
        ...blockMedian,
        maximum,
        failed: blockMedian.failed || maximum.failed,
      });
    }
    const pooledCandidate = samplesFor(study, name, "candidate");
    const pooledBaseline = samplesFor(study, name, "baseline");
    assert.equal(pooledCandidate.length, 90, `${name} pooled candidate set is incomplete`);
    assert.equal(pooledBaseline.length, 90, `${name} pooled baseline set is incomplete`);
    const pooled = gatedMedian(pooledCandidate, pooledBaseline, study.control);
    const maximum = gatedMaximum(pooledCandidate, pooledBaseline, study.control);
    rows.push({
      name,
      blocks,
      pooled,
      maximum,
      failed: blocks.some(({ failed }) => failed) || pooled.failed || maximum.failed,
    });
  }
  return {
    surface: study.surface,
    node: study.node,
    order: study.order,
    control: study.control,
    failed: rows.some(({ failed }) => failed),
    rows,
  };
}
