import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { configureFsSafeNative } from "../../dist/config.js";
import { getNativeBinding } from "../../dist/native.js";

const seconds = Number(process.argv[2] ?? 60);
const output = path.resolve(process.argv[3] ?? "zip-fuzz-results");
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error("duration must be 1..86400 seconds");
configureFsSafeNative({ mode: "require" });
getNativeBinding(); // Missing native coverage must never silently skip the property.
await fs.mkdir(output, { recursive: true });
const started = performance.now();
let iteration = 0;
const results = [];
while (performance.now() - started < seconds * 1000) {
  const seed = (0x5eedc0de + Math.imul(iteration, 0x9e3779b9)) | 0;
  const logFile = path.join(output, `${iteration}-${seed}.log`);
  const log = await fs.open(logFile, "w");
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
        "test/archive-property-fuzz.test.ts", "--maxWorkers=1", "--retry=0",
        "-t", "structured ZIP fuzz properties|zip collision properties|zip declared limits"], {
        env: { ...process.env, FS_SAFE_NATIVE_MODE: "require", FS_SAFE_PROPERTY_SEED: String(seed) },
        stdio: ["ignore", log.fd, log.fd], timeout: 180000,
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally { await log.close(); }
  const entry = { iteration, seed, ...result, elapsedSeconds: (performance.now() - started) / 1000 };
  results.push(entry);
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(entry));
  if (result.code !== 0) throw new Error(`ZIP property failure; replay FS_SAFE_PROPERTY_SEED=${seed}; see ${logFile}`);
  iteration++;
}
