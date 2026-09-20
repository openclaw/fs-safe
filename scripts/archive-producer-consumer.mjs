import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

function inside(base, file, message) {
  const resolved = realpathSync.native(file);
  const relative = path.relative(base, resolved);
  assert.ok(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), message);
  return resolved;
}

export function resolveArchiveProducerConsumer(directory) {
  const consumer = realpathSync.native(directory);
  const workspace = realpathSync.native(fileURLToPath(new URL("..", import.meta.url)));
  assert.notEqual(consumer, workspace, "archive producer smoke requires a separate installed consumer");
  const require = createRequire(path.join(consumer, "package.json"));
  const manifest = inside(path.join(consumer, "node_modules"),
    require.resolve("@openclaw/fs-safe/package.json"),
    "archive producer package must resolve inside the consumer's node_modules");
  const packageDir = path.dirname(manifest);
  const entry = (specifier) => inside(packageDir, require.resolve(specifier),
    "archive producer entry must resolve inside the installed package");
  // Admit all entries before any package code runs or archive fixtures are created.
  return { manifest, packageDir,
    configEntry: entry("@openclaw/fs-safe/config"),
    archiveEntry: entry("@openclaw/fs-safe/archive") };
}
