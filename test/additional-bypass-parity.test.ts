import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeFileURLToPath } from "../src/local-file-access.js";
import { assertCanonicalPathWithinBase, resolveSafeInstallDir } from "../src/install-path.js";
import { createJsonStore } from "../src/json-document-store.js";
import { movePathToTrash } from "../src/trash.js";
import { resolveArchiveOutputPath, validateArchiveEntryPath } from "../src/archive-entry.js";
import { prepareArchiveOutputPath } from "../src/archive-staging.js";
import { sanitizeTempFileName, tempFile } from "../src/temp-target.js";
import { walkDirectory, walkDirectorySync } from "../src/walk.js";

type TempLayout = {
  base: string;
  outside: string;
  outsideFile: string;
};

const tempDirs: string[] = [];

const ARCHIVE_ESCAPE_PAYLOADS = [
  "../evil.txt",
  "../../evil.txt",
  "nested/../../evil.txt",
  "/absolute/evil.txt",
  "//server/share/evil.txt",
  "C:/Windows/win.ini",
  "C:\\Windows\\win.ini",
  "..\\evil.txt",
  "nested\\..\\..\\evil.txt",
] as const;

async function makeTempLayout(prefix: string): Promise<TempLayout> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-base-`));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-outside-`));
  tempDirs.push(base, outside);
  const outsideFile = path.join(outside, "secret.txt");
  await fsp.writeFile(outsideFile, "outside secret");
  return { base, outside, outsideFile };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { force: true, recursive: true })));
});

