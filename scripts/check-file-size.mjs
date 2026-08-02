import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_LINES = 500;
const LINE_BUDGETS = new Map([
  ["src/file-store.ts", 585],
  ["src/permissions.ts", 566],
  ["src/root-impl.ts", 1750],
  ["src/root-path.ts", 862],
  ["test/api-coverage.test.ts", 983],
  ["test/new-primitives.test.ts", 1500],
]);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(fullPath);
    }
    return fullPath.endsWith(".ts") ? [fullPath] : [];
  });
}

const rootDir = process.cwd();
const files = [...walk("src"), ...walk("test")].sort();
const failures = [];

for (const file of files) {
  const normalized = file.split(path.sep).join("/");
  const text = fs.readFileSync(path.join(rootDir, file), "utf8");
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  const budget = LINE_BUDGETS.get(normalized) ?? DEFAULT_MAX_LINES;
  if (lines > budget) {
    failures.push(`${normalized}: ${lines} lines > ${budget} budget`);
  }
}

if (failures.length > 0) {
  console.error("File size budget exceeded:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
