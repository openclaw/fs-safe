// Structural protocol checks only. No filesystem workload or timer is invoked.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "scripts/pr323-optimized-proof-manifest.json"), "utf8"));
for (const [file, expected] of Object.entries(manifest.filesSha256Lf)) {
  const bytes = fs.readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
  assert.equal(sha(bytes), expected, `frozen proof file changed: ${file}`);
}
const originalArgv = process.argv;
const summaries = [];
try {
  for (const experiment of ["producer-fix", "producer-final", "archive-final"]) {
    const producer = experiment.startsWith("producer-");
    const harnessPath = path.join(root, "scripts", `pr323-optimized-${producer ? "producer" : "archive"}-proof.mjs`);
    const source = fs.readFileSync(harnessPath, "utf8");
    const cutoff = source.lastIndexOf("const { values } = parseArgs({");
    assert(cutoff > 0);
    process.argv = [process.execPath, harnessPath, "--experiment", experiment];
    const definitions = source.slice(0, cutoff) + "\nexport { validatePlan, buildSchedule, sanitizedSchedule };\n";
    const harness = await import(`data:text/javascript;base64,${Buffer.from(definitions).toString("base64")}#${experiment}`);
    const planPath = path.join(root, "scripts", `pr323-optimized-${experiment}-plan.json`);
    const { plan, digest } = harness.validatePlan(planPath, "smoke");
    const sample = { blocks: plan.sampling.blocks, cohorts: plan.sampling.cohorts,
      blocksPerCohort: plan.sampling.blocksPerCohort };
    const schedule = harness.sanitizedSchedule(harness.buildSchedule(plan, sample));
    const entries = schedule.flatMap((block) => block.processOrder);
    assert.equal(entries.length, 1536);
    assert.equal(new Set(schedule.map(({ block }) => block)).size, 192);
    const calls = Object.fromEntries(["A", "B", "A0", "A1"].map((label) => {
      const children = entries.filter((entry) => entry.label === label);
      assert.equal(children.length, 384);
      assert(children.every((entry) => entry.revision === (label === "B"
        ? plan.revisions.candidate : plan.revisions.baseline)));
      return [label, children.length * plan.sampling.timedCallsPerWorkload];
    }));
    assert.equal(plan.analysis.relativeRegressionPercent, 5);
    assert.equal(plan.analysis.absoluteRegressionMicroseconds, 5);
    assert.equal(plan.analysis.bootstrapIterations, 20000);
    const bytes = JSON.stringify(schedule, null, 2) + "\n";
    summaries.push({ experiment, planSha256: digest, scheduleSha256: sha(bytes),
      blocks: schedule.length, freshChildren: entries.length, timedCallsPerWorkloadPerArm: calls,
      timedCalls: entries.length * plan.workloads.length * plan.sampling.timedCallsPerWorkload,
      warmupCalls: entries.length * plan.workloads.length * plan.sampling.warmupCallsPerWorkload });
  }
} finally {
  process.argv = originalArgv;
}
assert.equal(new Set(summaries.map(({ scheduleSha256 }) => scheduleSha256)).size, 3);
console.log(JSON.stringify({ passed: true, timingPerformed: false, summaries }, null, 2));