describe("additional bypass parity", () => {
  it("rejects archive traversal payloads before resolving output paths", async () => {
    const layout = await makeTempLayout("fs-safe-archive-payloads");

    for (const payload of ARCHIVE_ESCAPE_PAYLOADS) {
      expect(() => validateArchiveEntryPath(payload), `validate ${payload}`).toThrow();
      await expect(
        prepareArchiveOutputPath({ destDir: layout.base, relativePath: payload, originalPath: payload }),
      ).rejects.toThrow();
    }
  });

  it("keeps archive output resolution inside the destination for benign weird names", async () => {
    const layout = await makeTempLayout("fs-safe-archive-literals");
    const payloads = ["%2e%2e%2fevil.txt", "..%2fevil.txt", "safe/..hidden/file.txt"];

    for (const payload of payloads) {
      validateArchiveEntryPath(payload);
      const output = resolveArchiveOutputPath({ rootDir: layout.base, relPath: payload, originalPath: payload });
      expect(output.startsWith(`${layout.base}${path.sep}`)).toBe(true);
    }
  });

  it("sanitizes temp file names and keeps temp file helpers inside their created directory", async () => {
    const layout = await makeTempLayout("fs-safe-temp");
    expect(sanitizeTempFileName("../../evil.txt")).toBe("evil.txt");
    expect(sanitizeTempFileName("..\\evil.txt")).toBe("..-evil.txt");
    expect(sanitizeTempFileName("\u0000../evil.txt")).toBe("evil.txt");

    const target = await tempFile({ rootDir: layout.base, prefix: "../../prefix", fileName: "../../evil.txt" });
    tempDirs.push(target.dir);
    expect(target.dir.startsWith(`${layout.base}${path.sep}`)).toBe(true);
    expect(target.path).toBe(path.join(target.dir, "evil.txt"));
    expect(target.file("../../other.txt")).toBe(path.join(target.dir, "other.txt"));
    await target.cleanup();
    await expect(fsp.stat(target.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects remote or encoded-separator file URLs while accepting local file URLs", () => {
    const local = pathToFileURL(path.join(os.tmpdir(), "safe.txt")).toString();
    expect(safeFileURLToPath(local)).toBe(path.join(os.tmpdir(), "safe.txt"));
    expect(() => safeFileURLToPath("https://example.com/secret.txt")).toThrow();
    expect(() => safeFileURLToPath("file://evil.example/secret.txt")).toThrow();
    expect(() => safeFileURLToPath("file:///tmp/%2Fetc/passwd")).toThrow();
    expect(() => safeFileURLToPath("file:///tmp/%5Cevil")).toThrow();
  });

  it("keeps install directories and canonical base checks inside their base", async () => {
    const layout = await makeTempLayout("fs-safe-install");
    const safe = resolveSafeInstallDir({ baseDir: layout.base, id: "../../evil/pkg", invalidNameMessage: "bad package" });
    expect(safe).toMatchObject({ ok: true });
    if (!safe.ok) throw new Error("expected safe install dir");
    expect(safe.path.startsWith(`${layout.base}${path.sep}`)).toBe(true);

    await expect(
      assertCanonicalPathWithinBase({ baseDir: layout.base, candidatePath: layout.outsideFile, boundaryLabel: "install base" }),
    ).rejects.toThrow();
    const insideDir = path.join(layout.base, "inside");
    await fsp.mkdir(insideDir);
    await expect(
      assertCanonicalPathWithinBase({
        baseDir: layout.base,
        boundaryLabel: "install base",
        candidatePath: path.join(insideDir, "future-file.txt"),
      }),
    ).resolves.toBeUndefined();
  });

  it("walks do not follow symlinks by default and do not loop when following cycles", async () => {
    const layout = await makeTempLayout("fs-safe-walk");
    await fsp.mkdir(path.join(layout.base, "dir"));
    await fsp.writeFile(path.join(layout.base, "dir", "inside.txt"), "inside");
    await fsp.symlink(layout.outside, path.join(layout.base, "outside-link"), "dir");
    await fsp.symlink(layout.base, path.join(layout.base, "dir", "cycle"), "dir");

    const skipped = await walkDirectory(layout.base);
    expect(skipped.entries.some((entry) => entry.path.startsWith(layout.outside))).toBe(false);
    expect(skipped.entries.some((entry) => entry.relativePath.includes("outside-link"))).toBe(false);

    const followed = await walkDirectory(layout.base, { symlinks: "follow", maxEntries: 20 });
    expect(followed.entries.length).toBeLessThanOrEqual(20);
    expect(followed.entries.some((entry) => entry.path.startsWith(layout.outside))).toBe(false);

    const syncFollowed = walkDirectorySync(layout.base, { symlinks: "follow", maxEntries: 20 });
    expect(syncFollowed.entries.length).toBeLessThanOrEqual(20);
  });

  it("refuses to trash targets outside explicit allowed roots and does not move them", async () => {
    const layout = await makeTempLayout("fs-safe-trash");
    await expect(movePathToTrash(layout.outsideFile, { allowedRoots: [layout.base] })).rejects.toThrow();
    await expect(fsp.readFile(layout.outsideFile, "utf8")).resolves.toBe("outside secret");
  });

  it("json stores cannot bypass adapter-enforced root checks through lock/update flow", async () => {
    const layout = await makeTempLayout("fs-safe-json-store");
    const filePath = path.join(layout.base, "state.json");
    const adapter = {
      filePath,
      async readIfExists(): Promise<{ ok: boolean } | null> {
        try {
          return JSON.parse(await fsp.readFile(filePath, "utf8")) as { ok: boolean };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      async readRequired(): Promise<{ ok: boolean }> {
        return JSON.parse(await fsp.readFile(filePath, "utf8")) as { ok: boolean };
      },
      async write(value: { ok: boolean }): Promise<void> {
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(`${layout.base}${path.sep}`)) {
          throw new Error("adapter escaped root");
        }
        await fsp.writeFile(filePath, JSON.stringify(value));
      },
    };
    const store = createJsonStore(adapter, { lock: true });
    await expect(store.updateOr({ ok: false }, () => ({ ok: true }))).resolves.toEqual({ ok: true });
    await expect(fsp.readFile(filePath, "utf8")).resolves.toBe('{"ok":true}');
    await expect(fsp.readFile(layout.outsideFile, "utf8")).resolves.toBe("outside secret");
  });
});
