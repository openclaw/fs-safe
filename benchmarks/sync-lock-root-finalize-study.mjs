import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SYNC_LOCK_ROOT_FILTER } from "./sync-lock-root-contract.mjs";
import { validatePlanHash } from "./method-audit-plan.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    assert(name?.startsWith("--") && value !== undefined, "finalizer options require name/value pairs");
    const key = name.slice(2);
    assert.equal(values[key], undefined, `duplicate finalizer option: ${name}`);
    values[key] = value;
  }
  const expected = ["plan", "output-root", "artifact-name", "surface", "node", "order", "control"];
  assert.deepEqual(Object.keys(values).sort(), [...expected].sort(), "finalizer option set mismatch");
  return values;
}

try {
  const options = parseArguments(process.argv);
  const planPath = path.resolve(options.plan);
  const outputRoot = path.resolve(options["output-root"]);
  const planBytes = fs.readFileSync(planPath);
  const plan = validatePlanHash(JSON.parse(planBytes.toString("utf8")));
  assert.equal(plan.settings.filter, SYNC_LOCK_ROOT_FILTER, "study is not the focused lockRoot campaign");
  assert.equal(plan.settings.nodeVersion, options.node, "study Node option mismatch");
  assert.equal(plan.settings.order, options.order, "study order option mismatch");
  assert.equal(plan.settings.controlKind, options.control, "study control option mismatch");
  assert.equal(plan.matrix.include.length, 1, "study platform plan is not singular");
  assert.equal(plan.matrix.include[0].platform, options.surface, "study platform option mismatch");
  if (options.surface !== "wsl2") {
    assert.equal(plan.run.attempt, 1, "study is not from the first attempt");
  }
  assert.match(options["artifact-name"],
    new RegExp(
      `^sync-lock-root-${options.surface}-node-${options.node}-${options.order}-` +
        `${options.control}-[A-Za-z0-9._-]+-1$`,
      "u",
    ),
    "study artifact name mismatch");
  const copiedPlan = path.join(outputRoot, "proof-plan.json");
  fs.copyFileSync(planPath, copiedPlan, fs.constants.COPYFILE_EXCL);
  const provenancePath = path.join(outputRoot, "study-provenance.json");
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  assert.equal(provenance.plan?.planHash, plan.planHash, "study provenance plan mismatch");
  assert.equal(provenance.platform, options.surface, "study provenance platform mismatch");
  const expectedFiles = [...plan.reports.map(({ file }) => file), "proof-plan.json", "study-provenance.json"];
  assert.deepEqual(fs.readdirSync(outputRoot).sort(), expectedFiles.sort(),
    "study output contains an incomplete or unexpected file set");
  const finalized = {
    ...provenance,
    artifactIdentity: {
      name: options["artifact-name"],
      runId: String(plan.run.id),
      runAttempt: String(plan.run.attempt),
      surface: options.surface,
      node: options.node,
      order: options.order,
      control: options.control,
    },
    proofPlanFileSha256: sha256(planBytes),
  };
  fs.writeFileSync(provenancePath, `${JSON.stringify(finalized, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `sync lockRoot study finalization failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
