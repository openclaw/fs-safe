import { appendFileSync, readFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(`coverage-rust/${name}.json`, "utf8")).data[0].totals;
const unit = read("unit-summary");
const combined = read("coverage-summary");
const threshold = 71;
for (const metric of ["lines", "branches"]) {
  if (!(combined[metric].count > 0)) throw new Error(`Missing Rust ${metric} instrumentation`);
}
if (combined.lines.covered <= unit.lines.covered) {
  throw new Error("Addon suites did not add Rust line coverage beyond the unit tests");
}
const percent = (total, metric) => total[metric].percent.toFixed(2);
const summary = [
  "## Rust coverage (Linux)", "",
  "| Corpus | Lines | Branches |", "|---|---:|---:|",
  `| Unit tests | ${percent(unit, "lines")}% | ${percent(unit, "branches")}% |`,
  `| Unit tests + TS addon suites | ${percent(combined, "lines")}% | ${percent(combined, "branches")}% |`,
  "", `Native Rust line threshold: ${threshold}%. Branch coverage uses pinned nightly instrumentation.`, "",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (combined.lines.percent < threshold) {
  throw new Error(`Rust line coverage ${percent(combined, "lines")}% is below ${threshold}%`);
}
