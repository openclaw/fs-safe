import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { root } from "../src/root.js";

describe.skipIf(process.platform !== "win32")("Windows Root.entries path admission", () => {
  it("rejects raw stream and index aliases before directory enumeration", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-entries-ads-"));
    try {
      await fs.mkdir(path.join(rootDir, "child"));
      const scoped = await root(rootDir);
      const opendir = vi.spyOn(fs, "opendir");
      for (const relativePath of ["child:stream", "child::$INDEX_ALLOCATION"]) {
        const pending = Promise.resolve().then(async () =>
          await scoped.entries(relativePath).next());
        await expect(pending).rejects.toMatchObject({
          code: "invalid-path",
          details: { reason: "windows-path-alias" },
        });
      }
      expect(opendir).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects a canonical stream alias before directory enumeration", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-entries-canonical-"));
    const directory = path.join(rootDir, "child");
    try {
      await fs.mkdir(directory);
      const scoped = await root(rootDir);
      const nativeRealpath = realpathSync.native.bind(realpathSync);
      const canonicalDirectory = nativeRealpath(directory);
      const canonicalize = vi.spyOn(realpathSync, "native")
        .mockImplementation((candidate) => {
          const canonical = nativeRealpath(candidate);
          return canonical.toLowerCase() === canonicalDirectory.toLowerCase()
            ? `${canonical}:stream`
            : canonical;
        });
      const opendir = vi.spyOn(fs, "opendir");

      await expect(scoped.entries("child").next()).rejects.toMatchObject({
        code: "invalid-path",
        details: { reason: "windows-path-alias" },
      });
      expect(canonicalize.mock.calls.some(([candidate]) =>
        nativeRealpath(candidate).toLowerCase() === canonicalDirectory.toLowerCase())).toBe(true);
      expect(opendir).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
