import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FsSafeError, categorizeFsSafeError, type FsSafeErrorCode } from "../src/errors.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function publicFsSafeErrorCodes(): FsSafeErrorCode[] {
  const manifest = JSON.parse(readRepoFile("test/public-api.json")) as {
    packageSubpaths: {
      ".": { errorCodes: { FsSafeErrorCode: FsSafeErrorCode[] } };
    };
  };
  return manifest.packageSubpaths["."].errorCodes.FsSafeErrorCode;
}

type PublicApiEntry = { runtime?: string[]; types?: string[] };

function publicPackageSubpaths(): Record<string, PublicApiEntry> {
  const manifest = JSON.parse(readRepoFile("test/public-api.json")) as {
    packageSubpaths: Record<string, PublicApiEntry>;
  };
  return manifest.packageSubpaths;
}

function markdownFiles(): string[] {
  return [
    "README.md",
    ...fs.readdirSync(path.join(repoRoot, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`),
  ];
}

function documentedFsSafeErrorCodes(): string[] {
  const errorsDoc = readRepoFile("docs/errors.md");
  const union = errorsDoc.match(/type FsSafeErrorCode =(?<body>[\s\S]*?)\n```/u)?.groups?.body;
  if (!union) {
    throw new Error("docs/errors.md does not contain the FsSafeErrorCode union");
  }
  return [...union.matchAll(/\| "(?<code>[^"]+)"/gu)]
    .map((match) => match.groups!.code)
    .toSorted();
}

describe("documentation contract", () => {
  it("names every exported runtime value and type in the documentation set", () => {
    const docs = markdownFiles().map(readRepoFile).join("\n");
    const undocumented = new Set<string>();

    for (const entry of Object.values(publicPackageSubpaths())) {
      for (const name of [...(entry.runtime ?? []), ...(entry.types ?? [])]) {
        if (!docs.includes(name)) {
          undocumented.add(name);
        }
      }
    }

    expect([...undocumented].toSorted()).toEqual([]);
  });

  it("only imports names that the documented package subpath exports", () => {
    const packageSubpaths = publicPackageSubpaths();
    const failures: string[] = [];

    for (const relativePath of markdownFiles()) {
      const markdown = readRepoFile(relativePath);
      for (const block of markdown.matchAll(/```(?:ts|typescript)\n(?<code>[\s\S]*?)```/gu)) {
        const line = markdown.slice(0, block.index).split("\n").length;
        for (const statement of block.groups!.code.matchAll(
          /import\s+(?:type\s+)?\{(?<names>[^}]+)\}\s+from\s+["']@openclaw\/fs-safe(?<subpath>\/[^"']+)?["']/gu,
        )) {
          const subpath = statement.groups!.subpath
            ? `.${statement.groups!.subpath}`
            : ".";
          const entry = packageSubpaths[subpath];
          if (!entry) {
            failures.push(`${relativePath}:${line}: unknown package subpath ${subpath}`);
            continue;
          }
          const exported = new Set([...(entry.runtime ?? []), ...(entry.types ?? [])]);
          const imported = statement.groups!.names
            .replace(/\/\/[^\n]*/gu, "")
            .split(",")
            .map((name) => name.trim())
            .map((name) => name.replace(/^type\s+/u, "").split(/\s+as\s+/u)[0])
            .filter(Boolean);
          for (const name of imported) {
            if (!exported.has(name)) {
              failures.push(`${relativePath}:${line}: ${name} is not exported from ${subpath}`);
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("documents every public FsSafeError code in the reference union", () => {
    expect(documentedFsSafeErrorCodes()).toEqual(publicFsSafeErrorCodes().toSorted());
  });

  it("documents every public archive error-code string", () => {
    const manifest = JSON.parse(readRepoFile("test/public-api.json")) as {
      packageSubpaths: {
        "./archive": { errorCodes: Record<string, string[]> };
      };
    };
    const archiveDoc = readRepoFile("docs/archive.md");
    for (const [typeName, codes] of Object.entries(
      manifest.packageSubpaths["./archive"].errorCodes,
    )) {
      for (const code of codes) {
        expect(archiveDoc, `${typeName}.${code}`).toContain(code);
      }
    }
  });

  it("keeps the shared type examples aligned with the observed Root result", () => {
    const typesDoc = readRepoFile("docs/types.md");
    const pathStat = typesDoc.match(/type PathStat = \{(?<body>[\s\S]*?)\n\};/u)?.groups?.body;
    const basePath = typesDoc.match(/type BasePathOptions = \{(?<body>[\s\S]*?)\n\};/u)?.groups?.body;

    expect(pathStat).toContain("isFile: boolean");
    expect(pathStat).toContain("isDirectory: boolean");
    expect(pathStat).toContain("dev: number");
    expect(pathStat).not.toContain("kind:");
    expect(basePath).toContain("rootDir: string");
    expect(basePath).toContain("relativePath: string");
    expect(basePath).not.toContain("fastPathMode");
  });

  it("shows the actual options-object local-roots API", () => {
    const localRootsDoc = readRepoFile("docs/local-roots.md");
    expect(localRootsDoc).toContain("resolveLocalPathFromRootsSync({");
    expect(localRootsDoc).toContain("readLocalFileFromRoots({");
    expect(localRootsDoc).toContain("filePath:");
    expect(localRootsDoc).toContain("r.path");
    expect(localRootsDoc).toContain("r.root");
    expect(localRootsDoc).not.toContain("r.absolutePath");
    expect(localRootsDoc).not.toContain("r.rootDir");
    expect(localRootsDoc).not.toContain("r.relativePath");
  });

  it("keeps exact return-value examples synchronized with runtime behavior", () => {
    const installPathDoc = readRepoFile("docs/install-path.md");
    expect(installPathDoc).toContain('"plugin-v1-d9ef8af2eb"');
    expect(installPathDoc).toContain('"plugin-v1-bed33f465b"');
    expect(installPathDoc).toContain('"ber-e392bba2b3"');
    expect(installPathDoc).toContain('"skill-e3b0c44298"');
    expect(installPathDoc).toContain('"skill-cdb4ee2aea"');

    const archiveDoc = readRepoFile("docs/archive.md");
    expect(archiveDoc).toContain('resolveArchiveKind("upload.bin"); // null');
    expect(archiveDoc).not.toContain("Returns `undefined` for unknown extensions");
  });

  it("keeps every public error category aligned with observed FsSafeError behavior", () => {
    const operational = new Set<FsSafeErrorCode>([
      "helper-failed",
      "helper-unavailable",
      "not-empty",
      "not-found",
      "not-removable",
      "permission-unverified",
      "read-failed",
      "timeout",
      "unsupported-platform",
    ]);

    for (const code of publicFsSafeErrorCodes()) {
      const expected = operational.has(code) ? "operational" : "policy";
      expect(categorizeFsSafeError(code), code).toBe(expected);
      expect(new FsSafeError(code, code).category, code).toBe(expected);
    }
  });

  it("does not claim a current producer for the reserved unsupported-platform code", () => {
    expect(readRepoFile("docs/errors.md")).toContain(
      "No current public helper emits this `FsSafeError` code",
    );
  });
});
