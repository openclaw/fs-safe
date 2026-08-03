import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { itPosix } from "./helpers/vitest.js";
import { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import {
  ensureDirectoryWithinRoot,
  pathScope,
  resolveExistingPathsWithinRoot,
  resolvePathWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
} from "../src/root-paths.js";

async function withFixtureRoot<T>(
  run: (ctx: { baseDir: string; uploadsDir: string }) => Promise<T>,
): Promise<T> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-root-paths-"));
  const uploadsDir = path.join(baseDir, "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  try {
    return await run({ baseDir, uploadsDir });
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}

function expectInvalidResult(result: { ok: true; paths: string[] } | { ok: false; error: string }) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("uploads directory");
  }
}

describe("root path list helpers", () => {
  it("creates a root-scoped helper with shorter method names", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const uploads = pathScope(uploadsDir, { label: "uploads directory" });
      const filePath = path.join(uploadsDir, "ok.txt");
      await fs.writeFile(filePath, "ok", "utf8");

      await expect(uploads.files(["ok.txt"])).resolves.toEqual({
        ok: true,
        paths: [await fs.realpath(filePath)],
      });
      await expect(uploads.writable(" ", { defaultName: "fallback.txt" })).resolves.toEqual({
        ok: true,
        path: path.join(uploadsDir, "fallback.txt"),
      });
    });
  });

  it("accepts existing files under the root", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const filePath = path.join(uploadsDir, "ok.txt");
      await fs.writeFile(filePath, "ok", "utf8");

      const result = await resolveExistingPathsWithinRoot({
        rootDir: uploadsDir,
        requestedPaths: [filePath],
        scopeLabel: "uploads directory",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(filePath)]);
      }
    });
  });

  it("keeps lexical in-root paths when missing fallbacks are allowed", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveExistingPathsWithinRoot({
        rootDir: uploadsDir,
        requestedPaths: ["missing.txt"],
        scopeLabel: "uploads directory",
      });

      expect(result).toEqual({ ok: true, paths: [path.join(uploadsDir, "missing.txt")] });
    });
  });

  it("rejects missing files in strict mode", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveStrictExistingPathsWithinRoot({
        rootDir: uploadsDir,
        requestedPaths: ["missing.txt"],
        scopeLabel: "uploads directory",
      });

      expectInvalidResult(result);
    });
  });

  itPosix("rejects symlink escapes", async () => {
    await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
      const outsideDir = path.join(baseDir, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret", "utf8");
      await fs.symlink(outsideDir, path.join(uploadsDir, "alias"));

      const result = await resolveExistingPathsWithinRoot({
        rootDir: uploadsDir,
        requestedPaths: ["alias/secret.txt"],
        scopeLabel: "uploads directory",
      });

      expect(result).toEqual({ ok: false, error: "File is outside uploads directory" });
    });
  });

  it("uses a default file name for blank writable paths", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveWritablePathWithinRoot({
        rootDir: uploadsDir,
        requestedPath: " ",
        scopeLabel: "uploads directory",
        defaultFileName: "fallback.txt",
      });

      expect(result).toEqual({ ok: true, path: path.join(uploadsDir, "fallback.txt") });
    });
  });

  it("rejects escaping default names for blank scoped paths", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      expect(
        resolvePathWithinRoot({
          rootDir: uploadsDir,
          requestedPath: " ",
          scopeLabel: "uploads directory",
          defaultFileName: "../escape.txt",
        }),
      ).toEqual({
        ok: false,
        error: "Invalid path: must stay within uploads directory",
      });

      await expect(
        ensureDirectoryWithinRoot({
          rootDir: uploadsDir,
          requestedPath: " ",
          scopeLabel: "uploads directory",
          defaultDirName: "../escape",
        }),
      ).resolves.toEqual({
        ok: false,
        error: "Invalid path: must stay within uploads directory",
      });
    });
  });

  it("rejects root-level path aliases", () => {
    const result = resolvePathWithinRoot({
      rootDir: "/tmp/uploads",
      requestedPath: ".",
      scopeLabel: "uploads directory",
    });

    expect(result.ok).toBe(false);
  });
});

describe("local roots helpers", () => {
  it("reads a regular file from one configured root", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const filePath = path.join(uploadsDir, "ok.txt");
      await fs.writeFile(filePath, "ok", "utf8");

      const result = await readLocalFileFromRoots({
        filePath,
        roots: [uploadsDir],
        label: "media roots",
      });

      expect(result?.buffer.toString("utf8")).toBe("ok");
      expect(result?.realPath).toBe(await fs.realpath(filePath));
      expect(result?.root).toBe(await fs.realpath(uploadsDir));
    });
  });

  itPosix("rejects symlink escapes while reading", async () => {
    await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
      const outsideDir = path.join(baseDir, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret", "utf8");
      await fs.symlink(outsideDir, path.join(uploadsDir, "alias"));

      const result = await readLocalFileFromRoots({
        filePath: path.join(uploadsDir, "alias", "secret.txt"),
        roots: [uploadsDir],
        label: "media roots",
      });

      expect(result).toBeNull();
    });
  });

  it("resolves existing and missing paths only when canonicalized inside a root", async () => {
    await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
      const filePath = path.join(uploadsDir, "ok.txt");
      const missingPath = path.join(uploadsDir, "new", "later.txt");
      const outsidePath = path.join(baseDir, "outside.txt");
      await fs.writeFile(filePath, "ok", "utf8");
      // Use the sync realpath to compare against resolveLocalPathFromRootsSync.
      // On windows fs.realpathSync and fs.realpath (async) sometimes disagree
      // on 8.3 short-name canonicalization (e.g. "RUNNER~1" vs "runneradmin").
      const uploadsReal = realpathSync(uploadsDir);

      expect(
        resolveLocalPathFromRootsSync({
          filePath,
          roots: [uploadsDir],
          label: "media roots",
          requireFile: true,
        }),
      ).toEqual({ path: realpathSync(filePath), root: uploadsReal });
      expect(
        resolveLocalPathFromRootsSync({
          filePath: missingPath,
          roots: [uploadsDir],
          label: "media roots",
          allowMissing: true,
        })?.path,
      ).toBe(path.join(uploadsReal, "new", "later.txt"));
      expect(
        resolveLocalPathFromRootsSync({
          filePath: outsidePath,
          roots: [uploadsDir],
          label: "media roots",
          allowMissing: true,
        }),
      ).toBeNull();
    });
  });
});
