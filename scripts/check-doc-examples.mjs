import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsSafeError, root } from "@openclaw/fs-safe";
import { resolveArchiveKind } from "@openclaw/fs-safe/archive";
import {
  readLocalFileFromRoots,
  resolveLocalPathFromRootsSync,
  safeDirName,
  safePathSegmentHashed,
  sanitizeUntrustedFileName,
} from "@openclaw/fs-safe/advanced";
import { writeJson } from "@openclaw/fs-safe/json";
import {
  isPathInside,
  resolveSafeBaseDir,
} from "@openclaw/fs-safe/path";
import { fileStore } from "@openclaw/fs-safe/store";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(relativePath) {
  return fsSync.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function checkDocumentedImports() {
  const manifest = JSON.parse(readRepoFile("test/public-api.json")).packageSubpaths;
  const markdownFiles = [
    "README.md",
    ...fsSync.readdirSync(path.join(repoRoot, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`),
  ];
  const failures = [];

  for (const relativePath of markdownFiles) {
    const markdown = readRepoFile(relativePath);
    for (const block of markdown.matchAll(/```(?:ts|typescript)\n(?<code>[\s\S]*?)```/gu)) {
      for (const statement of block.groups.code.matchAll(
        /import\s+(?:type\s+)?\{(?<names>[^}]+)\}\s+from\s+["']@openclaw\/fs-safe(?<subpath>\/[^"']+)?["']/gu,
      )) {
        const subpath = statement.groups.subpath ? `.${statement.groups.subpath}` : ".";
        const entry = manifest[subpath];
        if (!entry) {
          failures.push(`${relativePath}: unknown package subpath ${subpath}`);
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
            failures.push(`${relativePath}: ${name} is not exported from ${subpath}`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
}

function runPureExamples() {
  assert.equal(isPathInside("/srv/uploads", "/srv/uploads/photo.jpg"), true);
  assert.equal(isPathInside("/srv/uploads", "/srv/uploads/../escape.txt"), false);
  assert.equal(isPathInside("/srv/uploads", "/srv/uploads-other/x"), false);
  assert.equal(resolveSafeBaseDir("/srv/uploads/."), `${path.resolve("/srv/uploads")}${path.sep}`);

  assert.equal(safeDirName("@scope/my-plugin"), "@scope__my-plugin");
  assert.equal(safePathSegmentHashed("plugin/v1"), "plugin-v1-d9ef8af2eb");
  assert.equal(safePathSegmentHashed("plugin\\v1"), "plugin-v1-bed33f465b");
  assert.equal(safePathSegmentHashed("Über@"), "ber-e392bba2b3");
  assert.equal(safePathSegmentHashed(""), "skill-e3b0c44298");
  assert.equal(safePathSegmentHashed("."), "skill-cdb4ee2aea");

  assert.equal(sanitizeUntrustedFileName("../../etc/passwd", "upload"), "passwd");
  assert.equal(sanitizeUntrustedFileName("CON", "fallback"), "CON_");
  assert.equal(sanitizeUntrustedFileName("nul.txt", "fallback"), "nul_.txt");

  assert.equal(resolveArchiveKind("upload.zip"), "zip");
  assert.equal(resolveArchiveKind("upload.tar.gz"), "tar");
  assert.equal(resolveArchiveKind("upload.bin"), null);
}

async function runFilesystemExamples() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-built-docs-"));
  try {
    const scoped = await root(tempDir);
    await scoped.write("nested/value.txt", "first");
    await scoped.write("nested/value.txt", "second");
    assert.equal(await scoped.readText("nested/value.txt"), "second");
    assert.deepEqual(Object.keys(await scoped.stat("nested/value.txt")).toSorted(), [
      "dev",
      "gid",
      "ino",
      "isDirectory",
      "isFile",
      "isSymbolicLink",
      "mode",
      "mtimeMs",
      "nlink",
      "size",
      "uid",
    ]);

    const localPath = resolveLocalPathFromRootsSync({
      filePath: path.join(tempDir, "nested/value.txt"),
      roots: [tempDir],
      requireFile: true,
    });
    assert.ok(localPath);
    const [resolvedFileStat, sourceFileStat, resolvedRootStat, sourceRootStat] = await Promise.all([
      fs.stat(localPath.path),
      fs.stat(path.join(tempDir, "nested/value.txt")),
      fs.stat(localPath.root),
      fs.stat(tempDir),
    ]);
    assert.deepEqual(
      { dev: resolvedFileStat.dev, ino: resolvedFileStat.ino },
      { dev: sourceFileStat.dev, ino: sourceFileStat.ino },
    );
    assert.deepEqual(
      { dev: resolvedRootStat.dev, ino: resolvedRootStat.ino },
      { dev: sourceRootStat.dev, ino: sourceRootStat.ino },
    );
    const localRead = await readLocalFileFromRoots({
      filePath: path.join(tempDir, "nested/value.txt"),
      roots: [tempDir],
    });
    assert.equal(localRead?.buffer.toString("utf8"), "second");

    await assert.rejects(
      scoped.write("absent/value.txt", "x", { mkdir: false }),
      (error) =>
        error instanceof FsSafeError &&
        error.code === "not-found" &&
        error.category === "operational",
    );

    await scoped.writeJson("root.json", { ok: true });
    assert.equal(await fs.readFile(path.join(tempDir, "root.json"), "utf8"), '{"ok":true}\n');

    const standalonePath = path.join(tempDir, "standalone.json");
    await writeJson(standalonePath, { ok: true });
    assert.equal(await fs.readFile(standalonePath, "utf8"), '{\n  "ok": true\n}');

    const store = fileStore({ rootDir: path.join(tempDir, "store") });
    const storedPath = await store.writeJson("value.json", { ok: true });
    assert.equal(await fs.readFile(storedPath, "utf8"), '{\n  "ok": true\n}\n');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

checkDocumentedImports();
runPureExamples();
await runFilesystemExamples();
console.log("documentation examples match the built package");
