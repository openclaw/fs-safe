import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { loadConfigFromFile } from "vite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coverageDir = join(repoRoot, "coverage");
const inputPaths = [
  "coverage-inputs/coverage-Linux/coverage-final.json",
  "coverage-inputs/coverage-macOS/coverage-final.json",
  "coverage-inputs/coverage-Windows/coverage-final.json",
].map((path) => join(repoRoot, path));

const coverageMap = libCoverage.createCoverageMap({});

for (const inputPath of inputPaths) {
  if (!existsSync(inputPath)) {
    throw new Error(`Missing required coverage input: ${relative(repoRoot, inputPath)}`);
  }

  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const normalized = {};
  for (const [sourcePath, fileCoverage] of Object.entries(input)) {
    const portablePath = sourcePath.replaceAll("\\", "/");
    const markerIndex = portablePath.lastIndexOf("/src/");
    const projectPath = markerIndex >= 0
      ? portablePath.slice(markerIndex + 1)
      : portablePath.startsWith("src/")
        ? portablePath
        : undefined;
    if (!projectPath) {
      throw new Error(`Coverage input contains a non-project path: ${sourcePath}`);
    }

    const normalizedPath = join(repoRoot, ...projectPath.split("/"));
    if (!existsSync(normalizedPath)) {
      throw new Error(`Coverage input references a missing source file: ${projectPath}`);
    }
    if (normalized[normalizedPath]) {
      throw new Error(`Coverage input contains duplicate source file: ${projectPath}`);
    }
    normalized[normalizedPath] = { ...fileCoverage, path: normalizedPath };
  }
  coverageMap.merge(normalized);
}

rmSync(coverageDir, { recursive: true, force: true });
const reportContext = libReport.createContext({
  dir: coverageDir,
  coverageMap,
});
for (const reporter of ["text", "json", "json-summary", "html", "lcov"]) {
  reports.create(reporter, { projectRoot: repoRoot }).execute(reportContext);
}

const loadedConfig = await loadConfigFromFile(
  { command: "serve", mode: "test" },
  join(repoRoot, "vitest.config.ts"),
);
const thresholds = loadedConfig?.config?.test?.coverage?.thresholds;
if (!thresholds) {
  throw new Error("vitest.config.ts does not define coverage thresholds");
}

const summary = coverageMap.getCoverageSummary().toJSON();
let failed = false;
for (const metric of ["lines", "functions", "statements", "branches"]) {
  const threshold = thresholds[metric];
  if (typeof threshold !== "number") {
    throw new Error(`vitest.config.ts does not define a numeric ${metric} threshold`);
  }
  if (summary[metric].pct < threshold) {
    console.error(
      `ERROR: Coverage for ${metric} (${summary[metric].pct}%) does not meet threshold (${threshold}%)`,
    );
    failed = true;
  }
}
if (failed) {
  process.exitCode = 1;
}
