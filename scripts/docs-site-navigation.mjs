import fs from "node:fs";
import path from "node:path";

export const sections = [
  ["Start", ["index.md", "install.md", "quickstart.md", "security-model.md", "native-helper.md", "native.md", "config.md"]],
  ["Root API", ["root.md", "reading.md", "writing.md", "walk.md", "path-scope.md"]],
  ["Atomic & temp", ["atomic.md", "staged-file.md", "durability.md", "output.md", "json.md", "temp.md", "archive.md"]],
  ["Stores", ["store.md", "json-store.md", "file-store.md", "private-file-store.md"]],
  ["Specialized", ["secret-file.md", "secure-file.md", "permissions.md", "regular-file.md", "sidecar-lock.md", "local-roots.md"]],
  ["Path & filename", ["path.md", "filename.md", "install-path.md"]],
  ["Reference", ["errors.md", "types.md", "public-api.md", "testing.md", "timing.md", "advanced.md", "test-hooks.md", "migrating-to-0.5.md", "contributing.md"]],
];

export const buildExcludes = [];

export function readDocPages(docsDir, excludes = buildExcludes) {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".md") ? [path.relative(docsDir, full).replaceAll(path.sep, "/")] : [];
  });
  return walk(docsDir).sort().filter((rel) => !excludes.some((re) => re.test(rel)));
}

export function assertNavigationCoversDocs(pages, navigation = sections) {
  const discovered = new Set(pages);
  const listed = new Set();
  const problems = [];
  for (const [name, rels] of navigation) {
    for (const rel of rels) {
      if (!discovered.has(rel)) problems.push(`section "${name}" lists ${rel}, which does not exist in docs/ or is excluded`);
      if (listed.has(rel)) problems.push(`docs/${rel} is listed more than once (section "${name}")`);
      listed.add(rel);
    }
  }
  for (const rel of pages) {
    if (!listed.has(rel)) problems.push(`docs/${rel} is not listed in any section, so it would build without navigation`);
  }
  if (problems.length > 0) {
    throw new Error(`docs site navigation is out of sync with docs/:\n${problems.map((line) => `- ${line}`).join("\n")}`);
  }
}
