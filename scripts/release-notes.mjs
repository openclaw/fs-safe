import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = process.argv[2] ?? pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`release version must match X.Y.Z; received ${version || "<missing>"}`);
}

const lines = readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
const prefix = `## ${version} - `;
const start = lines.findIndex((line) => line.startsWith(prefix));
if (start < 0) {
  throw new Error(`CHANGELOG.md has no section for ${version}`);
}

const date = lines[start].slice(prefix.length).trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  throw new Error(`CHANGELOG.md section ${version} must have a release date`);
}

const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const body = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
if (!body) {
  throw new Error(`CHANGELOG.md section ${version} has no release notes`);
}

process.stdout.write(`${body}\n`);
