import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { copyTree, probeTreeClone } from "../dist/copy.js";

const [sourceArgument, parentArgument, samplesArgument = "3", policy = "always"] = process.argv.slice(2);
assert(
  sourceArgument && parentArgument,
  "Usage: node benchmarks/clone.mjs SOURCE DESTINATION_PARENT [SAMPLES] [auto|always|never]",
);
assert(["auto", "always", "never"].includes(policy), "Unknown copy policy");
const workerCounts = [1, 4, 16];
const samples = Number(samplesArgument);
assert(
  Number.isSafeInteger(samples) && samples >= 1 && samples <= 20,
  "SAMPLES must be between 1 and 20",
);
const source = await fs.realpath(sourceArgument);
const parent = await fs.realpath(parentArgument);
const relative = path.relative(source, parent);
assert(
  relative &&
    (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)),
  "Destination parent must be outside the source tree",
);
const backend = probeTreeClone(parent);
assert(policy !== "always" || backend, "Destination parent has no native tree-clone support");
const output = await fs.mkdtemp(path.join(parent, "fs-safe-clone-benchmark-"));
console.log(`Retaining benchmark outputs at ${output}`);

async function inventory(directory, prefix = "") {
  const entries = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      entries.push([relativePath, "symlink", await fs.readlink(filename)]);
    } else if (entry.isDirectory()) {
      entries.push([relativePath, "directory"]);
      entries.push(...(await inventory(filename, relativePath)));
    } else {
      assert(entry.isFile(), `Unsupported fixture entry: ${relativePath}`);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(filename)) hash.update(chunk);
      entries.push([relativePath, "file", (await fs.stat(filename)).size, hash.digest("hex")]);
    }
  }
  return entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

const expected = await inventory(source);
const results = [];
for (let sample = 0; sample < samples; sample++) {
  // Alternate ordering so the highest worker count is not always warmer.
  for (const concurrency of sample % 2 ? [...workerCounts].reverse() : workerCounts) {
    const destination = path.join(output, `workers-${concurrency}-sample-${sample + 1}`);
    const started = performance.now();
    await copyTree(source, destination, { clone: policy, concurrency });
    const seconds = (performance.now() - started) / 1000;
    assert.deepEqual(
      await inventory(destination),
      expected,
      "Clone paths, file bytes, or symlinks differ",
    );
    const result = {
      concurrency,
      sample: sample + 1,
      seconds,
      rssBytes: process.memoryUsage().rss,
      destination,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
assert.deepEqual(await inventory(source), expected, "Source changed during benchmark");
const medians = workerCounts.map((concurrency) => {
  const times = results
    .filter((result) => result.concurrency === concurrency)
    .map((result) => result.seconds)
    .sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  return {
    concurrency,
    seconds: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
  };
});
const report = {
  backend,
  policy,
  source,
  output,
  samples,
  entries: expected.length,
  medians,
  results,
  allPathsAndBytesMatch: true,
};
await fs.writeFile(path.join(output, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ backend, policy, medians, allPathsAndBytesMatch: true }));
