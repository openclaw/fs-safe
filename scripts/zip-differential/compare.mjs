import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [baseline, candidate, corpus, output] = process.argv.slice(2);
if (!output) throw new Error("usage: compare.mjs <baseline-package> <candidate-package> <corpus> <output-directory>");
await fs.mkdir(output, { recursive: true });
const worker = fileURLToPath(new URL("./observe.mjs", import.meta.url));
async function run(packageRoot, mode, file) {
  const log = await fs.open(file + ".log", "w");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, path.resolve(packageRoot), path.resolve(corpus), mode, path.resolve(file)], {
        stdio: ["ignore", log.fd, log.fd], timeout: 20 * 60 * 1000,
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`observer failed (${code ?? signal}); see ${file}.log`)));
    });
  } finally { await log.close(); }
  return JSON.parse(await fs.readFile(file, "utf8"));
}
const differences = [];
for (const mode of ["off", "require", "auto"]) {
  const before = await run(baseline, mode, path.join(output, `baseline-${mode}.json`));
  const after = await run(candidate, mode, path.join(output, `candidate-${mode}.json`));
  if (mode !== "off" && before.binding.sha256 === after.binding.sha256) {
    throw new Error("baseline and candidate resolved the same native binary; build and stage the candidate first");
  }
  if (!before.observations.length || before.observations.length !== after.observations.length) throw new Error("empty or incomplete observation set");
  for (let i = 0; i < before.observations.length; i++) {
    const a = before.observations[i], b = after.observations[i];
    if (a.id !== b.id || a.sha256 !== b.sha256) throw new Error("corpus changed between observers");
    for (const surface of Object.keys(a)) {
      if (JSON.stringify(a[surface]) !== JSON.stringify(b[surface])) differences.push({
        case: a.id, mode, surface, before: a[surface], after: b[surface], classification: "UNCLASSIFIED",
      });
    }
  }
  console.log(JSON.stringify({ mode, cases: before.observations.length, differences: differences.filter(d => d.mode === mode).length }));
}
await fs.writeFile(path.join(output, "differences.json"), JSON.stringify(differences, null, 2) + "\n");
console.log(JSON.stringify({ differences: differences.length, output: path.resolve(output) }));
