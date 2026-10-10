import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readRepoFile(relativePath) {
  return fsSync.readFileSync(path.join(repoRoot, relativePath), "utf8").replaceAll("\r\n", "\n");
}

export function markdownFiles() {
  return [
    "README.md",
    ...fsSync.readdirSync(path.join(repoRoot, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`),
  ];
}

export function documentedImportFailures() {
  const manifest = JSON.parse(readRepoFile("test/public-api.json")).packageSubpaths;
  const failures = [];

  for (const relativePath of markdownFiles()) {
    const markdown = readRepoFile(relativePath);
    for (const block of markdown.matchAll(/```(?:ts|typescript)\n(?<code>[\s\S]*?)```/gu)) {
      const line = markdown.slice(0, block.index).split("\n").length;
      for (const statement of block.groups.code.matchAll(
        /import\s+(?:type\s+)?\{(?<names>[^}]+)\}\s+from\s+["']@openclaw\/fs-safe(?<subpath>\/[^"']+)?["']/gu,
      )) {
        const subpath = statement.groups.subpath ? `.${statement.groups.subpath}` : ".";
        const entry = manifest[subpath];
        if (!entry) {
          failures.push(`${relativePath}:${line}: unknown package subpath ${subpath}`);
          continue;
        }
        const exported = new Set([...(entry.runtime ?? []), ...(entry.types ?? [])]);
        const imported = statement.groups.names
          .replace(/\/\/[^\n]*/gu, "")
          .split(",")
          .map((name) => name.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0])
          .filter(Boolean);
        for (const name of imported) {
          if (!exported.has(name)) {
            failures.push(`${relativePath}:${line}: ${name} is not exported from ${subpath}`);
          }
        }
      }
    }
  }
  return failures;
}
